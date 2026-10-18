import { z } from 'zod';
import { Dish } from './menu.ts';

/** 门店营业状态（23号 validStore 语义：扫码先看营业状态；24号 #10：打烊=显示营业时间+停止接单） */
export const StoreStatus = z.object({
  open: z.boolean(),
  reason: z.enum(['paused', 'outside-hours']).nullable(), // 不营业的原因：老板手动暂停 / 不在营业时间
  openAt: z.string().nullable(), // 'HH:MM'，未设置为 null
  closeAt: z.string().nullable(),
});
export type StoreStatus = z.infer<typeof StoreStatus>;

/** 老板端看到的菜品：在顾客菜单字段之外，多一个上架状态和菜单原价 */
/** 菜品三态（28号 #5）：在售 / 今日售罄 / 下架 */
export const DishState = z.enum(['on', 'soldout', 'off']);
export type DishState = z.infer<typeof DishState>;
export const DISH_STATE_LABEL: Record<DishState, string> = { on: '在售', soldout: '今日售罄', off: '下架' };

export const AdminDish = Dish.extend({
  state: DishState,
  listed: z.boolean(),
  sellable: z.boolean(), // 菜单里本来就不卖的（如外卖配送费）为 false，上架按钮不显示
  basePriceSen: z.number().int().nullable(),
  // 当前合拢图是不是老板在后台上传的（34号：只有上传的图能「删除，恢复占位」；导入单里的图不在后台删）
  imageUploaded: z.boolean(),
});
export type AdminDish = z.infer<typeof AdminDish>;

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 54号 §2.2「今日招牌」：老板端挑哪几道菜上点单页顶部大画（按顺序左右滑），收起后的横幅卡同源。
 * 只存菜品 ID——图、菜名、价格都从菜单现读，不另存一份，改价改图自动跟着变；不编特价。
 * 存在已有的 settings 表里（键 home.today），不改表结构。
 */
export const TODAY_MAX = 5;
export const TodaySignature = z.object({ dishes: z.array(z.string()).max(TODAY_MAX) });
export type TodaySignature = z.infer<typeof TodaySignature>;

/**
 * 58号 任务4「门店信息」：地址 / 电话 / 营业时间 / WhatsApp，老板端编辑，存在已有的 settings 表里（键 store.info），不改表结构。
 * 没填的为 null：顾客端那一行不显示（不再显示「待提供」）；四项全空，门店小卡整张不显示。
 * 营业时间这里是给顾客看的文字（可分段，如午市 + 晚市）；几点开始 / 停止接单仍由「营业状态」的开门 / 打烊时间管。
 */
export const StoreInfo = z.object({
  address: z.string().nullable(),
  phone: z.string().nullable(),
  hours: z.string().nullable(),
  whatsapp: z.string().nullable(),
});
export type StoreInfo = z.infer<typeof StoreInfo>;
export const STORE_INFO_FIELDS = ['address', 'phone', 'hours', 'whatsapp'] as const;
export const STORE_INFO_LABEL: Record<keyof StoreInfo, string> = { address: '地址', phone: '电话', hours: '营业时间', whatsapp: 'WhatsApp' };
export const ADDRESS_MAX = 120;
export const HOURS_MAX_SEGMENTS = 4;

/** 电话 / WhatsApp：去掉空格、横杠、括号后只剩数字（可带开头的 +），7–15 位 */
const phoneDigits = (s: string) => s.replace(/[\s\-()]/g, '');
const PHONE = /^\+?\d{7,15}$/;

/**
 * 营业时间分段：「11:00-15:00, 17:00-22:00」→「11:00–15:00，17:00–22:00」。
 * 段与段之间可用逗号、分号、顿号、斜杠；起止之间可用 - – — ~ 至 到；跨夜照写（17:00–02:00）。
 */
export function parseHours(text: string): { ok: true; value: string } | { ok: false; message: string } {
  const segs = text.split(/[,，;；、/]/).map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0) return { ok: false, message: '营业时间没有填内容' };
  if (segs.length > HOURS_MAX_SEGMENTS) return { ok: false, message: `营业时间最多分 ${HOURS_MAX_SEGMENTS} 段` };
  const out: string[] = [];
  for (const seg of segs) {
    const m = seg.match(/^(\d{1,2}:\d{2})\s*[-–—~至到]\s*(\d{1,2}:\d{2})$/);
    const pad = (t: string) => t.padStart(5, '0');
    if (!m || !HHMM.test(pad(m[1]!)) || !HHMM.test(pad(m[2]!))) return { ok: false, message: `「${seg}」看不懂，请写成 11:00-15:00 这样，多段用逗号隔开` };
    if (pad(m[1]!) === pad(m[2]!)) return { ok: false, message: `「${seg}」开始和结束不能相同` };
    out.push(`${pad(m[1]!)}–${pad(m[2]!)}`);
  }
  return { ok: true, value: out.join('，') };
}

/** 老板端提交的门店信息：逐项检查，空字符串当「不填」；返回整理后的值或第一条看得懂的错误 */
export function normalizeStoreInfo(input: unknown): { ok: true; value: StoreInfo } | { ok: false; message: string } {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const value: StoreInfo = { address: null, phone: null, hours: null, whatsapp: null };
  for (const k of STORE_INFO_FIELDS) {
    const raw = src[k];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') return { ok: false, message: `${STORE_INFO_LABEL[k]}格式不对` };
    const t = raw.trim().replace(/\s+/g, ' ');
    if (!t) continue;
    if (k === 'address') {
      if (t.length > ADDRESS_MAX) return { ok: false, message: `地址太长（最多 ${ADDRESS_MAX} 字）` };
      value.address = t;
    } else if (k === 'hours') {
      const h = parseHours(t);
      if (!h.ok) return h;
      value.hours = h.value;
    } else {
      if (!PHONE.test(phoneDigits(t))) return { ok: false, message: `${STORE_INFO_LABEL[k]}号码格式不对（7–15 位数字，可带 + 和空格、横杠）` };
      if (k === 'whatsapp' && !t.startsWith('+')) return { ok: false, message: 'WhatsApp 号码请带国家区号，以 + 开头' };
      value[k] = t;
    }
  }
  return { ok: true, value };
}

/** 顾客点 WhatsApp 打开聊天用的地址（只留数字）；没填返回 null */
export function whatsappLink(n: string | null): string | null {
  return n ? `https://wa.me/${n.replace(/\D/g, '')}` : null;
}
/** 拨号地址（只留数字和开头的 +） */
export function telLink(n: string | null): string | null {
  return n ? `tel:${phoneDigits(n)}` : null;
}

/** 营业时间文字：设置了就显示「11:00–22:00」，跨夜也照写（如 17:00–02:00） */
export function formatHours(s: Pick<StoreStatus, 'openAt' | 'closeAt'>, fallback: string | null): string | null {
  return s.openAt && s.closeAt ? `${s.openAt}–${s.closeAt}` : fallback;
}
