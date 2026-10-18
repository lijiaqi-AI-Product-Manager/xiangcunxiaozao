/**
 * 新单提示音。浏览器规定：网页必须先被人点过一次，才允许发声（自动播放限制）。
 * 所以老板端每次打开要先点「开始接单」——这一下就是用来解锁声音的（22号修正2）。
 * 声音用浏览器现场合成，不依赖音频文件。
 */
let ctx: AudioContext | null = null;

export async function unlockChime(): Promise<boolean> {
  try {
    ctx ??= new AudioContext();
    await ctx.resume();
    playChime();
    return ctx.state === 'running';
  } catch {
    return false;
  }
}

export function chimeReady() {
  return ctx?.state === 'running';
}

export function playChime() {
  if (!ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  for (const [i, freq] of [880, 1175].entries()) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + i * 0.18);
    gain.gain.exponentialRampToValueAtTime(0.4, t0 + i * 0.18 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.18 + 0.16);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + i * 0.18);
    osc.stop(t0 + i * 0.18 + 0.17);
  }
}
