// P3 第④项·上传侧：老板端选好图片后，先在浏览器里压到 300KB 以内再上传（09号 §五.5：单图 300KB）。
// 不装任何库，用浏览器自带的画布重新编码。压不了（格式不认识、浏览器太老）就原样上传，
// 服务器照旧做四项检查（大小 / 格式 / 存储 / 异常），所以这里失败不会变成坏图。
//
// 2026-10-26 起多产出一个小图（`thumbFile`）：点单页每行左边那个 64×64 的小格子。
// 一张 1600px 的大图塞进 64px 方格里，手机要白下载 200～300KB、还要自己做缩放；
// 一份菜单一百多道菜，光这一步就吃掉好几 MB 流量。小图 200px 够 3 倍屏用，只有十几 KB。

export const TARGET_BYTES = 300 * 1024;
const MAX_EDGE = 1600; // 手机屏 3 倍像素下 375 宽的详情大图约 1125 像素，留余量
const THUMB_EDGE = 200; // 小格子最大 64px、最多 3 倍屏 = 192；给到 200 留一点余量
const QUALITIES = [0.86, 0.78, 0.7, 0.62, 0.54, 0.46];

/** thumbFile：同一张图压出来的小图，上传失败不影响主图（服务端会退回用大图） */
export interface Compressed { file: File; before: number; after: number; changed: boolean; thumbFile?: File }

const encode = (canvas: HTMLCanvasElement, type: string, q: number) =>
  new Promise<Blob | null>((ok) => canvas.toBlob(ok, type, q));

/** 把位图画到指定长边上，返回编码结果（WebP 优先，不支持时退 JPEG） */
async function render(bitmap: ImageBitmap, edge: number, quality: number, name: string): Promise<File | null> {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  let blob = await encode(canvas, 'image/webp', quality);
  // 老版本 Safari 不会编码 WebP（会悄悄给回 PNG），退回 JPEG
  if (!blob || blob.type !== 'image/webp') blob = await encode(canvas, 'image/jpeg', quality);
  if (!blob) return null;
  const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
  return new File([blob], name.replace(/\.[^.]+$/, '') + '.' + ext, { type: blob.type });
}

export async function compressImage(file: File): Promise<Compressed> {
  const keep = { file, before: file.size, after: file.size, changed: false };
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return keep; // 不认识的格式交给服务器给可读提示
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return keep;

  // 小图先出：主图就算原样上传（已经够小），小格子也不该去下大图
  const base = file.name.replace(/\.[^.]+$/, '');
  const thumbFile = (await render(bitmap, THUMB_EDGE, 0.82, `${base}-thumb`)) ?? undefined;

  const fits = Math.max(bitmap.width, bitmap.height) <= MAX_EDGE;
  if (file.size <= TARGET_BYTES && fits) { bitmap.close(); return { ...keep, thumbFile }; } // 已经够小，不再二次压缩损失画质

  let edge = Math.min(MAX_EDGE, Math.max(bitmap.width, bitmap.height));
  let best: { file: File } | null = null;
  // 先降质量，还不够就把尺寸缩到 80% 再来一轮，最多三轮
  for (let round = 0; round < 3 && (!best || best.file.size > TARGET_BYTES); round++) {
    for (const q of QUALITIES) {
      const out = await render(bitmap, edge, q, file.name);
      if (out && (!best || out.size < best.file.size)) best = { file: out };
      if (best && best.file.size <= TARGET_BYTES) break;
    }
    edge = Math.round(edge * 0.8);
  }
  bitmap.close();
  if (!best || best.file.size >= file.size) return { ...keep, thumbFile }; // 压了反而更大（极少见）就用原图
  return { file: best.file, before: file.size, after: best.file.size, changed: true, thumbFile };
}

export const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);
