// P3 第④项·上传侧：老板端选好图片后，先在浏览器里压到 300KB 以内再上传（09号 §五.5：单图 300KB）。
// 不装任何库，用浏览器自带的画布重新编码。压不了（格式不认识、浏览器太老）就原样上传，
// 服务器照旧做四项检查（大小 / 格式 / 存储 / 异常），所以这里失败不会变成坏图。

export const TARGET_BYTES = 300 * 1024;
const MAX_EDGE = 1600; // 手机屏 3 倍像素下 375 宽的详情大图约 1125 像素，留余量
const QUALITIES = [0.86, 0.78, 0.7, 0.62, 0.54, 0.46];

export interface Compressed { file: File; before: number; after: number; changed: boolean }

const encode = (canvas: HTMLCanvasElement, type: string, q: number) =>
  new Promise<Blob | null>((ok) => canvas.toBlob(ok, type, q));

export async function compressImage(file: File): Promise<Compressed> {
  const keep = { file, before: file.size, after: file.size, changed: false };
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return keep; // 不认识的格式交给服务器给可读提示
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return keep;
  const fits = Math.max(bitmap.width, bitmap.height) <= MAX_EDGE;
  if (file.size <= TARGET_BYTES && fits) { bitmap.close(); return keep; } // 已经够小，不再二次压缩损失画质

  let edge = Math.min(MAX_EDGE, Math.max(bitmap.width, bitmap.height));
  let best: Blob | null = null;
  // 先降质量，还不够就把尺寸缩到 80% 再来一轮，最多三轮
  for (let round = 0; round < 3 && (!best || best.size > TARGET_BYTES); round++) {
    const scale = edge / Math.max(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const q of QUALITIES) {
      let blob = await encode(canvas, 'image/webp', q);
      // 老版本 Safari 不会编码 WebP（会悄悄给回 PNG），退回 JPEG
      if (!blob || blob.type !== 'image/webp') blob = await encode(canvas, 'image/jpeg', q);
      if (blob && (!best || blob.size < best.size)) best = blob;
      if (best && best.size <= TARGET_BYTES) break;
    }
    edge = Math.round(edge * 0.8);
  }
  bitmap.close();
  if (!best || best.size >= file.size) return keep; // 压了反而更大（极少见）就用原图
  const ext = best.type === 'image/webp' ? 'webp' : 'jpg';
  const name = file.name.replace(/\.[^.]+$/, '') + '.' + ext;
  return { file: new File([best], name, { type: best.type }), before: file.size, after: best.size, changed: true };
}

export const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);
