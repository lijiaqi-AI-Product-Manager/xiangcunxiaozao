// 小样六轮定下的动效（54号：原样进主程序）。全部只动 transform / opacity，交给合成线程跑；
// 档位看 html[data-tier]：normal / minimal / lite / static（static = 系统「减弱动态效果」）
export type Tier = 'normal' | 'minimal' | 'lite' | 'static';
const root = () => document.documentElement;
export const tier = (): Tier => (root().dataset.tier as Tier) || 'normal';
export const moving = () => tier() !== 'static';
const canAnimate = () => typeof document.body.animate === 'function';

/** 首秒实测帧率 < 45 自动降一档（38号 4.2 性能分档；用 ?tier= 强制时不降） */
let watching = false;
export function watchFrameRate() {
  // 只测一次（开发模式下 React 会把副作用跑两遍，不能连降两档）
  if (watching || root().dataset.forced || (tier() !== 'normal' && tier() !== 'minimal')) return;
  watching = true;
  let frames = 0;
  const t0 = performance.now();
  const tick = (t: number) => {
    frames++;
    if (t - t0 < 1000) { requestAnimationFrame(tick); return; }
    if (frames < 45) root().dataset.tier = tier() === 'normal' ? 'minimal' : 'lite';
  };
  requestAnimationFrame(tick);
}

/** 落点一团柔光扩散（51号：替代斜向扫光）——漫反射的光晕，0.5 秒 */
export function landGlow(x: number, y: number) {
  if (!moving() || !canAnimate()) return;
  const g = document.createElement('span');
  g.className = 'land-glow';
  g.style.left = `${x}px`;
  g.style.top = `${y}px`;
  document.body.appendChild(g);
  g.animate([{ transform: 'scale(0)', opacity: 0.35 }, { transform: 'scale(1.4)', opacity: 0 }], { duration: 500, easing: 'cubic-bezier(.2,.7,.3,1)' })
    .finished.then(() => g.remove(), () => g.remove());
}

/** 角标弹一下，1.5 秒后回到静默态 */
export function popBadge() {
  document.querySelectorAll<HTMLElement>('[data-count]').forEach((b) => {
    b.classList.remove('pop');
    void b.offsetWidth;
    b.classList.add('pop');
    setTimeout(() => b.classList.remove('pop'), 1500);
  });
}

