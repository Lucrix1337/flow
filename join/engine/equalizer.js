export const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_PRESETS = {
  flat: { name: "Ровно", gains: [0,0,0,0,0,0,0,0,0,0] },
  pop: { name: "Поп", gains: [1,2,2,0,-1,-1,1,2,2,1] },
  rock: { name: "Рок", gains: [3,3,2,0,-1,0,1,2,3,3] },
  electronic: { name: "Электроника", gains: [4,3,1,0,-2,0,1,2,3,2] },
  vocal: { name: "Вокал", gains: [-2,-1,0,1,2,3,2,1,0,-1] },
};
const number = (value, min, max) => typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : 0;
export function normalizeEq(value) {
  return { enabled: value?.enabled === true, preset: Object.hasOwn(EQ_PRESETS, value?.preset) ? value.preset : value == null ? "flat" : "custom",
    gains: EQ_BANDS.map((_,i) => number(value?.gains?.[i],-12,12)), preamp: number(value?.preamp,-12,0) };
}

// A single graph follows the existing volume node. Playback clocks are unchanged.
export function createEqualizer(ctx, destination) {
  const input = ctx.createGain();
  const preamp = ctx.createGain();
  const filters = EQ_BANDS.map((frequency,i) => {
    const filter=ctx.createBiquadFilter();
    filter.type=i===0 ? "lowshelf" : i===EQ_BANDS.length-1 ? "highshelf" : "peaking";
    filter.frequency.value=Math.min(frequency,ctx.sampleRate*.48);
    filter.Q.value=1;
    return filter;
  });
  let previous=input;
  for(const filter of filters){previous.connect(filter);previous=filter;}
  previous.connect(preamp);preamp.connect(destination);
  return { input,
    set(value) {
      const eq=normalizeEq(value);
      filters.forEach((filter,i)=>filter.gain.setTargetAtTime(eq.enabled ? eq.gains[i] : 0,ctx.currentTime,.025));
      preamp.gain.setTargetAtTime(eq.enabled ? 10**(eq.preamp/20) : 1,ctx.currentTime,.025);
      return eq;
    },
  };
}
