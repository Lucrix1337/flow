// Страница приглашения: карточка комнаты, вход в аккаунт Flow и прослушивание комнаты прямо в браузере.
// Синхронизация и звук — тот же движок, что в приложении (engine/sync.js, копия client/renderer/sync.js).
import { Clock, Player } from "./engine/sync.js?v=20261121";
import * as core from "./listen-core.mjs?v=2026110502";

const API = String(window.FLOW_API || "https://api.flowww.space").replace(/\/+$/, "");
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v === null || v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, String(v)); } catch { /* приватный режим */ } },
};

const S = {
  code: core.pickCode(location),
  token: store.get(core.TOKEN_KEY) || "",
  user: null,
  ws: null, wsWanted: false, retry: 0, retryTimer: null, online: false,
  room: null, chat: [], pick: null,
  mode: "guest",
  lastStatus: null, resend: false, trackError: null,
  volume: 0.8, muted: false,
  target: null, holdTimer: null, mediaSig: "",
};
{
  const v = Number(store.get(core.VOLUME_KEY));
  if (store.get(core.VOLUME_KEY) !== null && Number.isFinite(v)) S.volume = Math.max(0, Math.min(1, v));
  S.muted = store.get(core.MUTED_KEY) === "1";
}

let clock = null, player = null, npAudio = null;
const reporter = core.createStatusReporter((m) => wsSend(m));
const prefetch = core.createPrefetch();

// ---------- мелочи DOM ----------

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}
function icon(name, cls = "ic") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", cls); svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.appendChild(use);
  return svg;
}
function setIcon(button, name) {
  const old = button.querySelector("svg");
  const fresh = icon(name);
  if (old) old.replaceWith(fresh); else button.prepend(fresh);
}
function show(node, on) { if (node) node.hidden = !on; }
function setImg(img, ph, url) {
  const src = core.mediaUrl(url, API);
  if (!src) { img.removeAttribute("src"); show(img, false); show(ph, true); return; }
  if (img.getAttribute("src") !== src) {
    img.onerror = () => { show(img, false); show(ph, true); };
    img.onload = () => { show(img, true); show(ph, false); };
    img.src = src;
  } else if (img.complete && img.naturalWidth) { show(img, true); show(ph, false); }
}
let toastTimer = null;
function toast(text) {
  const t = $("toast");
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}
const upperFirst = core.upperFirst;

// ---------- REST ----------

async function apiReq(method, path, body, headers = {}) {
  let r;
  try {
    r = await fetch(API + path, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      credentials: "omit",
    });
  } catch {
    throw Object.assign(new Error("Сервер Flow недоступен — проверь интернет"), { status: 0 });
  }
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(json.error || `Ошибка ${r.status}`), { status: r.status });
  return json;
}

function saveToken(token) {
  S.token = token || "";
  store.set(core.TOKEN_KEY, token || null);
}
// вход used не принят: стираем его, но не новый вход из соседней вкладки. true — есть тот, новый, и он уже в S.token
function dropToken(used) {
  const { clear, next } = core.tokenAfterReject(store.get(core.TOKEN_KEY), used);
  if (clear) store.set(core.TOKEN_KEY, null);
  S.token = next;
  return !!next;
}

// ---------- карточка комнаты ----------

function renderCard(info) {
  const room = info?.room;
  $("code").textContent = S.code;
  if (!room) { show($("room-info"), false); return; }
  $("room-title").textContent = room.name || `Комната ${S.code}`;
  document.title = `${room.name || `Комната ${S.code}`} — Flow`;
  const owner = room.owner || {};
  $("room-owner").textContent = owner.display ? `Ведёт ${owner.display}${owner.username ? ` (@${owner.username})` : ""}` : "";
  const t = room.track;
  $("room-now").textContent = !t ? "Сейчас ничего не играет"
    : `${room.paused ? "На паузе" : "Сейчас играет"}: ${t.title || "без названия"}${t.artists ? ` — ${t.artists}` : ""}`;
  const n = Number(room.online) || 0;
  $("room-online").textContent = n ? core.peopleText(n) : "Сейчас в комнате никого нет";
  setImg($("room-cover"), $("room-cover-ph"), t?.cover);
  show($("room-info"), true);
}

