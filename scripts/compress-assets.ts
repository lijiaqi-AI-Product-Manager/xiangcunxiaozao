// P3 第④项·出图侧：生图管线批量出的菜品图，统一压到 300KB 以内（09号 §五.5）。
// 默认只出报告、不改文件；加 --write 才压缩，而且**原路径、原格式写回**——菜单数据里的图片路径一个字不用改（数据层零改动）。
// 用法：npm run compress:assets            （只看哪些图超标）
//       npm run compress:assets -- --write （真正压缩）
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const TARGET_BYTES = 300 * 1024;
const MAX_EDGE = 1600;
const QUALITIES = [86, 78, 70, 62, 54, 46];
// PNG 走调色板量化，单次编码慢得多：档位少一点、effort 取 3（实测和 8 的体积几乎一样，快 6 倍）
const PNG_QUALITIES = [80, 65, 50, 40];
const EXT = /\.(jpe?g|png|webp)$/i;

export interface Result { file: string; before: number; after: number; ok: boolean; changed: boolean; webpHint?: number }

/** 压一张图：先降质量，还不够就把最长边缩到 80% 再来，最多三轮；格式不变 */
export async function compressBuffer(input: Buffer, ext: string): Promise<Buffer> {
  if (input.length <= TARGET_BYTES) return input;
  const meta = await sharp(input).metadata();
  let edge = Math.min(MAX_EDGE, Math.max(meta.width ?? MAX_EDGE, meta.height ?? MAX_EDGE));
  let best = input;
  for (let round = 0; round < 3 && best.length > TARGET_BYTES; round++) {
    const kind = ext.toLowerCase();
    for (const q of kind === '.png' ? PNG_QUALITIES : QUALITIES) {
      const img = () => sharp(input).rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true });
      // PNG 调色板量化时，抖动（dither）会在平滑渐变上「加噪点」反而变大；有抖动、无抖动各试一次取小的
      const outs = kind === '.png'
        ? await Promise.all([1, 0].map((dither) => img().png({ palette: true, quality: q, compressionLevel: 9, effort: 3, dither }).toBuffer()))
        : [kind === '.webp' ? await img().webp({ quality: q, effort: 5 }).toBuffer() : await img().jpeg({ quality: q, mozjpeg: true }).toBuffer()];
      for (const out of outs) if (out.length < best.length) best = out;
      if (best.length <= TARGET_BYTES) break;
    }
    edge = Math.round(edge * 0.8);
  }
  return best;
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (EXT.test(name)) yield p;
  }
}

export async function compressDir(dir: string, write: boolean): Promise<Result[]> {
  if (!existsSync(dir)) return [];
  const results: Result[] = [];
  for (const file of walk(dir)) {
    const input = readFileSync(file);
    if (input.length <= TARGET_BYTES) { results.push({ file, before: input.length, after: input.length, ok: true, changed: false }); continue; }
    const out = await compressBuffer(input, extname(file));
    if (write && out.length < input.length) writeFileSync(file, out);
    const ok = out.length <= TARGET_BYTES;
    // 保持原格式压不下来（多见于带颗粒的照片存成 PNG）：估一下转 WebP 能到多大，供改导入单时参考
    const webpHint = ok ? undefined
      : (await sharp(input).resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true }).webp({ quality: 70 }).toBuffer()).length;
    results.push({ file, before: input.length, after: out.length, ok, changed: out.length < input.length, webpHint });
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const brandId = process.env.BRAND;
  if (!brandId) throw new Error('缺少 BRAND 环境变量（见根目录 .env）');
  const dir = resolve('brands', brandId, 'assets');
  const write = process.argv.includes('--write');
  const results = await compressDir(dir, write);
  const kb = (n: number) => `${Math.round(n / 1024)}KB`;
  if (!results.length) {
    console.log(`还没有菜品图（${relative('.', dir)} 不存在或是空的），无需压缩`);
  } else {
    const over = results.filter((r) => r.before > TARGET_BYTES);
    for (const r of over) console.log(`${r.ok ? '✅' : '⚠'} ${relative(dir, r.file)}：${kb(r.before)} → ${kb(r.after)}${r.ok ? '' : `（保持原格式压不到 300KB；转成 WebP 约 ${kb(r.webpHint ?? 0)}，需要在导入单里改路径）`}`);
    console.log(`${results.length} 张图，超标 ${over.length} 张；${write ? '已写回原文件' : '只是报告，加 --write 才会改文件'}`);
    if (over.some((r) => !r.ok)) process.exitCode = 1;
  }
}
