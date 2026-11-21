// Логика страницы «Слушать в браузере» без DOM: разбор ссылки, какую версию трека играть,
// загрузка звука по источникам, подписи и время. Всё проверяется тестами в Node (tests/join-listen.test.mjs).

export const CODE_RE = /^[A-Z0-9]{6}$/;
export const TOKEN_KEY = "flow.web.token";
export const VOLUME_KEY = "flow.web.volume";
export const MUTED_KEY = "flow.web.muted";
export const GUEST_NAME_KEY = "flow.web.guestName";  // последний ник гостя — подставляем в поле в следующий раз
export const CHAT_KEEP = 100;
export const CHAT_MAX = 500;
// трек не играет только у тебя: сервер пропускает его, лишь когда он не играет ни у кого, — поэтому не обещаем, что «следующий включится сам»
export const SILENCE_NOTE = "Пока он не закончится или его не пропустят, у тебя будет тишина.";
export const YM_ONLY_TEXT = "Этот трек есть только в Яндекс Музыке, в браузере он не играет. У остальных он может играть дальше — у тебя будет тишина, пока он не закончится или его не пропустят. В приложении Flow с подпиской Плюс он играет.";
export const LONG_TRACK_MS = 20 * 60000;
export const LONG_TRACK_TEXT = "Трек длиннее 20 минут — на этом устройстве браузеру не хватит на него памяти. Его можно послушать в приложении Flow на компьютере.";
export const SOURCE_NAME = { sc: "SoundCloud", audius: "Audius", jamendo: "Jamendo" };
// замена трека из Яндекса: та же песня с другого сервиса. Без «играет» — в «Дальше» трек ещё не начался, а комната может стоять на паузе
export const altNote = (track, upcoming = false) => `${upcoming ? "будет " : ""}другая версия этого трека (${SOURCE_NAME[track?.source] || "другой сервис"})`;
export const ALT_TITLE = "Оригинал этого трека есть только в Яндекс Музыке, поэтому в браузере берётся его версия с другого сервиса.";
export const YM_ONLY_TAG = "только в Яндекс Музыке, в браузере не играет";
export const CTL_NOTE = "Ставить на паузу, включать и переключать треки может владелец комнаты и те, кому он разрешил. Ползунок громкости меняет звук только у тебя.";
export const REACTIONS = [
  { key: "heart", label: "Сердце" },
  { key: "like", label: "Класс" },
  { key: "fire", label: "Огонь" },
];