async function loadInfo() {
  if (!S.code) return;
  let r;
  try { r = await fetch(`${API}/api/share/room?code=${encodeURIComponent(S.code)}`, { credentials: "omit" }); } catch { return; }
  if (r.status === 404) {
    show($("room-missing"), true); show($("listen"), false); show($("open"), false); show($("auth"), false); show($("room-info"), false);
    show($("room-lead"), false); show($("hint"), false); show($("actions"), true);
    $("room-title").textContent = "Комнаты нет";
    return;
  }
  if (!r.ok) return;  // лимит или сбой — остаётся карточка с кодом, слушать всё равно можно
  const j = await r.json().catch(() => null);
  if (j?.room) renderCard(j);
}

function showLanding(view = "ok") {
  stopListening();
  show($("listen-view"), false); show($("landing"), true); show($("top"), true);
  document.body.classList.remove("in-room");
  show($("ok"), view === "ok"); show($("gone"), view === "gone"); show($("bad"), view === "bad");
  setBackdrop("");
}

// ---------- вход ----------

// guest — зайти по нику без регистрации (по умолчанию), login / register — обычный аккаунт Flow
function setMode(mode) {
  S.mode = mode;
  const guest = mode === "guest", reg = mode === "register";
  show($("guest-fields"), guest); show($("account-fields"), !guest);
  show($("to-account"), guest); show($("to-guest"), !guest); show($("forgot"), mode === "login");
  $("tab-login").setAttribute("aria-selected", String(!reg));
  $("tab-register").setAttribute("aria-selected", String(reg));
  show($("display-field"), reg); show($("register-hint"), reg);
  $("auth-submit").textContent = guest ? "Слушать" : reg ? "Создать аккаунт и слушать" : "Войти и слушать";
  $("auth").elements.password.autocomplete = reg ? "new-password" : "current-password";
  $("auth").elements.password.placeholder = reg ? "Не меньше 6 символов" : "";
  $("auth").elements.username.placeholder = reg ? "Придумай тег: буквы, цифры, _ . -" : "Твой тег, без @";
  authError("");
}
function authError(text) { $("auth-error").textContent = text; show($("auth-error"), !!text); }
function showAuth(message = "", mode = "guest") {
  show($("actions"), false); show($("auth"), true);
  setMode(mode);
  authError(message);
  focusAuth();
}
function focusAuth() {
  const f = $("auth").elements;
  if (S.mode !== "guest") return f.username.focus();
  if (!f.nick.value) f.nick.value = store.get(core.GUEST_NAME_KEY) || "";
  f.nick.focus();
}
function switchMode(mode) { setMode(mode); focusAuth(); }
function hideAuth() { show($("auth"), false); show($("actions"), true); authError(""); quietMedia(); }

async function onListen() {
  if (!audioReady()) return;
  if (!S.token) return showAuth();
  const button = $("listen"), used = S.token;
  let again = false;
  button.disabled = true;
  try {
    const me = await apiReq("GET", "/api/me");
    S.user = me.user || null;
    enterRoom();
  } catch (e) {
    if (e.status === 401) { again = dropToken(used); if (!again) showAuth("Вход устарел — зайди снова."); }
    else { quietMedia(); toast(e.message); }
  } finally { button.disabled = false; }
  if (again) onListen();  // в соседней вкладке уже вошли заново — пробуем с тем входом
}

async function onAuthSubmit(e) {
  e.preventDefault();
  if (!audioReady()) return;
  const f = $("auth").elements;
  const guest = S.mode === "guest";
  const v = guest ? core.validateGuest(f.nick.value)
    : core.validateAuth({ username: f.username.value, password: f.password.value, display: f.display.value }, S.mode);
  if (v.error) return authError(v.error);
  const submit = $("auth-submit");
  submit.disabled = true; authError("");
  try {
    const j = await apiReq("POST", guest ? "/api/web/guest" : S.mode === "register" ? "/api/register" : "/api/login", v.body, { "X-Flow-Client": "web" });
    if (guest) { store.set(core.GUEST_NAME_KEY, v.body.name); f.nick.value = v.body.name; }
    if (!j.token) throw new Error("Сервер не выдал вход — попробуй ещё раз");
    saveToken(j.token); S.user = j.user || null;
    f.password.value = "";
    hideAuth();
    enterRoom();
  } catch (err) {
    authError(upperFirst(err.message));
  } finally { submit.disabled = false; }
}

