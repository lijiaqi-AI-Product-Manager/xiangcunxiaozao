// P3 第④项·出图侧压缩：大图压到 300KB 以内、格式不变、路径不变；压不下来如实报告；小图不动；默认不改文件
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { compressDir, TARGET_BYTES } from './compress-assets.ts';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 生成一张测试图：平滑渐变 + 颗粒（grain 越大越像带噪点的照片、越难压）。固定种子，每次结果一样 */
async function image(size: number, format: 'jpeg' | 'png' | 'webp', grain: number) {
  const raw = Buffer.alloc(size * size * 3);
  let s = 0x9e3779b9;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff; };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      const base = [200 * x / size + 30, 160 * y / size + 50, 120 + 80 * Math.sin((x + y) / 90)];
      for (let c = 0; c < 3; c++) raw[i + c] = Math.max(0, Math.min(255, base[c]! + (rnd() - 0.5) * grain));
    }
  }
  const img = sharp(raw, { raw: { width: size, height: size, channels: 3 } });
  return format === 'png' ? img.png().toBuffer() : format === 'webp' ? img.webp({ quality: 100 }).toBuffer() : img.jpeg({ quality: 100 }).toBuffer();
}

describe('出图侧图片压缩（≤300KB）', () => {
  it('照片类 JPG / WebP、插画类 PNG：压到 300KB 以内，格式和文件名不变', async () => {
    dir = mkdtempSync(join(tmpdir(), 'xc-assets-'));
    const files = [['a.jpg', 'jpeg', 48], ['c.webp', 'webp', 48], ['b.png', 'png', 6]] as const;
    for (const [name, fmt, grain] of files) writeFileSync(join(dir, name), await image(1600, fmt, grain));
    expect(files.every(([name]) => statSync(join(dir, name)).size > TARGET_BYTES)).toBe(true);
    const results = await compressDir(dir, true);
    expect(results.every((r) => r.ok && r.changed)).toBe(true);
    for (const [name, fmt] of files) {
      const buf = readFileSync(join(dir, name));
      expect(buf.length).toBeLessThanOrEqual(TARGET_BYTES);
      expect((await sharp(buf).metadata()).format).toBe(fmt);
    }
  }, 60_000);

  it('压不下来的极端图（纯噪点 PNG）：如实报告 ok=false 并给出转 WebP 的估算，文件仍是 PNG', async () => {
    dir = mkdtempSync(join(tmpdir(), 'xc-assets-'));
    writeFileSync(join(dir, 'noise.png'), await image(1200, 'png', 255 * 4)); // 颗粒幅度拉满 = 纯噪点
    const [r] = await compressDir(dir, true);
    expect(r).toMatchObject({ ok: false });
    expect(r!.after).toBeGreaterThan(TARGET_BYTES);
    expect(typeof r!.webpHint).toBe('number');
    expect((await sharp(readFileSync(join(dir, 'noise.png'))).metadata()).format).toBe('png'); // 路径和格式没变
  }, 60_000);

  it('默认只报告，不改文件；本来就小的图不动', async () => {
    dir = mkdtempSync(join(tmpdir(), 'xc-assets-'));
    const big = await image(1600, 'jpeg', 48);
    const small = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 240, g: 230, b: 210 } } }).jpeg().toBuffer();
    writeFileSync(join(dir, 'big.jpg'), big);
    writeFileSync(join(dir, 'small.jpg'), small);
    const results = await compressDir(dir, false);
    expect(readFileSync(join(dir, 'big.jpg')).equals(big)).toBe(true);
    expect(results.find((r) => r.file.endsWith('small.jpg'))).toMatchObject({ changed: false, ok: true });
    expect(results.find((r) => r.file.endsWith('big.jpg'))!.after).toBeLessThanOrEqual(TARGET_BYTES);
  }, 60_000);

  it('没有图片目录时不报错', async () => {
    dir = mkdtempSync(join(tmpdir(), 'xc-assets-'));
    expect(await compressDir(join(dir, 'none'), true)).toEqual([]);
  });
});
