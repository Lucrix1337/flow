// Выравнивание громкости: тихие и громкие треки звучат примерно одинаково.
//
// Громкость трека меряем один раз, после распаковки, по стандарту ITU-R BS.1770 / EBU R128 (LUFS) —
// так же считают Spotify и YouTube: K-фильтр (как слышит ухо), блоки по 400 мс, отсев тишины.
// Считаем кусками по несколько миллисекунд с уступкой потоку — интерфейс не подвисает.
// Результат — множитель громкости для трека: громкие тише, тихие громче, но не до перегруза (пик ≤ потолка).
// Часы и синхронизация не меняются — это просто ещё один регулятор громкости у каждого трека.

export const TARGET_LUFS = -14;     // как у Spotify (обычный режим) и YouTube
export const MAX_BOOST_DB = 6;      // тихий трек поднимаем не больше чем на 6 дБ…
export const MAX_CUT_DB = 12;       // …громкий опускаем не больше чем на 12 дБ
export const PEAK_CEILING = 0.95;   // после усиления пик не выше −0.45 dBFS — без хрипа

// коэффициенты K-фильтра (полка +4 дБ на верхах и срез ниже 38 Гц) для любой частоты дискретизации —
// вывод как в libebur128: на 48 кГц даёт ровно таблицу из BS.1770
export function kWeighting(fs) {
  const shelf = (() => {
    const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    const K = Math.tan(Math.PI * f0 / fs), Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416, a0 = 1 + K / Q + K * K;
    return { b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0],
      a: [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
  })();
  const highpass = (() => {
    const f0 = 38.13547087602444, Q = 0.5003270373238773;
    const K = Math.tan(Math.PI * f0 / fs), a0 = 1 + K / Q + K * K;
    return { b: [1, -2, 1], a: [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
  })();
  return [shelf, highpass];
}

// обычный биквад — для проверки в тестах и запасного пути без Web Audio
function biquad(input, { b, a }) {
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i], y = b[0] * x + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y; out[i] = y;
  }
  return out;
}

// уже отфильтрованные каналы → энергия по кусочкам по 100 мс (сумма квадратов по всем каналам)
export function energySlices(channels, fs) {
  const step = Math.max(1, Math.round(fs / 10));
  const n = Math.floor((channels[0]?.length || 0) / step);
  const slices = new Float64Array(n);
  for (const ch of channels) {
    for (let j = 0, i = 0; j < n; j++) {
      let sum = 0;
      for (const end = i + step; i < end; i++) sum += ch[i] * ch[i];
      slices[j] += sum / step;
    }
  }
  return slices;
}

const lufsOf = (z) => -0.691 + 10 * Math.log10(z);

// интегральная громкость: блоки 400 мс с шагом 100 мс, отсев ниже −70 LUFS и ниже среднего на 10 LU
export function gatedLoudness(slices) {
  const blocks = [];
  for (let j = 0; j + 4 <= slices.length; j++) blocks.push((slices[j] + slices[j + 1] + slices[j + 2] + slices[j + 3]) / 4);
  const loud = blocks.filter((z) => z > 0 && lufsOf(z) > -70);
  if (!loud.length) return -Infinity;
  const relative = lufsOf(loud.reduce((s, z) => s + z, 0) / loud.length) - 10;
  const kept = loud.filter((z) => lufsOf(z) > relative);
  return lufsOf(kept.reduce((s, z) => s + z, 0) / kept.length);
}

// громкость по сырым каналам (без Web Audio) — для тестов
export function integratedLoudness(channels, fs) {
  const [shelf, hp] = kWeighting(fs);
  return gatedLoudness(energySlices(channels.map((ch) => biquad(biquad(ch, shelf), hp)), fs));
}

export function samplePeak(channels) {
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) { const v = ch[i] < 0 ? -ch[i] : ch[i]; if (v > peak) peak = v; }
  return peak;
}