// код комнаты: /join?КОД, /join/?КОД, /join#КОД, /join/КОД, а также ?r=КОД, ?code=КОД, ?room=КОД
export function pickCode(loc) {
  const search = String(loc?.search || ""), hash = String(loc?.hash || ""), pathname = String(loc?.pathname || "");
  const parts = search.replace(/^\?/, "").split("&").concat(hash.replace(/^#/, ""));
  const m = /\/join\/([^/]+)\/?$/.exec(pathname);
  if (m) parts.push(m[1]);
  for (let v of parts) {
    try { v = decodeURIComponent(v); } catch { /* битый %-код — берём как есть */ }
    v = v.replace(/^(r|code|room)=/i, "").trim().toUpperCase();
    if (CODE_RE.test(v)) return v;
  }
  return "";
}

// ---------- какую версию трека играть ----------

const playableSource = (t) => !!t && typeof t === "object" && !!t.source && t.source !== "ym";

// трек из Яндекса, который участник с Плюсом залил на сервер комнаты: его ключ есть в room.relay.
// Тогда браузер берёт файл с сервера Flow — в трек кладём код комнаты, загрузчик по нему знает, откуда качать
function relayed(t, room) {
  if (!t || typeof t !== "object" || t.source !== "ym" || !t.key) return null;
  if (!room || !Array.isArray(room.relay) || !room.relay.includes(t.key) || !CODE_RE.test(String(room.code || ""))) return null;
  return { ...t, relay: room.code };
}

// элемент очереди {track, ym?, alt?} → {track, alt} или null (только Яндекс и его нет на сервере комнаты — в браузере не играет).
// room — снимок комнаты: по room.relay видно, какие треки Яндекса можно взять с сервера
export function playableTrack(item, room = null) {
  if (!item || !item.track) return null;
  if (playableSource(item.track)) return { track: item.track, alt: false };
  const viaServer = relayed(item.track, room);
  if (viaServer) return { track: viaServer, alt: false };
  if (playableSource(item.alt)) return { track: item.alt, alt: true };
  return null;
}

// трек плана перехода или уходящего трека: ищем его элемент очереди по qid, чтобы знать про alt
function playableFor(qid, track, queue, room = null) {
  if (playableSource(track)) return track;
  const viaServer = relayed(track, room);
  if (viaServer) return viaServer;
  const item = (queue || []).find((q) => q && q.qid === qid);
  if (playableSource(item?.track)) return item.track;  // сервер уже переключил элемент на общедоступную версию
  return playableTrack(item, room)?.track || null;
}

export function currentItem(room) {
  return room && Array.isArray(room.queue) && room.queue[room.index] ? room.queue[room.index] : null;
}

// снимок комнаты → цель для Player.set (как в приложении, app.js onRoom), но трек — тот, что играет в браузере.
// unplayable: текущий трек есть только в Яндексе (нужно сообщить серверу «ошибка» и показать текст).
// prev — прошлая цель плеера: если этот элемент уже играет общедоступной версией, на сервер комнаты посреди песни
// не переключаемся (это долгая тишина, пока донор заливает файл) — до следующего трека остаёмся на ней
export function roomTarget(room, prev = null) {
  const item = currentItem(room), pb = room?.playback;
  if (!item || !pb || pb.ended) return { target: null, item, alt: false, unplayable: false };
  let pick = playableTrack(item, room);
  if (pick && !pick.alt && prev && prev.qid === item.qid && playableSource(item.alt) && prev.track?.key === item.alt.key) {
    pick = { track: item.alt, alt: true };
  }
  if (!pick) return { target: null, item, alt: false, unplayable: true };
  let next = null, outgoing = null;
  if (pb.next && pb.next.track) {
    const t = playableFor(pb.next.qid, pb.next.track, room.queue, room);
    next = t ? { ...pb.next, track: t } : null;
  }
  if (pb.outgoing && pb.outgoing.track) {
    const t = playableFor(pb.outgoing.qid, pb.outgoing.track, room.queue, room);
    outgoing = t ? { ...pb.outgoing, track: t } : null;
  }
  const target = { qid: item.qid, track: pick.track, anchor: pb.anchor, paused: !!pb.paused, pausedAt: pb.pausedAt, next, outgoing };
  return { target, item, alt: pick.alt, unplayable: false };
}

// повтор загрузки трека с сервера комнаты: плеер сам тот же трек не перезагрузит (подпись цели та же).
// Ошибка за текущий трек, а его ключ всё ещё в room.relay (заливка оборвалась, 504, сервер перезапустили) — пробуем
// снова с паузой RELAY_RETRY_MS[n]; ключ только что вернулся в room.relay (запись снова ждёт донора) — сразу.
// target — нынешняя цель плеера, err — {qid, at} ошибки, tries — {qid, n} сколько повторов было, prev — прошлый снимок
export const RELAY_RETRY_MS = [5000, 10000, 20000];
export function relayRetryDue({ prev = null, room, target, err = null, tries = null, now = Date.now() }) {
  const pb = room?.playback;
  if (!target || !target.track?.relay || target.paused || !pb || pb.paused || pb.ended) return null;
  if (!err || err.qid !== target.qid || target.qid !== currentItem(room)?.qid || !relayed(target.track, room)) return null;
  if (prev && prev.code === room.code && !relayed(target.track, prev)) return "newly";
  const n = tries && tries.qid === target.qid ? tries.n : 0;
  return n < RELAY_RETRY_MS.length && now - err.at >= RELAY_RETRY_MS[n] ? "again" : null;
}

// следующий трек для заблаговременной распаковки (без плана перехода — следующий по очереди)
export function nextPlayable(room) {
  const pb = room?.playback;
  if (pb?.next?.track) return playableFor(pb.next.qid, pb.next.track, room.queue, room);
  const item = room && Array.isArray(room.queue) ? room.queue[room.index + 1] : null;
  return playableTrack(item, room)?.track || null;
}

// какие распакованные треки держать в памяти: текущий, следующий, уходящий
export function keepKeys(room, target) {
  const keys = [target?.track?.key, target?.next?.track?.key, target?.outgoing?.track?.key, nextPlayable(room)?.key];
  return [...new Set(keys.filter(Boolean))];
}

// «Дальше»: следующие n треков очереди
export function upcoming(room, n = 3) {
  if (!room || !Array.isArray(room.queue)) return [];
  return room.queue.slice(Math.max(0, (room.index ?? -1) + 1), Math.max(0, (room.index ?? -1) + 1) + n).map((item) => {
    const pick = playableTrack(item, room);
    return { qid: item.qid, track: pick ? pick.track : item.track, alt: !!pick?.alt, ymOnly: !pick };
  });
}

// ---------- время и позиция ----------

export function positionMs(room, serverNow) {
  const item = currentItem(room), pb = room?.playback;
  if (!item || !pb) return 0;
  const dur = Number(item.track?.durationMs) || 0;
  const raw = pb.ended ? dur : pb.paused ? Number(pb.pausedAt) || 0 : serverNow - pb.anchor;
  return Math.max(0, dur ? Math.min(dur, raw) : raw);
}

export function formatTime(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function clockTime(at) {
  if (!Number.isFinite(at)) return "";
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// подпись синхронизации
export const SYNC_GOOD_MS = 15, SYNC_OK_MS = 80;
export function syncLabel(errorMs) {
  if (errorMs === null || errorMs === undefined || !Number.isFinite(errorMs)) return { cls: "wait", text: "сверяем время…" };
  const a = Math.abs(errorMs);
  if (a < SYNC_GOOD_MS) return { cls: "good", text: "синхронно" };
  if (a < SYNC_OK_MS) return { cls: "meh", text: "почти синхронно" };
  return { cls: "bad", text: "подстраиваемся" };
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export const peopleText = (n) => `${n} ${plural(n, "человек", "человека", "человек")} в комнате`;

// переподключение: 0.5, 1, 2, 4… до 10 секунд (как в приложении, api.js)
export const backoffMs = (retry) => Math.min(10000, 500 * 2 ** Math.max(0, retry));

// ---------- люди и чат ----------

export function initials(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const chars = (w) => Array.from(w);
  return (words.length > 1 ? chars(words[0])[0] + chars(words[1])[0] : chars(words[0]).slice(0, 2).join("")).toUpperCase();
}

export const safeColor = (c) => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : "#7c3aed");

// только http(s); путь от API (/avatars/…) — к адресу API
export function mediaUrl(url, api = "") {
  if (typeof url !== "string" || !url) return "";
  if (url.startsWith("/") && !url.startsWith("//")) return api.replace(/\/+$/, "") + url;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
  } catch { return ""; }
}

export function selfMember(room, userId) {
  return room && Array.isArray(room.members) ? room.members.find((m) => m && m.id === userId) || null : null;
}

export function reactionChips(msg, userId) {
  return REACTIONS.map((r) => {
    const ids = Array.isArray(msg?.reactions?.[r.key]) ? msg.reactions[r.key] : [];
    return { ...r, count: ids.length, mine: ids.includes(userId) };
  });
}

export function pushChat(list, msg, keep = CHAT_KEEP) {
  const out = [...list, msg];
  return out.length > keep ? out.slice(out.length - keep) : out;
}

export function cleanChatText(text) {
  return String(text || "").trim().slice(0, CHAT_MAX);
}

// статусы трека серверу: по каждому qid «загружается» один раз, потом «готов»/«ошибка» — как в приложении (app.js)
export function createStatusReporter(send, limit = 300) {
  const sent = new Map();
  return {
    report(qid, status) {
      if (!qid) return false;
      const prev = sent.get(qid);
      if (prev === status || (status === "loading" && prev)) return false;
      sent.delete(qid); sent.set(qid, status);
      if (sent.size > limit) sent.delete(sent.keys().next().value);
      send({ t: "status", qid, status });
      return true;
    },
    last(qid) { return sent.get(qid); },
    // новое подключение: сервер забыл наши статусы — их можно отправить заново
    reset() { sent.clear(); },
  };
}

// ---------- что показать и когда что сообщить ----------

// «ошибка» за трек только из Яндекса — лишь пока комната играет, как у плеера приложения (на паузе он статус не шлёт).
// Сервер на паузе такие ошибки не разбирает, а тот же статус повторно мы не шлём — и после «играть» комната молчала бы весь трек
export function unplayableErrorQid(room) {
  const item = currentItem(room), pb = room?.playback;
  if (!item || !pb || pb.paused || pb.ended || playableTrack(item, room)) return null;
  return item.qid || null;
}

// переход на трек, которого в браузере нет: уходящий трек доигрываем до конца перехода, а не обрываем.
// prev — прошлая цель плеера: если это тот же трек, отдаём её же, чтобы плеер не перезапускал звук
export function outgoingHold(room, prev, serverNow) {
  const pb = room?.playback, o = pb?.outgoing;
  if (!o || !o.track || !pb || pb.paused || pb.ended) return null;
  const track = playableFor(o.qid, o.track, room.queue, room);
  const until = Number(o.anchor) + (Number(o.fadeMs) || 0);
  if (!track || !(serverNow < until)) return null;
  // только если этот трек уже играл у нас: новичку незачем качать хвост чужого перехода (и слать за него статусы)
  const same = prev && !prev.paused && prev.qid === o.qid && prev.track?.key === track.key && prev.anchor === o.trackAnchor;
  if (!same) return null;
  return { target: { ...prev, next: null, outgoing: null }, from: Number(o.anchor), until };
}

// плашка у названия трека: синхронность, загрузка или почему трек у тебя не звучит. null — не показывать
// atEnd: трек у нас уже доиграл, а сервер ещё не переключил — это не «загрузка»
export function syncPill({ room, pick, failed = false, loading = false, atEnd = false, errorMs = null } = {}) {
  const item = currentItem(room), pb = room?.playback;
  if (!item || !pb || pb.paused || pb.ended) return null;
  if (pick?.unplayable) return { cls: "off", text: "не играет в браузере" };
  if (failed) return { cls: "off", text: "трек не загрузился" };
  if (loading) return atEnd ? null : { cls: "wait", text: "загружаю трек…" };
  return syncLabel(errorMs);
}

// текст ошибки трека: без повтора «трек не загрузился» и без английских сообщений браузера
export function trackErrorMessage(err) {
  if (err?.whole && err.message) return `${err.message} ${SILENCE_NOTE}`;
  let text = String(err?.message || "").trim();
  if (err?.name === "TypeError" || /network|load failed|failed to fetch|aborted/i.test(text)) text = "связь оборвалась при скачивании — проверь интернет";
  else if (err?.name === "EncodingError" || !/[а-яё]/i.test(text)) text = "браузер не смог прочитать файл трека";
  text = text.replace(/^трек не загрузился\s*[—–-]?\s*/i, "").replace(/[.\s]+$/, "") || "браузер не смог прочитать файл трека";
  return `Трек не загрузился: ${text}. ${SILENCE_NOTE}`;
}

// заранее качаем следующий трек: не чаще одной попытки, пока он лежит в памяти или качается, а после неудачи — не раньше чем через retryMs.
// Иначе неудача повторялась бы 4 раза в секунду (каждый тик интерфейса) и съедала лимит запросов к серверу и к SoundCloud
export function createPrefetch({ retryMs = 30000, now = () => Date.now(), limit = 50 } = {}) {
  const failed = new Map(), busy = new Set();
  return {
    want(key, cached = false) {
      if (!key || cached || busy.has(key)) return false;
      const at = failed.get(key);
      return at === undefined || now() - at >= retryMs;
    },
    start(key) { busy.add(key); },
    finish(key, ok) {
      busy.delete(key); failed.delete(key);
      if (!ok) { failed.set(key, now()); if (failed.size > limit) failed.delete(failed.keys().next().value); }
    },
    reset() { failed.clear(); busy.clear(); },
  };
}

// кнопка звука: на нуле громкости «включить» возвращает звук, а не переключает невидимый флажок
export function toggleMute({ muted, volume }) {
  if (volume === 0) return { muted: false, volume: 0.5 };
  return { muted: !muted, volume };
}

// вход не принят (401/4001): стираем сохранённый вход, только если это тот же, с которым ходила вкладка.
// Другой — значит, в соседней вкладке уже вошли заново: его не трогаем и берём себе
export function tokenAfterReject(stored, used) {
  const s = stored || "";
  return { clear: !!s && s === used, next: s && s !== used ? s : "" };
}

export const upperFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const GONE_RETRY = "Можно вернуться к приглашению и попробовать снова.";
// экран «не получилось»: не обещаем «попробуй снова», если зайти точно не выйдет
export function goneCopy(kind, error = "") {
  const e = String(error || "");
  if (kind === "kicked" || /выгнали/i.test(e)) return { title: kind === "kicked" ? "Владелец убрал тебя из комнаты" : upperFirst(e),
    sub: "Владелец закрыл тебе вход в эту комнату. Зайти снова получится, только если он снимет запрет." };
  if (kind === "deleted" || /комнаты с таким кодом нет/i.test(e)) return { title: kind === "deleted" ? "Комнату удалили" : "Комнаты больше нет",
    sub: "Этой комнаты больше нет. Попроси у друга ссылку на новую." };
  return { title: upperFirst(e) || "Не получилось зайти в комнату", sub: GONE_RETRY };
}
// ---------- устройство ----------

const navUa = (nav) => String(nav?.userAgent || "");
// iPhone, iPad (iPadOS выдаёт себя за Mac, но с сенсорным экраном) или Android
export const isIos = (nav) => /iPhone|iPad|iPod/.test(navUa(nav)) || (/Macintosh/.test(navUa(nav)) && Number(nav?.maxTouchPoints) > 1);
// телефоны и планшеты: у вкладки там мало памяти, длинный трек целиком не распакуется. Компьютеры с 4 ГБ справляются — их не трогаем
export const isPhone = (nav) => isIos(nav) || /Android/.test(navUa(nav));

// Safari до 27-й версии (и любой браузер на iOS — у всех там движок Safari) не распаковывает фрагментированный MP4 целиком:
// звук SoundCloud (HLS, AAC во фрагментах) отдаём ему как поток ADTS. На localhost ?adts=1 включает это и в Chrome — для проверки
export function preferAdts(env = {}) {
  const ua = navUa(env.nav);
  if (isIos(env.nav)) return true;
  if (/Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Firefox/.test(ua)) return true;
  const local = env.hostname === "localhost" || env.hostname === "127.0.0.1";
  return local && /(?:^|[?&])adts=1(?:&|$)/.test(String(env.search || ""));
}

// ---------- fMP4 → ADTS ----------

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const nearestRateIndex = (rate) => SAMPLE_RATES.reduce((best, r, i) => (Math.abs(r - rate) < Math.abs(SAMPLE_RATES[best] - rate) ? i : best), 0);
const mp4Error = (text) => new Error(`SoundCloud: ${text}`);

// дочерние боксы MP4 в [start, end): {type, start (начало бокса), body (начало содержимого), end}
function mp4Boxes(u8, start = 0, end = u8.length) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = [];
  for (let at = start; at + 8 <= end;) {
    let size = v.getUint32(at), body = at + 8;
    const type = String.fromCharCode(u8[at + 4], u8[at + 5], u8[at + 6], u8[at + 7]);
    if (size === 1) {  // 64-битный размер
      if (at + 16 > end) throw mp4Error("битый файл звука");
      size = v.getUint32(at + 8) * 2 ** 32 + v.getUint32(at + 12); body = at + 16;
    } else if (size === 0) size = end - at;  // до конца файла
    if (size < body - at || at + size > end) throw mp4Error("битый файл звука");
    out.push({ type, start: at, body, end: at + size });
    at += size;
  }
  return out;
}
const child = (u8, box, type) => box && mp4Boxes(u8, box.body, box.end).find((b) => b.type === type);
const descend = (u8, box, types) => types.reduce((b, t) => child(u8, b, t), box);

// длина дескриптора MPEG-4: до 4 байт по 7 бит
function descriptor(u8, at, end) {
  const tag = u8[at++];
  let len = 0;
  for (let i = 0; i < 4 && at < end; i++) { const b = u8[at++]; len = len * 128 + (b & 0x7f); if (!(b & 0x80)) break; }
  return { tag, body: at, end: Math.min(end, at + len) };
}

// AudioSpecificConfig → профиль ADTS. HE-AAC (SBR/PS) пишем как AAC LC с базовой частотой — так его понимают все декодеры
function readAsc(u8, at, end) {
  let bit = at * 8;
  const read = (n) => { let x = 0; for (let i = 0; i < n; i++, bit++) { if (bit >= end * 8) throw mp4Error("битое описание AAC"); x = x * 2 + ((u8[bit >> 3] >> (7 - (bit & 7))) & 1); } return x; };
  const aot = () => { const x = read(5); return x === 31 ? 32 + read(6) : x; };
  const rate = () => { const i = read(4); return i === 15 ? nearestRateIndex(read(24)) : i; };
  let type = aot(), sfi = rate();
  const channels = read(4);
  if (type === 5 || type === 29) { rate(); type = aot(); }
  return { type, sfi, channels };
}

function audioConfig(init) {
  const moov = mp4Boxes(init).find((b) => b.type === "moov");
  if (!moov) throw mp4Error("в начале потока нет описания звука");
  const v = new DataView(init.buffer, init.byteOffset, init.byteLength);
  const defaults = new Map();  // track_ID → default_sample_size из trex
  const mvex = child(init, moov, "mvex");
  for (const trex of mvex ? mp4Boxes(init, mvex.body, mvex.end).filter((b) => b.type === "trex") : []) {
    const size = trex.body + 20 <= trex.end ? v.getUint32(trex.body + 16) : 0;  // 0 — размера по умолчанию нет
    if (size) defaults.set(v.getUint32(trex.body + 4), size);
  }
  let seen = "";
  for (const trak of mp4Boxes(init, moov.body, moov.end).filter((b) => b.type === "trak")) {
    const tkhd = child(init, trak, "tkhd"), stsd = descend(init, trak, ["mdia", "minf", "stbl", "stsd"]);
    if (!tkhd || !stsd || stsd.body + 8 > stsd.end) continue;
    const hdlr = descend(init, trak, ["mdia", "hdlr"]);
    if (hdlr && hdlr.body + 12 <= hdlr.end && String.fromCharCode(...init.subarray(hdlr.body + 8, hdlr.body + 12)) !== "soun") continue;  // видео и прочее
    const trackId = v.getUint32(tkhd.body + (init[tkhd.body] === 1 ? 20 : 12));
    const entry = mp4Boxes(init, stsd.body + 8, stsd.end)[0];
    if (!entry) continue;
    if (entry.type !== "mp4a") { seen = seen || entry.type; continue; }
    // AudioSampleEntry: 28 байт полей; у версии 1 и 2 (QuickTime) — ещё 16 и 36
    const version = v.getUint16(entry.body + 8), skip = 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
    const kids = mp4Boxes(init, entry.body + skip, entry.end);
    const esds = kids.find((b) => b.type === "esds") || child(init, kids.find((b) => b.type === "wave"), "esds");
    if (!esds) throw mp4Error("нет описания AAC (esds)");
    let d = descriptor(init, esds.body + 4, esds.end);
    if (d.tag !== 3) throw mp4Error("битое описание AAC");
    let at = d.body + 2;
    const flags = init[at++];
    if (flags & 0x80) at += 2;
    if (flags & 0x40) at += 1 + init[at];
    if (flags & 0x20) at += 2;
    d = descriptor(init, at, d.end);
    if (d.tag !== 4) throw mp4Error("битое описание AAC");
    const oti = init[d.body];
    let cfg;
    if (oti === 0x40) {
      const dsi = descriptor(init, d.body + 13, d.end);
      if (dsi.tag !== 5) throw mp4Error("нет настроек AAC");
      cfg = readAsc(init, dsi.body, dsi.end);
    } else if (oti >= 0x66 && oti <= 0x68) {  // AAC из MPEG-2: профиль задан самим кодом
      cfg = { type: oti - 0x65, sfi: nearestRateIndex(v.getUint32(entry.body + 24) >>> 16), channels: v.getUint16(entry.body + 16) };
    } else throw mp4Error(`звук не в AAC (код ${oti}) — так его не прочитать`);
    if (cfg.type < 1 || cfg.type > 4) throw mp4Error(`этот вид AAC (${cfg.type}) так не прочитать`);
    if (cfg.sfi > 12) throw mp4Error("неизвестная частота звука");
    if (!cfg.channels) cfg.channels = v.getUint16(entry.body + 16) || 2;  // 0 — раскладка в PCE, в ADTS её не передать: берём число каналов из описания
    if (cfg.channels > 7) throw mp4Error("слишком много каналов звука");
    return { ...cfg, trackId, defaultSize: defaults.get(trackId) };
  }
  throw mp4Error(seen ? `звук не в AAC (${seen.trim()}) — так его не прочитать` : "в потоке нет звуковой дорожки");
}

function adtsHeader(out, at, cfg, size) {
  const len = size + 7;
  if (len > 0x1fff) throw mp4Error("слишком большой кадр AAC");
  out[at] = 0xff;
  out[at + 1] = 0xf1;  // MPEG-4, без контрольной суммы
  out[at + 2] = ((cfg.type - 1) << 6) | (cfg.sfi << 2) | (cfg.channels >> 2);
  out[at + 3] = ((cfg.channels & 3) << 6) | (len >> 11);
  out[at + 4] = (len >> 3) & 0xff;
  out[at + 5] = ((len & 7) << 5) | 0x1f;
  out[at + 6] = 0xfc;
}

// кадры AAC одного фрагмента (moof + mdat): [{at, size}] относительно начала буфера фрагмента
function fragmentSamples(u8, cfg) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = [];
  const top = mp4Boxes(u8);
  top.forEach((moof, i) => {
    if (moof.type !== "moof") return;
    const mdat = top.slice(i + 1).find((b) => b.type === "mdat");
    let prevEnd = null;
    for (const traf of mp4Boxes(u8, moof.body, moof.end).filter((b) => b.type === "traf")) {
      const kids = mp4Boxes(u8, traf.body, traf.end), tfhd = kids.find((b) => b.type === "tfhd");
      if (!tfhd) continue;
      const tf = v.getUint32(tfhd.body) & 0xffffff;
      if (v.getUint32(tfhd.body + 4) !== cfg.trackId) continue;
      let at = tfhd.body + 8, base = moof.start;
      if (tf & 0x1) { base = v.getUint32(at) * 2 ** 32 + v.getUint32(at + 4); at += 8; }
      else if (!(tf & 0x20000) && prevEnd !== null) base = prevEnd;
      if (tf & 0x2) at += 4;
      if (tf & 0x8) at += 4;
      const defSize = tf & 0x10 ? v.getUint32(at) : cfg.defaultSize;
      let next = null;  // где кончились данные прошлого trun
      for (const trun of kids.filter((b) => b.type === "trun")) {
        const fl = v.getUint32(trun.body) & 0xffffff, count = v.getUint32(trun.body + 4);
        let p = trun.body + 8, start;
        if (fl & 0x1) { start = base + v.getInt32(p); p += 4; }
        else start = next ?? (prevEnd === null && !(tf & 0x1) && mdat ? mdat.body : base);
        if (fl & 0x4) p += 4;
        const step = 4 * [0x100, 0x200, 0x400, 0x800].filter((f) => fl & f).length;
        if (p + step * count > trun.end) throw mp4Error("битый фрагмент звука");
        for (let k = 0; k < count; k++, p += step) {
          const size = fl & 0x200 ? v.getUint32(p + (fl & 0x100 ? 4 : 0)) : defSize;
          if (size === undefined) throw mp4Error("во фрагменте нет размеров кадров");
          if (start + size > u8.length) throw mp4Error("битый фрагмент звука");
          if (size) out.push({ at: start, size });
          start += size;
        }
        next = start;
      }
      if (next !== null) prevEnd = next;
    }
  });
  return out;
}

// init (ftyp+moov) и фрагменты HLS (moof+mdat) → один поток ADTS: каждый кадр AAC со своим 7-байтным заголовком
export function fmp4ToAdts(initBytes, fragments) {
  const u8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
  const cfg = audioConfig(u8(initBytes));
  const parts = fragments.map(u8).map((f) => ({ f, samples: fragmentSamples(f, cfg) }));
  const total = parts.reduce((s, p) => s + p.samples.reduce((a, x) => a + x.size + 7, 0), 0);
  if (!total) throw mp4Error("в потоке нет звука");
  const out = new Uint8Array(total);
  let at = 0;
  for (const { f, samples } of parts) {
    for (const { at: from, size } of samples) { adtsHeader(out, at, cfg, size); out.set(f.subarray(from, from + size), at + 7); at += size + 7; }
  }
  return out;
}

// ---------- звук по источникам ----------

// плейлист HLS: init (#EXT-X-MAP) и сегменты, адреса — относительно адреса плейлиста
export function parseHls(text, base) {
  const abs = (u) => new URL(u, base).toString();
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim());
  const map = lines.map((l) => /^#EXT-X-MAP:.*URI="([^"]+)"/.exec(l)).find(Boolean);
  const segments = lines.filter((l) => l && !l.startsWith("#")).map(abs);
  return { init: map ? abs(map[1]) : null, segments };
}

export function concatBuffers(parts) {
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(new Uint8Array(p), at); at += p.byteLength; }
  return out.buffer;
}