// у гостя эта же кнопка — «Сменить ник»: гостевой вход закрываем и сразу показываем поле ника
async function logout() {
  const token = S.token, wasGuest = !!S.user?.guest;
  showLanding("ok");
  dropToken(token); S.token = ""; S.user = null;
  hideAuth();
  if (token) fetch(`${API}/api/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, credentials: "omit" }).catch(() => {});
  if (wasGuest) showAuth();
  else toast("Ты вышел из аккаунта");
}

function renderAccountButton() {
  const guest = !!S.user?.guest;
  $("logout").textContent = guest ? "Сменить ник" : "Выйти из аккаунта";
  $("logout").title = guest ? "Зайти в комнату под другим ником или со своим аккаунтом Flow" : "";
}

// ---------- звук ----------

// создаётся и будится внутри нажатия: без жеста браузер не даст играть
function audioReady() {
  try {
    if (!window.AudioContext || !window.WebSocket) throw new Error("no audio");
    if (!player) {
      clock = new Clock((m) => wsSend(m));
      player = new Player(clock, core.createLoader({ api: API, token: () => S.token }));
      player.onStatus = onPlayerStatus;
      applyVolume();
    }
    // iOS: без этого звук Web Audio замолкает, как только телефон заблокировали или ушли в другое приложение (Safari 17+, остальные не знают этого свойства)
    try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch { /* нет */ }
    player.ctx.resume().catch(() => {});
    try {  // Safari: короткий тихий буфер в том же нажатии окончательно разблокирует звук
      const b = player.ctx.createBuffer(1, 1, player.ctx.sampleRate), s = player.ctx.createBufferSource();
      s.buffer = b; s.connect(player.ctx.destination); s.start(0);
    } catch { /* не страшно */ }
    if (!npAudio && "mediaSession" in navigator) {
      npAudio = new Audio(URL.createObjectURL(new Blob([core.silentWavBytes()], { type: "audio/wav" })));
      npAudio.loop = true;
    }
    // запуск внутри нажатия разблокирует дорожку, но играть ей — только в комнате (иначе на карточке висит «играет звук»)
    npAudio?.play().then(() => { if (!S.wsWanted) npAudio.pause(); }, () => {});
    return true;
  } catch {
    toast("Этот браузер не умеет так играть звук. Открой ссылку в свежем Chrome, Edge, Firefox или Safari — или в приложении Flow.");
    return false;
  }
}

// беззвучная дорожка медиапанели нужна только в комнате
function quietMedia() { if (!S.wsWanted && npAudio) npAudio.pause(); }

function applyVolume() {
  if (player) player.setVolume(S.muted ? 0 : S.volume);
  $("volume").value = String(Math.round(S.volume * 100));
  $("volume").style.setProperty("--v", `${Math.round((S.muted ? 0 : S.volume) * 100)}%`);
  const btn = $("mute");
  setIcon(btn, S.muted || S.volume === 0 ? "muted" : "volume");
  btn.setAttribute("aria-label", S.muted ? "Включить звук" : "Выключить звук");
  btn.setAttribute("aria-pressed", String(S.muted));
}

function onPlayerStatus(status, target, err) {
  if (!target?.qid || !S.room) return;
  // статус шлём только за текущий трек комнаты, как приложение: сервер хранит один статус на окно,
  // и «готов» за доигрывающий хвост перехода затёр бы «ошибку» за текущий — комната бы не пропустила его
  if (target.qid !== core.currentItem(S.room)?.qid) return;
  reporter.report(target.qid, status);
  S.lastStatus = { qid: target.qid, status: reporter.last(target.qid) };
  if (status === "error") S.trackError = { qid: target.qid, text: core.trackErrorMessage(err), at: Date.now() };
  else if (S.trackError?.qid === target.qid) S.trackError = null;
  renderNow();
}

// ---------- WebSocket ----------

function wsSend(m) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m));
}

function connect() {
  clearTimeout(S.retryTimer);
  S.wsWanted = true;
  let ws;
  const used = S.token;
  try { ws = new WebSocket(`${API.replace(/^http/, "ws")}/ws`, ["flow", used]); }
  catch { S.retryTimer = setTimeout(connect, core.backoffMs(S.retry++)); return; }
  S.ws = ws;
  ws.onmessage = (e) => {
    if (S.ws !== ws) return;
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    // не Object.hasOwn: его нет в Safari до 15.4 — там падало бы каждое сообщение
    if (m && typeof m.t === "string" && Object.prototype.hasOwnProperty.call(handlers, m.t)) handlers[m.t](m);
  };
  ws.onclose = (e) => {
    if (S.ws !== ws) return;
    S.ws = null; clock?.stop(); setOnline(false);
    if (!S.wsWanted) return;
    if (e.code === 4001) { if (dropToken(used)) S.retryTimer = setTimeout(connect, 0); else sessionEnded(); return; }
    if (e.code === 4029) { showGone("error", "Слишком много попыток зайти в комнату. Подожди минуту и попробуй снова."); return; }
    S.retryTimer = setTimeout(connect, core.backoffMs(S.retry++));
  };
}

function stopListening() {
  S.wsWanted = false;
  clearTimeout(S.retryTimer);
  const ws = S.ws;
  S.ws = null;
  if (ws) {
    try { if (ws.readyState === 1) ws.send(JSON.stringify({ t: "leave" })); } catch { /* уже закрыт */ }
    try { ws.close(1000); } catch { /* уже закрыт */ }
  }
  clock?.stop();
  clearTimeout(S.holdTimer);
  player?.set(null);
  S.room = null; S.chat = []; S.pick = null; S.trackError = null; S.lastStatus = null; S.target = null; S.hold = null; S.holdExit = null;
  prefetch.reset();
  if (npAudio) npAudio.pause();
  clearMedia();
}

function sessionEnded() {
  showLanding("ok");
  S.user = null;
  showAuth("Вход закончился — зайди снова.");
}

// kind: kicked, deleted или error (текст от сервера) — от него зависит, обещать ли «попробуй снова»
function showGone(kind, text = "") {
  showLanding("gone");
  const copy = core.goneCopy(kind, text);
  $("gone-text").textContent = copy.title;
  $("gone-sub").textContent = copy.sub;
}

function setOnline(on) {
  S.online = on;
  show($("net"), !on && S.wsWanted);
}

const handlers = {
  hello(m) {
    S.retry = 0;
    if (m.user) S.user = m.user;
    renderAccountButton();
    setOnline(true);
    clock.start();
    reporter.reset(); S.resend = true;
    // relay: 1 — страница умеет брать треки Яндекса с сервера комнаты (их туда заливает участник с Плюсом)
    wsSend({ t: "join", code: S.code, ym: false, relay: 1 });
  },
  pong(m) { clock?.onPong(m); },
  me(m) { if (m.user) { S.user = m.user; renderMembers(); renderControls(); renderAccountButton(); } },
  room(m) { if (m.room && m.room.code === S.code) onRoom(m.room); },
  chatlog(m) { S.chat = Array.isArray(m.chat) ? m.chat.slice(-core.CHAT_KEEP) : []; renderChat(); },
  chat(m) {
    if (!m.msg) return;
    S.chat = core.pushChat(S.chat, m.msg);
    appendChat(m.msg);
  },
  reaction(m) {
    const msg = S.chat.find((x) => x.id === m.id);
    if (!msg) return;
    msg.reactions = m.reactions;
    const node = [...$("chat").children].find((n) => n.dataset.id === String(m.id));
    if (node) node.replaceWith(msgNode(msg)); else renderChat(true);
  },
  error(m) {
    if (m.gone) showGone("error", m.error);
    else if (m.error) toast(upperFirst(m.error));
  },
  kicked() { showGone("kicked"); },
  deleted() { showGone("deleted"); },
  // команда Flow пересинхронизировала комнату: свежие часы и заново встаём на позицию комнаты, как в приложении
  resync() {
    if (!player || !S.room) return;
    clock?.start();
    if (!player.resync()) { player.reload(); onRoom(S.room); }
    toast("Команда Flow пересинхронизировала комнату");
  },
};

// ---------- комната ----------

function enterRoom() {
  show($("landing"), false); show($("top"), false); show($("listen-view"), true);
  document.body.classList.add("in-room");
  S.room = null; S.chat = []; S.retry = 0;
  $("l-code").textContent = S.code;
  $("l-room-name").textContent = $("room-title").textContent || `Комната ${S.code}`;
  $("np-title").textContent = "Подключаюсь к комнате…";
  $("np-artists").textContent = "";
  renderChat(); renderMembers(); renderUpNext(); renderControls(); renderNow(); renderAccountButton();
  connect();
}

// цель плеера по снимку комнаты. Текущего трека в браузере нет, но идёт переход с играющего — его доигрываем до конца перехода
function applyTarget() {
  const room = S.room;
  clearTimeout(S.holdTimer);
  S.hold = null;
  if (!room || !player) return;
  const { target } = core.roomTarget(room, stickyPrev());
  const hold = !target && S.pick?.unplayable && clock ? core.outgoingHold(room, S.target, clock.server()) : null;
  const next = hold ? hold.target : target;
  player.set(next);
  S.target = next;
  player.keepOnly(core.keepKeys(room, next));
  S.hold = hold;
  if (hold) {
    fadeOut(hold);
    S.holdTimer = setTimeout(applyTarget, Math.max(50, hold.until - clock.server() + 50));
  }
}

// уходящий трек затихает за время перехода, как в приложении (там его глушит появление следующего, а следующего у нас нет)
function fadeOut(hold) {
  try {
    if (!player.exit || player.target?.qid !== hold.target.qid) return;
    const start = player.ctxAtPerf(clock.perfFor(hold.from - player.latencyMs));
    player.fade(player.exit.gain, 1, 0, start, start + (hold.until - hold.from) / 1000);
  } catch { /* не вышло — просто доиграет до конца перехода */ }
}

// прошлая цель плеера для roomTarget: играющую общедоступную версию не меняем посреди песни — если она не сломалась
const stickyPrev = () => (S.trackError && S.target && S.trackError.qid === S.target.qid ? null : S.target);

// трек с сервера комнаты не загрузился (заливка оборвалась, 504, сервер перезапустили), а он всё ещё там, или только
// что туда вернулся — плеер сам тот же трек не перезагрузит. Сбрасываем подпись: следующий set грузит заново и встаёт на нужное место
function retryRelay(prev = null) {
  if (!player || !S.room || !S.target) return false;
  const due = core.relayRetryDue({ prev, room: S.room, target: S.target, err: S.trackError, tries: S.relayTries });
  if (!due) return false;
  const n = S.relayTries?.qid === S.target.qid ? S.relayTries.n : 0;
  S.relayTries = { qid: S.target.qid, n: n + (due === "again" ? 1 : 0) };
  S.trackError = null;
  player.reload();
  return true;
}

function onRoom(room) {
  const prev = S.room;
  S.room = room;
  const { target, item, alt, unplayable } = core.roomTarget(room, stickyPrev());
  S.pick = { item, alt, unplayable, track: target?.track || item?.track || null };
  retryRelay(prev);
  applyTarget();
  const errQid = core.unplayableErrorQid(room);
  if (errQid) {
    reporter.report(errQid, "error");
    S.lastStatus = { qid: errQid, status: "error" };
  }
  // после переподключения сервер не помнит наш статус текущего трека — напоминаем
  if (S.resend) {
    S.resend = false;
    const last = S.lastStatus;
    // «ошибку» за трек из Яндекса на паузе не напоминаем — она уйдёт, когда комната заиграет
    if (last && item && last.qid === item.qid && !(unplayable && !errQid)) reporter.report(last.qid, last.status);
  }
  document.title = `${room.name || `Комната ${S.code}`} — Flow`;
  $("l-room-name").textContent = room.name || `Комната ${S.code}`;
  renderNow(); renderUpNext(); renderMembers(); renderControls();
  if (S.chat.length) refreshChatNames();
}

function me() { return core.selfMember(S.room, S.user?.id); }

function renderNow() {
  const room = S.room, pick = S.pick, pb = room?.playback;
  const t = pick?.track;
  const ended = !!pb?.ended;
  if (!room) {
    setImg($("np-cover"), $("np-cover-ph"), "");
    show($("np-alt"), false); show($("np-msg"), false);
    return;
  }
  if (!t || ended) {
    $("np-title").textContent = ended ? "Очередь закончилась" : "Сейчас ничего не играет";
    $("np-artists").textContent = "Когда в комнате включат трек, он заиграет и у тебя.";
    setImg($("np-cover"), $("np-cover-ph"), "");
    setBackdrop("");
  } else {
    $("np-title").textContent = t.title || "Без названия";
    $("np-artists").textContent = t.artists || "";
    setImg($("np-cover"), $("np-cover-ph"), t.cover);
    setBackdrop(t.cover);
  }
  const altOn = !!(pick?.alt && t && !ended);
  show($("np-alt"), altOn);
  if (altOn) { $("np-alt").textContent = core.altNote(t); $("np-alt").title = core.ALT_TITLE; }
  let msg = "", warn = false;
  if (pick?.unplayable && !ended) { msg = core.YM_ONLY_TEXT; warn = true; }
  else if (trackFailed() && !ended) { msg = S.trackError.text; warn = true; }
  else if (t && pb?.paused && !ended) msg = "На паузе";
  $("np-msg").textContent = msg;
  $("np-msg").classList.toggle("warn", warn);
  show($("np-msg"), !!msg);
  updateMedia();
  tickUi();
}

function renderControls() {
  const can = !!me()?.canControl;
  show($("ctl"), can);
  show($("ctl-note"), !can && !!S.room);
  const paused = !!S.room?.playback?.paused || !!S.room?.playback?.ended;
  const toggle = $("toggle");
  setIcon(toggle, paused ? "play" : "pause");
  toggle.setAttribute("aria-label", paused ? "Играть" : "Пауза");
  toggle.title = paused ? "Играть" : "Пауза";
}

function renderUpNext() {
  const list = $("upnext");
  list.replaceChildren();
  const items = core.upcoming(S.room, 3);
  if (!items.length) { list.appendChild(el("li", "empty", S.room ? "В очереди больше ничего нет" : "Загружаю…")); return; }
  for (const it of items) {
    const li = el("li", "track-row");
    const img = el("img", "thumb"); img.alt = ""; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
    const ph = el("span", "thumb ph"); ph.appendChild(icon("note"));
    const src = core.mediaUrl(it.track?.cover, API);
    if (src) { img.src = src; img.onerror = () => img.replaceWith(ph); li.appendChild(img); } else li.appendChild(ph);
    const text = el("div", "tr-text");
    text.appendChild(el("b", "", it.track?.title || "Без названия"));
    text.appendChild(el("span", "", it.track?.artists || ""));
    if (it.ymOnly) text.appendChild(el("span", "tag", core.YM_ONLY_TAG));
    else if (it.alt) text.appendChild(el("span", "tag", core.altNote(it.track, true)));
    li.appendChild(text);
    list.appendChild(li);
  }
}

function avatarNode(u, cls = "av") {
  const box = el("span", cls);
  box.style.setProperty("--c", core.safeColor(u?.color));
  const src = core.mediaUrl(u?.avatar, API);
  const letters = el("span", "av-letters", core.initials(u?.display || u?.username));
  box.appendChild(letters);
  if (src) {
    const img = el("img"); img.alt = ""; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
    img.onerror = () => img.remove();
    img.src = src; box.appendChild(img);
  }
  return box;
}

function renderMembers() {
  const list = $("members");
  list.replaceChildren();
  const members = S.room?.members || [];
  $("m-count").textContent = members.length ? String(members.length) : "";
  for (const m of members) {
    const li = el("li", "member");
    li.appendChild(avatarNode(m));
    const name = el("span", "m-name", m.display || m.username || "Без имени");
    li.appendChild(name);
    if (m.id === S.room.ownerId) li.appendChild(el("span", "tag", "ведёт"));
    if (m.id === S.user?.id) li.appendChild(el("span", "tag you", "это ты"));
    if (m.status === "error") li.appendChild(el("span", "tag bad", "не играет"));
    list.appendChild(li);
  }
  if (!members.length) list.appendChild(el("li", "empty", S.room ? "Пока никого" : "Загружаю…"));
}

// ---------- чат ----------

function chatUser(m) {
  return (S.room?.members || []).find((x) => x.id === m.user?.id) || m.user || {};
}

function msgNode(m) {
  const node = el("div", "msg");
  node.dataset.id = String(m.id ?? "");
  if (m.system) { node.classList.add("sys"); node.textContent = m.text || ""; return node; }
  const u = chatUser(m);
  if (u.id === S.user?.id) node.classList.add("me");
  node.appendChild(avatarNode(u, "av small"));
  const body = el("div", "bub");
  const meta = el("div", "meta");
  meta.appendChild(el("b", "who", u.display || u.username || "Без имени"));
  const time = core.clockTime(m.at);
  if (time) meta.appendChild(el("time", "", time));
  body.appendChild(meta);
  body.appendChild(el("p", "text", m.text || ""));
  const row = el("div", "reacts");
  for (const r of core.reactionChips(m, S.user?.id)) {
    const b = el("button", `react${r.count ? " has" : ""}${r.mine ? " mine" : ""}`);
    b.type = "button";
    b.dataset.react = r.key; b.dataset.id = String(m.id);
    b.setAttribute("aria-pressed", String(r.mine));
    b.setAttribute("aria-label", `${r.label}${r.count ? `: ${r.count}` : ""}`);
    b.title = r.label;
    b.appendChild(icon(r.key));
    if (r.count) b.appendChild(el("span", "", String(r.count)));
    row.appendChild(b);
  }
  body.appendChild(row);
  node.appendChild(body);
  return node;
}

const chatAtBottom = () => { const c = $("chat"); return c.scrollHeight - c.scrollTop - c.clientHeight < 60; };

function renderChat(keepScroll = false) {
  const c = $("chat"), atEnd = chatAtBottom(), top = c.scrollTop;
  c.replaceChildren(...S.chat.map(msgNode));
  if (!S.chat.length) c.appendChild(el("div", "empty", S.room ? "В чате пока тихо — напиши первым" : "Загружаю чат…"));
  c.scrollTop = keepScroll && !atEnd ? top : c.scrollHeight;
}

function appendChat(m) {
  const c = $("chat");
  const stick = chatAtBottom() || m.user?.id === S.user?.id;
  c.querySelector(".empty")?.remove();
  c.appendChild(msgNode(m));
  while (c.children.length > core.CHAT_KEEP) c.firstElementChild.remove();
  if (stick) c.scrollTop = c.scrollHeight;
}

let namesSig = "";
function refreshChatNames() {
  const sig = JSON.stringify((S.room?.members || []).map((u) => [u.id, u.display, u.avatar]));
  if (sig === namesSig) return;
  namesSig = sig;
  renderChat(true);  // имена и аватарки берём из участников — обновились, перерисовываем, не сбивая прокрутку
}

// ---------- прогресс, синхронизация, медиапанель ----------

function tickUi() {
  const room = S.room, item = core.currentItem(room), pb = room?.playback;
  if (S.hold && player?.exit && player.exit !== S.holdExit) { S.holdExit = player.exit; fadeOut(S.hold); }
  const dur = Number(item?.track?.durationMs) || 0;
  const pos = room && clock ? core.positionMs(room, clock.server()) : 0;
  $("np-pos").textContent = core.formatTime(item ? pos : 0);
  $("np-dur").textContent = core.formatTime(dur);
  $("np-fill").style.width = `${dur ? Math.min(100, (pos / dur) * 100) : 0}%`;
  const sync = $("sync");
  const label = core.syncPill({ room, pick: S.pick, failed: trackFailed(), loading: !player?.src, atEnd: !!dur && pos >= dur, errorMs: player?.errorMs });
  if (label) {
    if (sync.textContent !== label.text) sync.textContent = label.text;
    sync.className = `sync ${label.cls}`;
  }
  show(sync, !!label);
  // следующий трек распаковываем заранее, за 25 с до конца — по состоянию комнаты, даже если текущий у нас не играет.
  // План перехода движок готовит сам, но только пока что-то играет
  if (player && item && pb && !pb.paused && !pb.ended && dur && dur - pos <= 25000 && (!pb.next || !player.src)) {
    const next = core.nextPlayable(room);
    if (next && prefetch.want(next.key, player.buffers.has(next.key))) {
      prefetch.start(next.key);
      player.buffer(next).then(() => prefetch.finish(next.key, true), () => prefetch.finish(next.key, false));
    }
  }
}

const trackFailed = () => !!(S.trackError && S.pick?.item && S.trackError.qid === S.pick.item.qid);

function updateMedia() {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession, t = S.pick?.track, pb = S.room?.playback;
  const playing = !!(t && pb && !pb.paused && !pb.ended && !S.pick?.unplayable);
  const cover = core.mediaUrl(t?.cover, API);
  const sig = t ? `${t.key}|${t.title}|${t.artists}|${cover}|${S.room?.name}` : "";
  try {
    if (sig !== S.mediaSig) {
      S.mediaSig = sig;
      ms.metadata = t && window.MediaMetadata ? new MediaMetadata({
        title: t.title || "", artist: t.artists || "", album: S.room?.name || "Flow",
        artwork: cover ? [{ src: cover, sizes: "400x400" }] : [],
      }) : null;
    }
    ms.playbackState = playing ? "playing" : t ? "paused" : "none";
    if (npAudio) { if (playing) npAudio.play().catch(() => {}); else npAudio.pause(); }
    const can = !!me()?.canControl;
    const set = (action, fn) => { try { ms.setActionHandler(action, can ? fn : null); } catch { /* не поддерживается */ } };
    set("play", () => wsSend({ t: "play" }));
    set("pause", () => wsSend({ t: "pause" }));
    set("nexttrack", () => wsSend({ t: "next" }));
  } catch { /* медиапанель — необязательно */ }
}

function clearMedia() {
  if (!("mediaSession" in navigator)) return;
  try { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = "none"; } catch { /* нет */ }
  S.mediaSig = "";
}

let backdropUrl = null;
function setBackdrop(url) {
  const src = core.mediaUrl(url, API);
  if (src === backdropUrl) return;
  backdropUrl = src;
  const b = $("backdrop");
  b.style.backgroundImage = src ? `url("${src.replace(/["\\\n]/g, "\\$&")}")` : "";
  b.classList.toggle("on", !!src);
}

