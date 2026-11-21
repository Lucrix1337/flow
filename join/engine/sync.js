// Синхронное воспроизведение: часы, сверенные с сервером, и аудиодвижок на Web Audio.
//
// Идея: сервер присылает якорь anchor — серверное время, когда звучит позиция 0 трека.
// Клиент знает своё смещение часов относительно сервера (серия пингов, берём самые быстрые) и
// момент, когда сэмпл реально выйдет из колонок (AudioContext.getOutputTimestamp — с учётом задержки
// звуковой карты). Старт планируется с точностью до сэмпла, а дальше 4 раза в секунду сверяем
// «что звучит сейчас» с «что должно звучать»: мелкий уход подтягиваем скоростью (±0.4%, на слух
// незаметно), крупный — мгновенной перестановкой.

import { createEqualizer } from "./equalizer.js";
import { measureBuffer, normalizationGain } from "./loudness.js";

const HARD_RESYNC = 0.06;  // с: больше — переставляем воспроизведение
const SOFT_ZONE = 0.004;   // с: меньше — считаем, что идеально
const MAX_RATE_DELTA = 0.004;
// на паузе: через 15 с усыпляем звуковой поток (иначе он просыпается ~100 раз в секунду, даже когда тихо),
// через 5 мин выгружаем распакованный трек (~90 МБ на 4 минуты) — при старте он заново прочитается с диска
const IDLE_SUSPEND_MS = 15000;
const IDLE_DROP_MS = 5 * 60000;
const LOAD_TIMEOUT_MS = 75000;  // трек не загрузился за 75 с — ошибка (следующий включится), а не вечная «загрузка»
const MEASURE_WAIT_MS = 1500;  // столько ждём замер громкости перед стартом; не успел — громкость подтянется плавно
const LOUDNESS_KEEP = 500;     // замеры храним для стольких треков (это пара чисел на трек)

export class Clock {
  constructor(send) {
    this.send = send;
    this.samples = [];     // {rtt, offset}
    this.offset = null;    // мс: server − client(perf-эпоха)
    this.rtt = null;
    this.timer = null;
    this.busy = () => true;  // в общей комнате — часто; одному часы почти не нужны, пингуем редко
  }

  perfEpoch(p = performance.now()) {
    return performance.timeOrigin + p;
  }

  start() {
    this.stop();
    let n = 0;
    const burst = () => {
      this.send({ t: "ping", c: this.perfEpoch() });
      n += 1;
      // первые 12 пингов часто, потом раз в 5 секунд в общей комнате и раз в 30 — одному
      this.timer = setTimeout(burst, n < 12 ? 150 : this.busy() ? 5000 : 30000);
    };
    burst();
  }

  stop() {
    clearTimeout(this.timer);
  }

  onPong(m) {
    const t1 = this.perfEpoch();
    const rtt = t1 - m.c;
    if (rtt < 0 || rtt > 5000) return;
    this.samples.push({ rtt, offset: m.s - (m.c + t1) / 2 });
    if (this.samples.length > 16) this.samples.shift();
    // смещение по 3 самым быстрым ответам: у них меньше всего искажений от очередей в сети
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
    const target = best.reduce((s, x) => s + x.offset, 0) / best.length;
    this.rtt = best[0].rtt;
    if (this.offset === null || Math.abs(target - this.offset) > 25) this.offset = target;
    else this.offset += (target - this.offset) * 0.3;  // плавно, без скачков
  }

  ready() {
    return this.offset !== null && this.samples.length >= 3;
  }

  // серверное время для момента performance.now() = p
  server(p = performance.now()) {
    return this.perfEpoch(p) + (this.offset || 0);
  }

  // обратное: момент performance.now(), когда на сервере будет время s
  perfFor(s) {
    return s - (this.offset || 0) - performance.timeOrigin;
  }
}