// по n запросов параллельно, порядок результата — как у входа
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

async function errorText(r, fallback) {
  try {
    const j = await r.clone().json();
    if (j && typeof j.error === "string" && j.error) return j.error;
  } catch { /* не JSON */ }
  return fallback;
}

const browserEnv = () => ({ nav: globalThis.navigator, hostname: globalThis.location?.hostname, search: globalThis.location?.search });

// loadBuffer(track, fresh) для Player: ArrayBuffer целиком.
// env — {nav, hostname, search}: по нему решаем, отдавать ли SoundCloud как ADTS и пускать ли длинные треки (на телефоне не влезут в память)
export function createLoader({ api, token, fetch: fetchImpl = (...a) => globalThis.fetch(...a), concurrency = 6, env = browserEnv() }) {
  const base = String(api || "").replace(/\/+$/, "");
  const auth = () => ({ Authorization: `Bearer ${typeof token === "function" ? token() : token}` });
  const get = async (url, opts, name) => {
    let r;
    try { r = await fetchImpl(url, opts); } catch { throw new Error(`${name} не отвечает — проверь интернет`); }
    if (!r.ok) throw Object.assign(new Error(await errorText(r, `${name}: ошибка ${r.status}`)), { status: r.status });
    return r;
  };
  // тело читаем под тем же сторожем: связь может оборваться посреди файла
  const body = async (r, how, name) => { try { return await r[how](); } catch { throw new Error(`${name} не отвечает — проверь интернет`); } };
  const bytes = async (url, name, opts = {}) => body(await get(url, opts, name), "arrayBuffer", name);
  const longLimit = isPhone(env?.nav);
  const adtsFirst = preferAdts(env || {});
  let fmp4Failed = false;  // браузер уже не смог прочитать фрагментированный MP4 — дальше сразу ADTS
  const served = new Map();  // трек → какой вид ему отдали в прошлый раз ("adts" | "mp4"): при повторе даём другой
  // fresh — движок повторяет загрузку, потому что файл не распаковался: для HLS пробуем другой вид (MP4 ↔ ADTS)
  async function hls(url, name, cache, fresh, key) {
    const text = await body(await get(url, { cache }, name), "text", name);
    const { init, segments } = parseHls(text, url);
    if (!segments.length) throw new Error(`${name}: пустой поток`);
    const urls = [...(init ? [init] : []), ...segments];
    const parts = await mapLimit(urls, concurrency, (u) => bytes(u, name, { cache }));
    if (!init) return concatBuffers(parts);
    const before = served.get(key);
    let kind = adtsFirst || fmp4Failed ? "adts" : "mp4";
    if (fresh) {
      kind = (before || kind) === "adts" ? "mp4" : "adts";
      if (before === "mp4" || (!before && kind === "adts")) fmp4Failed = true;  // MP4 не распаковался — и дальше сразу ADTS
    }
    if (served.size > 50) served.delete(served.keys().next().value);
    served.set(key, kind);
    if (kind === "mp4") return concatBuffers(parts);
    try { return fmp4ToAdts(parts[0], parts.slice(1)).buffer; }
    catch (e) { if (fresh) throw e; served.set(key, "mp4"); return concatBuffers(parts); }  // не AAC — пусть браузер попробует как есть
  }
  return async function loadBuffer(track, fresh) {
    const id = String(track?.id ?? "");
    const cache = fresh ? "reload" : "default";
    if (longLimit && Number(track?.durationMs) > LONG_TRACK_MS) throw Object.assign(new Error(LONG_TRACK_TEXT), { whole: true });
    switch (track?.source) {
      case "audius": {
        if (!/^[A-Za-z0-9]{1,32}$/.test(id)) throw new Error("неверный id трека");
        return bytes(`https://api.audius.co/v1/tracks/${encodeURIComponent(id)}/stream?app_name=FlowApp`, "Audius", { cache });
      }
      case "sc": {
        if (!/^\d{1,20}$/.test(id)) throw new Error("неверный id трека");
        const r = await get(`${base}/api/web/sc?id=${id}`, { headers: auth(), cache: "no-store" }, "Сервер Flow");
        const s = await r.json().catch(() => null);
        if (!s || typeof s.url !== "string") throw new Error("SoundCloud не отдал ссылку на трек");
        if (s.protocol === "progressive") return bytes(s.url, "SoundCloud", { cache });
        if (s.protocol === "hls") return hls(s.url, "SoundCloud", cache, !!fresh, track.key);
        throw new Error("SoundCloud отдал неизвестный формат");
      }
      case "jamendo": {
        if (!/^\d{1,12}$/.test(id)) throw new Error("неверный id трека");
        return bytes(`${base}/api/web/jamendo?id=${id}`, SOURCE_NAME.jamendo, { headers: auth(), cache });
      }
      case "ym": {
        // играет только то, что участник с Плюсом залил на сервер комнаты (track.relay — код комнаты).
        // Сервер может держать ответ, пока участник не начал заливку (до 40 с), — fetch ждёт, движок даёт загрузке 75 с
        if (!track.relay) throw new Error(YM_ONLY_TEXT);
        const room = String(track.relay), key = String(track.key || "");
        if (!CODE_RE.test(room) || !key) throw new Error("неверный трек комнаты");
        return bytes(`${base}/api/relay?room=${encodeURIComponent(room)}&key=${encodeURIComponent(key)}`, "Сервер Flow", { headers: auth(), cache: "no-store" });
      }
      default: throw new Error("неизвестный источник трека");
    }
  };
}

