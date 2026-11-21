// API Flow для страницы приглашения. Для локальной проверки (только localhost / 127.0.0.1) адрес можно задать в ссылке: ?КОД&api=http://127.0.0.1:8098
window.FLOW_API = "https://api.flowww.space";
(function () {
  try {
    var host = location.hostname;
    if (host !== "localhost" && host !== "127.0.0.1") return;
    var api = new URLSearchParams(location.search).get("api");
    if (api && /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(api)) window.FLOW_API = api.replace(/\/+$/, "");
  } catch (e) { /* остаётся основной адрес */ }
})();