export class Player {
  constructor(clock, loadBuffer) {
    this.clock = clock;
    this.loadBuffer = loadBuffer;          // (track) → Promise<ArrayBuffer>
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    this.gain = this.ctx.createGain();
    this.equalizer = createEqualizer(this.ctx, this.ctx.destination);
    this.gain.connect(this.equalizer.input);
    this.buffers = new Map();              // key → Promise<AudioBuffer>
    this.channel = null; this.exit = null; this.norm = null; this.normKey = null; this.planned = null; this.tail = null;
    this.normalize = true;                 // выравнивание громкости (настройка «Аудио»)
    this.loudness = new Map();             // key → { lufs, peak }
    this.planSeq = 0; this.nextSig = ""; this.nextTarget = null; this.nextFailed = null;
    this.src = null;
    this.seg = null;                       // {key, ctxStart, offset, rate}
    this.target = null;                    // {track, anchor, paused, pausedAt}
    this.latencyMs = 0;                    // ручная поправка (Bluetooth и т.п.): + значит «у меня звук опаздывает»
    this.errorMs = null;                   // текущее расхождение для индикатора
    this.onStatus = () => {};
    this.idleTimers = [];
    setInterval(() => this.tick(), 250);
  }

  setVolume(v) {
    this.gain.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.05);  // квадрат — громкость на слух ровнее
  }

  buffer(track) {
    if (!this.buffers.has(track.key)) {
      const decode = (ab) => this.ctx.decodeAudioData(ab);
      // зависшая загрузка не должна держать трек вечно: по таймауту — ошибка, и запись убирается (следующая попытка качает заново)
      const load = (fresh) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("трек не загрузился — проверь интернет")), LOAD_TIMEOUT_MS);
        Promise.resolve(this.loadBuffer(track, fresh)).then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
      });
      // не декодировалось — возможно, на диске битый файл из кэша: один раз качаем заново из источника
      const p = load().then(decode)
        .catch((e) => (e && e.name === "EncodingError" ? load(true).then(decode) : Promise.reject(e)))
        .then((buf) => this.measure(track.key, buf).then(() => buf));
      p.catch(() => this.buffers.delete(track.key));
      this.buffers.set(track.key, p);
    }
    return this.buffers.get(track.key);
  }

  // громкость трека меряем один раз; замер не держит старт дольше MEASURE_WAIT_MS
  measure(key, buf) {
    if (this.loudness.has(key)) return Promise.resolve();
    const done = measureBuffer(buf).catch(() => ({ lufs: -Infinity, peak: 0 })).then((r) => {
      this.loudness.set(key, r);
      if (this.loudness.size > LOUDNESS_KEEP) this.loudness.delete(this.loudness.keys().next().value);
      this.applyNorm(key);
    });
    return Promise.race([done, new Promise((r) => setTimeout(r, MEASURE_WAIT_MS))]);
  }

  normGain(key) {
    const info = this.normalize && this.loudness.get(key);
    return info ? normalizationGain(info.lufs, info.peak) : 1;
  }

  // поменять громкость у играющих треков: всех (настройку переключили) или одного (пришёл его замер)
  applyNorm(key) {
    const now = this.ctx.currentTime;
    for (const deck of [this.currentDeck(), this.tail, this.planned]) {
      if (deck?.norm && (!key || deck.key === key)) deck.norm.gain.setTargetAtTime(this.normGain(deck.key), now, 0.15);
    }
  }

  setNormalize(on) {
    this.normalize = !!on;
    this.applyNorm();
  }

  // доступ к трекам поменялся (подключили Яндекс): следующий set заново грузит текущий трек, даже если он тот же
  reload() {
    this.sig = null;
  }

  // команда Flow попросила пересинхронизироваться: играющий трек заново ставим на позицию комнаты
  resync() {
    if (!this.src || !this.target || this.target.paused) return false;
    this.startAt(this.src.buffer);
    return true;
  }

  // держим в памяти только нужное (декодированный трек — ~90 МБ на 4 минуты: 48 кГц, стерео, float32)
  keepOnly(keys) {
    for (const k of [...this.buffers.keys()]) if (!keys.includes(k)) this.buffers.delete(k);
  }

  // соответствие «время контекста» ↔ «когда это прозвучит» (performance.now)
  outputMap() {
    const ts = this.ctx.getOutputTimestamp ? this.ctx.getOutputTimestamp() : null;
    if (ts && ts.performanceTime) return ts;
    // запасной вариант: оценка по задержке вывода
    const lat = (this.ctx.outputLatency || this.ctx.baseLatency || 0);
    return { contextTime: this.ctx.currentTime - lat, performanceTime: performance.now() };
  }

  perfAtCtx(ct, map = this.outputMap()) {
    return map.performanceTime + (ct - map.contextTime) * 1000;
  }

  ctxAtPerf(p, map = this.outputMap()) {
    return map.contextTime + (p - map.performanceTime) / 1000;
  }

  // позиция трека (с), которая должна звучать в момент performance.now() = p
  expected(p) {
    const t = this.target;
    if (!t || t.paused) return t ? t.pausedAt / 1000 : 0;
    return (this.clock.server(p) + this.latencyMs - t.anchor) / 1000;
  }

  async set(target) {
    const sig = target?.track ? `${target.qid}|${target.track.key}|${target.anchor}|${target.paused}|${target.pausedAt}` : '';
    if (sig === this.sig) {
      if (this.target) { this.target.next = target?.next; this.target.outgoing = target?.outgoing; }
      this.planNext(target?.next); return;
    }
    const previous = this.target, planned = this.planned;
    const promote = !target?.paused && planned?.src && planned.target.qid === target?.qid
      && planned.target.track.key === target?.track.key && planned.target.anchor === target?.anchor;
    this.sig = sig; this.target = target;
    if (!target?.track || target.paused) { this.stop(); return this.idleSoon(); }
    this.cancelIdle();
    if (promote) {
      this.stopDeck(this.tail);
      this.tail = { ...this.currentDeck(), end: target.anchor + planned.target.fadeMs };
      this.planned = null; this.planSeq++; this.nextSig = ''; this.nextTarget = null;
      this.useDeck(planned); this.onStatus('ready', target); this.planNext(target.next); return;
    }
    const keepTail = this.src && target.outgoing && previous?.qid === target.outgoing.qid
      && previous.anchor === target.outgoing.trackAnchor && this.clock.server() < target.outgoing.anchor + target.outgoing.fadeMs;
    if (keepTail) {
      this.cancelPlanned(); this.stopDeck(this.tail);
      this.tail = { ...this.currentDeck(), end: target.outgoing.anchor + target.outgoing.fadeMs };
      this.useDeck(null); this.nextSig = ''; this.nextTarget = null;
    } else this.stop();
    let buffer;
    try { this.onStatus('loading', target); buffer = await this.buffer(target.track); }
    catch (error) { if (this.target === target) this.onStatus('error', target, error); return; }
    if (this.target !== target) return;
    await this.wake(); if (this.target !== target) return;
    this.onStatus('ready', target); this.startAt(buffer);
  }

  stop() {
    this.cancelPlanned(); this.nextSig = ''; this.nextTarget = null; this.nextFailed = null;
    this.stopDeck(this.currentDeck()); this.stopDeck(this.tail); this.tail = null;
    this.useDeck(null); this.errorMs = null;
  }

  stopDeck(deck) {
    if (!deck?.src) return;
    deck.src.onended = null;
    try { deck.src.stop(); } catch { /* already ended */ }
    deck.src.disconnect(); deck.norm?.disconnect(); deck.gain.disconnect(); deck.exit.disconnect();
  }

  currentDeck() { return this.src ? { src: this.src, norm: this.norm, key: this.normKey, gain: this.channel, exit: this.exit, seg: this.seg } : null; }

  cancelPlanned() {
    this.planSeq++;
    this.stopDeck(this.planned); this.planned = null;
    if (this.exit) { this.exit.gain.cancelScheduledValues(this.ctx.currentTime); this.exit.gain.setValueAtTime(1, this.ctx.currentTime); }
  }

  fade(param, from, to, start, end) {
    const now = this.ctx.currentTime, at = Math.max(now, start);
    const progress = Math.max(0, Math.min(1, (at - start) / Math.max(.001, end - start)));
    param.cancelScheduledValues(now);
    param.setValueAtTime(from + (to - from) * progress, at);
    if (end > at) param.linearRampToValueAtTime(to, end);
  }

  makeDeck(buf, target, initial = 1) {
    const map = this.outputMap();
    const origin = this.ctxAtPerf(this.clock.perfFor(target.anchor - this.latencyMs), map);
    const when = Math.max(origin, this.ctx.currentTime + .05), offset = Math.max(0, (when - origin));
    if (offset >= buf.duration) return null;
    // трек → выравнивание громкости → плавный переход → выход
    const src = this.ctx.createBufferSource(), norm = this.ctx.createGain(), gain = this.ctx.createGain(), exit = this.ctx.createGain();
    const key = target.track.key;
    src.buffer = buf; gain.gain.setValueAtTime(initial, this.ctx.currentTime);
    norm.gain.setValueAtTime(this.normGain(key), this.ctx.currentTime);
    src.connect(norm); norm.connect(gain); gain.connect(exit); exit.connect(this.gain);
    const deck = { src, norm, key, gain, exit, seg: { ctxStart: when, offset, rate: 1 }, target, origin };
    src.onended = () => {
      if (this.src === src) { this.src = null; this.seg = null; this.channel = null; this.exit = null; this.norm = null; this.normKey = null; }
      if (this.tail?.src === src) this.tail = null;
      if (this.planned?.src === src) this.planned = null;
      src.disconnect(); norm.disconnect(); gain.disconnect(); exit.disconnect();
    };
    src.start(when, offset);
    return deck;
  }

  useDeck(deck) {
    this.src = deck?.src || null; this.seg = deck?.seg || null;
    this.channel = deck?.gain || null; this.exit = deck?.exit || null;
    this.norm = deck?.norm || null; this.normKey = deck?.key || null;
  }

  async planNext(plan) {
    const signature = plan ? `${plan.qid}|${plan.track.key}|${plan.anchor}|${plan.fadeMs}` : '';
    if (signature !== this.nextSig) {
      this.cancelPlanned(); this.nextSig = signature; this.nextTarget = plan; this.nextFailed = null;
    }
    if (!plan || this.nextFailed === signature || !this.src || this.target?.paused || this.planned || plan.anchor - this.clock.server() > 25000) return;
    if (this.clock.server() >= plan.anchor + plan.fadeMs) return;
    const request = ++this.planSeq, target = this.target;
    const pending = { target: plan, signature }; this.planned = pending;
    try {
      const buffer = await this.buffer(plan.track);
      if (request !== this.planSeq || this.target !== target || this.planned !== pending || !this.src) return;
      const deck = this.makeDeck(buffer, plan, 0);
      if (!deck) { this.planned = null; return; }
      deck.signature = signature; this.planned = deck;
      const start = deck.origin, end = start + plan.fadeMs / 1000;
      this.fade(deck.gain.gain, 0, 1, start, end);
      this.fade(this.exit.gain, 1, 0, start, end);
    } catch { if (this.planned === pending) { this.planned = null; this.nextFailed = signature; } }
  }

  // пауза или нечего играть: сначала усыпляем звук, потом освобождаем память
  idleSoon() {
    this.cancelIdle();
    const idle = () => !this.src && (!this.target || this.target.paused);
    this.idleTimers = [
      setTimeout(() => { if (idle() && this.ctx.state === "running") this.ctx.suspend().catch(() => {}); }, IDLE_SUSPEND_MS),
      setTimeout(() => { if (idle()) this.buffers.clear(); }, IDLE_DROP_MS),
    ];
  }

  cancelIdle() {
    this.idleTimers.forEach(clearTimeout);
    this.idleTimers = [];
  }

  // разбудить звук перед стартом. Сразу после resume метка вывода бывает старой — ждём, пока время контекста пойдёт
  async wake() {
    this.cancelIdle();
    if (this.ctx.state === "running") return;
    const t0 = this.ctx.currentTime;
    await this.ctx.resume().catch(() => {});
    for (let i = 0; i < 15 && this.ctx.currentTime === t0; i++) await new Promise((r) => setTimeout(r, 20));
  }

  startAt(buf) {
    this.cancelPlanned(); this.stopDeck(this.currentDeck()); this.useDeck(null);
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const deck = this.makeDeck(buf, this.target);
    this.useDeck(deck);
    if (deck && this.target.outgoing) {
      const outgoing = this.target.outgoing;
      const start = this.ctxAtPerf(this.clock.perfFor(outgoing.anchor - this.latencyMs));
      const end = start + outgoing.fadeMs / 1000;
      this.fade(deck.gain.gain, 0, 1, start, end);
      if (this.tail) this.fade(this.tail.exit.gain, 1, 0, start, end);
      else this.restoreTail(this.target);
    }
    this.planNext(this.target.next);
  }

  // A listener joining during the overlap needs the remaining outgoing audio too.
  // Its download must not delay the current track or revive an old room after leaving.
  async restoreTail(target) {
    const outgoing = target.outgoing, end = outgoing.anchor + outgoing.fadeMs;
    if (this.clock.server() >= end) return;
    try {
      const buffer = await this.buffer(outgoing.track);
      if (this.target !== target || !this.src || this.tail || target.outgoing?.anchor !== outgoing.anchor || this.clock.server() >= end) return;
      const deck = this.makeDeck(buffer, { qid: outgoing.qid, track: outgoing.track, anchor: outgoing.trackAnchor });
      if (!deck) return;
      const start = this.ctxAtPerf(this.clock.perfFor(outgoing.anchor - this.latencyMs));
      this.fade(deck.exit.gain, 1, 0, start, start + outgoing.fadeMs / 1000);
      this.tail = { ...deck, end };
    } catch { /* Current track keeps playing when the tail is unavailable. */ }
  }

  // позиция, которая звучит в момент контекста ct
  actualAt(ct) {
    const s = this.seg;
    return s.offset + Math.max(0, ct - s.ctxStart) * s.rate;
  }

  tick() {
    if (this.tail && this.clock.server() >= this.tail.end + 100) { this.stopDeck(this.tail); this.tail = null; }
    if (this.nextTarget && this.nextFailed !== this.nextSig) this.planNext(this.nextTarget);
    if (!this.src || !this.seg || !this.target || this.target.paused) return;
    const map = this.outputMap();
    if (map.contextTime < this.seg.ctxStart) return;  // ещё не начали звучать
    const actual = this.actualAt(map.contextTime);
    const err = actual - this.expected(map.performanceTime);   // + значит «мы впереди»
    this.errorMs = err * 1000;
    if (Math.abs(err) > HARD_RESYNC) {
      this.startAt(this.src.buffer);
      return;
    }
    const rate = Math.abs(err) < SOFT_ZONE ? 1 : 1 - Math.max(-MAX_RATE_DELTA, Math.min(MAX_RATE_DELTA, err / 3));
    if (Math.abs(rate - this.seg.rate) > 1e-5) {
      const now = this.ctx.currentTime;
      this.seg = { ctxStart: now, offset: this.actualAt(now), rate };
      this.src.playbackRate.setValueAtTime(rate, now);
    }
  }

  // позиция для интерфейса (мс)
  positionMs() {
    const t = this.target;
    if (!t || !t.track) return 0;
    if (t.paused) return t.pausedAt;
    return Math.max(0, Math.min(t.track.durationMs, this.clock.server() - t.anchor));
  }
}