// ---------- вход ----------

export function validateAuth({ username, password, display } = {}, mode = "login") {
  const u = String(username || "").trim().replace(/^@/, "");
  const p = String(password || "");
  if (!u) return { error: "Впиши тег" };
  if (mode === "register" && !/^[\p{L}\p{N}_.-]{3,24}$/u.test(u)) return { error: "Тег: от 3 до 24 символов — буквы, цифры, _ . -" };
  if (!p) return { error: "Впиши пароль" };
  if (mode === "register" && p.length < 6) return { error: "Пароль — не меньше 6 символов" };
  const body = { username: u, password: p };
  const d = String(display || "").trim().slice(0, 32);
  if (mode === "register" && d) body.display = d;
  return { body };
}

// ник гостя — те же правила, что на сервере (POST /api/web/guest): невидимые символы убираем, пробелы схлопываем,
// от 2 до 24 символов и хотя бы одна буква или цифра
export function cleanGuestName(name) {
  return String(name || "").normalize("NFC").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").replace(/\s+/g, " ").trim();
}
export function validateGuest(name) {
  const n = cleanGuestName(name);
  if (!n) return { error: "Впиши ник" };
  const len = [...n].length;
  if (len < 2 || len > 24) return { error: "Ник: от 2 до 24 символов" };
  if (!/[\p{L}\p{N}]/u.test(n)) return { error: "В нике нужна хотя бы одна буква или цифра" };
  return { body: { name: n } };
}

// тихий WAV для медиасессии (как в приложении): браузер показывает трек только рядом с играющим <audio>
export function silentWavBytes(sec = 10, rate = 8000) {
  const n = sec * rate, b = new Uint8Array(44 + n), v = new DataView(b.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  str(0, "RIFF"); v.setUint32(4, 36 + n, true); str(8, "WAVEfmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate, true);
  v.setUint16(32, 1, true); v.setUint16(34, 8, true); str(36, "data"); v.setUint32(40, n, true);
  b.fill(128, 44);
  return b;
}