// ---------- запуск ----------

function init() {
  if (!S.code) { show($("ok"), false); show($("bad"), true); return; }
  $("code").textContent = S.code;
  document.title = `Комната ${S.code} — Flow`;
  $("open").href = `flow://room/${S.code}`;
  show($("listen"), true);
  $("listen").addEventListener("click", onListen);
  $("tab-login").addEventListener("click", () => setMode("login"));
  $("tab-register").addEventListener("click", () => setMode("register"));
  $("go-login").addEventListener("click", () => switchMode("login"));
  $("go-register").addEventListener("click", () => switchMode("register"));
  $("go-guest").addEventListener("click", () => switchMode("guest"));
  $("auth").addEventListener("submit", onAuthSubmit);
  $("auth-cancel").addEventListener("click", hideAuth);
  $("gone-back").addEventListener("click", () => { showLanding("ok"); hideAuth(); loadInfo(); });
  $("leave").addEventListener("click", () => { showLanding("ok"); loadInfo(); });
  $("logout").addEventListener("click", logout);
  $("toggle").addEventListener("click", () => wsSend({ t: S.room?.playback?.paused || S.room?.playback?.ended ? "play" : "pause" }));
  $("next").addEventListener("click", () => wsSend({ t: "next" }));
  $("volume").addEventListener("input", (e) => {
    S.volume = Math.max(0, Math.min(1, Number(e.target.value) / 100));
    if (S.volume > 0) S.muted = false;
    store.set(core.VOLUME_KEY, S.volume.toFixed(2)); store.set(core.MUTED_KEY, S.muted ? "1" : "0");
    applyVolume();
  });
  $("mute").addEventListener("click", () => {
    const v = core.toggleMute(S);
    if (v.volume !== S.volume) { S.volume = v.volume; store.set(core.VOLUME_KEY, S.volume.toFixed(2)); }
    S.muted = v.muted;
    store.set(core.MUTED_KEY, S.muted ? "1" : "0");
    applyVolume();
  });
  $("chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("chat-input"), text = core.cleanChatText(input.value);
    if (!text) return;
    if (!S.online) { toast("Нет связи с сервером — сообщение не ушло"); return; }
    wsSend({ t: "chat", text });
    input.value = "";
  });
  $("chat").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-react]");
    if (!b) return;
    const id = S.chat.find((m) => String(m.id) === b.dataset.id)?.id;
    if (id !== undefined) wsSend({ t: "reaction", id, key: b.dataset.react });
  });
  applyVolume();
  setMode("guest");
  setInterval(() => { if (S.room) tickUi(); }, 250);
  // снимка комнаты может и не прийти, а повторить загрузку трека с сервера комнаты пора — проверяем сами
  setInterval(() => { if (retryRelay()) { applyTarget(); renderNow(); } }, 1000);
  loadInfo();
}

init();