// уступить поток между кусками: через MessageChannel — в свёрнутом окне его не притормаживают, в отличие от setTimeout
const yieldNow = () => new Promise((resolve) => {
  if (typeof MessageChannel !== "function") return setTimeout(resolve, 0);
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = () => { port1.close(); resolve(); };
  port2.postMessage(0);
});

// замер → множитель громкости. Не знаем громкость (тишина, ошибка) — оставляем как есть
export function normalizationGain(lufs, peak, target = TARGET_LUFS) {
  if (!Number.isFinite(lufs)) return 1;
  const db = Math.max(-MAX_CUT_DB, Math.min(MAX_BOOST_DB, target - lufs));
  let gain = 10 ** (db / 20);
  if (gain > 1 && peak > 0) gain = Math.max(1, Math.min(gain, PEAK_CEILING / peak));
  return gain;
}

// замер распакованного трека: { lufs, peak }. Один проход по сэмплам: пик, K-фильтр, энергия по 100 мс. Кусками с уступкой потоку — интерфейс не замирает.
// OfflineAudioContext не берём: при передаче буфера Chromium копирует весь трек (~90 МБ) в основном потоке
export async function measureBuffer(buffer) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const rate = buffer.sampleRate;  // без прореживания: верха важны для K-фильтра
  const total = channels[0]?.length || 0;
  const step = Math.max(1, Math.round(rate / 10));          // 100 мс
  const n = Math.floor(total / step);
  const slices = new Float64Array(n);
  const [S, H] = kWeighting(rate);
  // коэффициенты — в локальные переменные: во внутреннем цикле ~23 млн шагов на 4 минуты стерео
  const sb0 = S.b[0], sb1 = S.b[1], sb2 = S.b[2], sa1 = S.a[1], sa2 = S.a[2];
  const hb0 = H.b[0], hb1 = H.b[1], hb2 = H.b[2], ha1 = H.a[1], ha2 = H.a[2];
  const state = channels.map(() => new Float64Array(8));   // x1 x2 y1 y2 для полки и для среза
  let peak = 0;
  // кусок ~0.3 с звука — пара миллисекунд работы; первые куски меньше, пока цикл ещё не разогнан JIT
  for (let from = 0, size = 1024; from < total; from += size, size = Math.min(size * 2, 1 << 13)) {
    const to = Math.min(total, from + size);
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c], st = state[c];
      let sx1 = st[0], sx2 = st[1], sy1 = st[2], sy2 = st[3], hx1 = st[4], hx2 = st[5], hy1 = st[6], hy2 = st[7], p = peak;
      let j = (from / step) | 0, left = step - (from - j * step), acc = 0;
      for (let k = from; k < to; k++) {
        const x = ch[k];
        if (x > p) p = x; else if (-x > p) p = -x;
        const y = sb0 * x + sb1 * sx1 + sb2 * sx2 - sa1 * sy1 - sa2 * sy2;
        sx2 = sx1; sx1 = x; sy2 = sy1; sy1 = y;
        const z = hb0 * y + hb1 * hx1 + hb2 * hx2 - ha1 * hy1 - ha2 * hy2;
        hx2 = hx1; hx1 = y; hy2 = hy1; hy1 = z;
        acc += z * z;
        if (--left === 0) { if (j < n) slices[j] += acc; acc = 0; j++; left = step; }
      }
      if (acc && j < n) slices[j] += acc;
      st[0] = sx1; st[1] = sx2; st[2] = sy1; st[3] = sy2; st[4] = hx1; st[5] = hx2; st[6] = hy1; st[7] = hy2; peak = p;
    }
    await yieldNow();
  }
  // моно Web Audio выводит в обе колонки — меряем его как двойное моно (как EBU_DUAL_MONO в libebur128), иначе он на 3 дБ громче стерео
  const weight = channels.length === 1 ? 2 : 1;
  for (let j = 0; j < n; j++) slices[j] = slices[j] * weight / step;
  return { lufs: n >= 4 ? gatedLoudness(slices) : -Infinity, peak };
}