/** 购物车角标的落点：托盘已经出来了就用它的角标；还在弹入（首菜）就用托盘弹入后角标会在的位置 */
function cartTarget(): { x: number; y: number } {
  const badge = [...document.querySelectorAll<HTMLElement>('.cartbar [data-count], .dbar [data-count]')].find((b) => b.getBoundingClientRect().width > 0);
  if (badge) {
    const r = badge.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  const w = Math.min(window.innerWidth - 32, 398);
  return { x: (window.innerWidth - w) / 2 + 8 + 8 + 11, y: window.innerHeight - 84 - 28 };
}

/**
 * 47号水滴「+1」：从加号挤出（压扁 → 回弹）、沿弧线飞向购物车角标（横向、纵向分开缓动 = 抛物线）、落下压扁消失，落点一团柔光。
 * 三层元素各管一件事：外层横移、中层上抛下落、里层水滴形变。返回 false = 没有飞（减弱动态效果），调用方自己马上弹角标
 */
export function flyBlob(from: Element): boolean {
  if (!moving() || !canAnimate()) return false;
  const a = from.getBoundingClientRect();
  const x0 = a.left + a.width / 2, y0 = a.top + a.height / 2 - 4;
  const el = document.createElement('span');
  el.className = 'blob';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<i><b>+1</b></i>';
  document.body.appendChild(el);
  const mid = el.firstChild as HTMLElement, drop = mid.firstChild as HTMLElement;
  // 终点在起飞后 140ms 再取：首菜时托盘这时已经开始弹入
  const timing: KeyframeAnimationOptions = { duration: 860, delay: 120, fill: 'both' }; // 56号：水滴看得更清楚——飞得稍慢、抛得稍高
  let { x, y } = cartTarget();
  const dx = () => x - x0, dy = () => y - y0;
  const run = () => {
    ({ x, y } = cartTarget());
    el.animate([{ transform: `translate(${x0}px,${y0}px)` }, { transform: `translate(${x0 + dx()}px,${y0}px)` }], { ...timing, easing: 'cubic-bezier(.45,0,.7,1)' });
    mid.animate([
      { transform: 'translateY(0)', easing: 'cubic-bezier(.2,.75,.4,1)' },
      { transform: 'translateY(-88px)', offset: 0.36, easing: 'cubic-bezier(.6,0,.85,.55)' },
      { transform: `translateY(${dy()}px)` },
    ], timing);
    drop.animate([
      { transform: 'scale(.3)', opacity: 0 },
      { transform: 'scale(1.28,.78)', opacity: 1, offset: 0.12 },
      { transform: 'scale(.9,1.12)', opacity: 1, offset: 0.24 },
      { transform: 'scale(1)', opacity: 1, offset: 0.36 },
      { transform: 'scale(1.15,.85)', opacity: 1, offset: 0.52 }, // 48号抛光③：下落途中拉成拖尾形
      { transform: 'scale(1.15,.85)', opacity: 1, offset: 0.78 },
      { transform: 'scale(1)', opacity: 1, offset: 0.86 },
      { transform: 'scale(1.32,.68)', opacity: 1, offset: 0.93 },
      { transform: 'scale(.4)', opacity: 0 },
    ], timing).finished.then(() => { el.remove(); popBadge(); landGlow(x, y); }, () => el.remove());
  };
  requestAnimationFrame(run);
  return true;
}

/**
 * 53号（高斯）+ 54号 问题一：手指 / 鼠标点到哪里，哪里盖一枚红色小圆戳——和店标是同一个组件（.seal.sm），字从品牌配置来。
 * 56号 高斯：「停留时间再多停顿一会，现在有点看不太出来」——盖下去（0.16 秒，按到 .96 再弹回）→ 停住约 0.8 秒 → 0.35 秒淡掉，共 1.3 秒；
 * 减弱动态效果下不动，出现 0.9 秒再消失
 */
export const TAP_SEAL_MS = 1300;
export function installTapSeal(char: string) {
  const on = (e: PointerEvent) => {
    if (e.button > 0 || !e.isPrimary) return;
    const s = document.createElement('span');
    s.className = 'seal sm tap-seal';
    s.setAttribute('aria-hidden', 'true');
    s.textContent = char;
    s.style.left = `${e.clientX}px`;
    s.style.top = `${e.clientY}px`;
    document.body.appendChild(s);
    if (moving() && canAnimate()) {
      // 缓动只写在每一段上（整条动画是线性时间轴）：之前整条再套一个缓出曲线，停住的那段被压缩到前面，看起来一闪就没
      s.animate([
        { transform: 'scale(1.35) rotate(-20deg)', opacity: 0, easing: 'cubic-bezier(.2,.9,.3,1.2)' },
        { transform: 'scale(.96) rotate(-8deg)', opacity: 1, offset: 0.12, easing: 'ease-out' },
        { transform: 'scale(1) rotate(-8deg)', opacity: 1, offset: 0.2 },
        { transform: 'scale(1) rotate(-8deg)', opacity: 1, offset: 0.73, easing: 'ease-in' },
        { transform: 'scale(1) rotate(-8deg)', opacity: 0 },
      ], { duration: TAP_SEAL_MS }).finished.then(() => s.remove(), () => s.remove());
    } else {
      s.style.opacity = '1';
      s.style.transform = 'rotate(-8deg)';
      setTimeout(() => s.remove(), 900);
    }
  };
  document.addEventListener('pointerdown', on, { passive: true });
  return () => document.removeEventListener('pointerdown', on);
}

/** 一段文字按标点切成一句一句（墨迹渐显用） */
export const inkSentences = (text: string) => text.split(/(?<=[，。！？；：])/).filter(Boolean);
