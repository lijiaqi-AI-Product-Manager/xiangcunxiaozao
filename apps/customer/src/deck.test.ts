// 54号 问题三「真堆叠」：同一个进度 p 决定所有卡的位置——上面那张走多少，下面的就补多少；堆叠在右边
import { describe, expect, it } from 'vitest';
import { PEEK, peekRoom, pose, rubber, settle } from './deck.ts';

const W = 320;

describe('真堆叠的位置', () => {
  it('停着时：最前那张在原位，后面两张叠在右边各露 14px，越往后越小越淡，再往后的藏起来', () => {
    const [a, b, c, d] = [0, 1, 2, 3].map((k) => pose(k, 0, W));
    expect(a).toMatchObject({ x: 0, scale: 1, opacity: 1, shade: 0 });
    expect(b!.x).toBe(PEEK);
    expect(c!.x).toBe(PEEK * 2);
    expect(b!.scale).toBeLessThan(1);
    expect(c!.scale).toBeLessThan(b!.scale);
    expect(c!.shade).toBeGreaterThan(b!.shade);
    expect(d!.opacity).toBe(0);
    expect(a!.z).toBeGreaterThan(b!.z);
    expect(b!.z).toBeGreaterThan(c!.z);
  });

  it('拖到一半：上面那张向左走了半张，第二张同时补上来一半，第三张也跟着挪（不是静态底板）', () => {
    const half = [0, 1, 2].map((k) => pose(k, 0.5, W));
    expect(half[0]!.x).toBeCloseTo(-(W + 24) / 2);
    expect(half[1]!.x).toBeCloseTo(PEEK / 2);
    expect(half[2]!.x).toBeCloseTo(PEEK * 1.5);
    expect(half[1]!.scale).toBeGreaterThan(pose(1, 0, W).scale);
  });

  it('位置随进度连续变化：任意两次相邻采样之间没有跳变', () => {
    for (let k = 0; k < 4; k++) {
      let prev = pose(k, 0, W);
      for (let p = 0.01; p <= 3; p += 0.01) {
        const cur = pose(k, p, W);
        expect(Math.abs(cur.x - prev.x)).toBeLessThan((W + 24) * 0.011 + 0.01);
        expect(Math.abs(cur.scale - prev.scale)).toBeLessThan(0.002);
        expect(Math.abs(cur.opacity - prev.opacity)).toBeLessThan(0.011);
        prev = cur;
      }
    }
  });

  it('翻过去的卡在最上层滑出，不会从后面的卡底下穿过去', () => {
    expect(pose(0, 0.3, W).z).toBeGreaterThan(pose(1, 0.3, W).z);
    expect(pose(0, 1, W).x).toBe(-(W + 24));
  });

  it('拖过头有阻尼，松手判定：过 22% 或甩得快才翻页，两头不越界', () => {
    expect(rubber(-1, 3)).toBeCloseTo(-0.3);
    expect(rubber(3, 3)).toBeCloseTo(2.3);
    expect(rubber(1.4, 3)).toBe(1.4);
    expect(settle(0, -W * 0.3, 0, W, 3)).toBe(1);
    expect(settle(0, -W * 0.1, 0, W, 3)).toBe(0);
    expect(settle(0, -20, -0.6, W, 3)).toBe(1);
    expect(settle(2, -W, -1, W, 3)).toBe(2);
    expect(settle(0, W, 1, W, 3)).toBe(0);
    expect(settle(1, W * 0.3, 0, W, 3)).toBe(0);
  });

  it('右边留白：一张不留，两张留一层，三张及以上留两层', () => {
    expect(peekRoom(1)).toBe(0);
    expect(peekRoom(2)).toBe(PEEK);
    expect(peekRoom(5)).toBe(PEEK * 2);
  });
});
