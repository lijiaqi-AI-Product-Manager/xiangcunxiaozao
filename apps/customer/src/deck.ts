// 54号 问题三「真堆叠」的位置计算（纯函数，单元测试覆盖）。
// 每张卡只看一个数：d = 它的序号 − 当前进度 p（拖动时 p 是小数）。同一个 p 同时决定所有卡的位置，
// 所以上面那张滑出去多少，下面的就跟上来多少——不存在「静态底板 + 单卡移动」。

export const PEEK = 14; // 后面每张卡在右边露出的宽度（px）
export const DEPTH = 3; // 最多看得见几层（含最前那张）
const SHRINK = 0.06; // 往后一层缩小多少（以右边为原点缩，露边不变）
const SHADE = 0.22; // 往后一层盖多浓的纸色（越往后越淡）

export interface CardPose { x: number; scale: number; opacity: number; shade: number; z: number }

/**
 * @param k 卡的序号  @param p 当前进度（0 = 第一张在最前；拖到一半 = 0.5）  @param width 最前那张卡的宽度
 */
export function pose(k: number, p: number, width: number): CardPose {
  const d = k - p;
  if (d < 0) {
    // 已经翻过去的：整张向左滑出（多走 24px，阴影也出画），越走越淡
    const t = Math.max(d, -1);
    return { x: t * (width + 24), scale: 1, opacity: 1 + t * 0.35, shade: 0, z: 100 + Math.round(t * 10) };
  }
  const depth = Math.min(d, DEPTH - 1);
  // 第 DEPTH 层以后的卡藏在最后一层后面，快轮到时才淡入
  const extra = Math.max(0, d - (DEPTH - 1));
  return { x: depth * PEEK, scale: 1 - depth * SHRINK, opacity: Math.max(0, 1 - extra), shade: depth * SHADE, z: 50 - Math.round(d * 10) };
}

export const transformOf = (c: CardPose) => `translate3d(${c.x.toFixed(2)}px,0,0) scale(${c.scale.toFixed(4)})`;

/** 拖过头的阻尼：到了第一张 / 最后一张还往外拉，只走三成 */
export function rubber(p: number, count: number): number {
  const max = count - 1;
  if (p < 0) return p * 0.3;
  if (p > max) return max + (p - max) * 0.3;
  return p;
}

/** 松手判定：拖过卡宽 22% 或甩得够快（> 0.35 px/ms）就翻一张，否则回弹 */
export function settle(from: number, dx: number, velocity: number, width: number, count: number): number {
  let to = from;
  if (dx < -width * 0.22 || velocity < -0.35) to = from + 1;
  else if (dx > width * 0.22 || velocity > 0.35) to = from - 1;
  return Math.max(0, Math.min(count - 1, to));
}

/** 右边要给后面的卡留多宽（只有一张就不留） */
export const peekRoom = (count: number) => (Math.min(count, DEPTH) - 1) * PEEK;
