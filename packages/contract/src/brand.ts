import { z } from 'zod';

/** 自托管字体：family = CSS 字体名；file = 裁剪后的小字体；source = 字体原文件（都相对品牌目录） */
const SelfHostedFont = z.object({
  family: z.string().min(1),
  file: z.string().regex(/\.woff2$/),
  source: z.string().min(1),
  // 可变字体只保留一个字重（比如英文标签只用 600），体积能再小一半
  pinWeight: z.number().int().min(100).max(900).optional(),
  // 或者保留一段字重（47号 B2：英文标题 700、装饰线 400 两档），二选一
  weightRange: z.tuple([z.number().int().min(100).max(900), z.number().int().min(100).max(900)])
    .refine(([a, b]) => a < b, '字重范围要从小到大').optional(),
}).refine((f) => !(f.pinWeight && f.weightRange), 'pinWeight 和 weightRange 只能写一个');

/** 一家店的全部「可换」信息。代码里不许出现任何店名，全部从这里读。 */
export const Brand = z.object({
  id: z.string(),
  name: z.string(),
  shortName: z.string(),
  locale: z.string(),
  timezone: z.string(),
  currency: z.object({ code: z.string(), symbol: z.string() }),
  store: z.object({
    // 门店信息未提供时为 null，绝不编造（21号 §8）。58号起老板端「门店信息」页可编辑，这里只在老板端从没保存过时兜底；空的那一行顾客端不显示
    address: z.string().nullable(),
    hours: z.string().nullable(),
    phone: z.string().nullable(),
    logo: z.string().nullable(),
  }),
  paymentMethods: z.array(z.object({ key: z.string(), label: z.string(), requiresMember: z.boolean() })),
  spiceOptions: z.array(z.string()),
  categoryOrder: z.array(z.string()),
  categoryNames: z.record(z.string(), z.string()),
  // 34号 B：这些分类（如主食）详情页只显示图、菜名、价格，不写「详细介绍正在整理中」——它们本来就不需要介绍
  plainDetailCategories: z.array(z.string()).default([]),
  // 等待时长估算的默认参数（24号 #6：自动估算，老板端可调、可手动覆盖）
  wait: z.object({ minutesPerOrder: z.number().int().positive() }),
  // 成品态品牌元素（26号 §三）：印章 Logo 上的字、书法水印文字、需要加载的网页字体
  seal: z.string().min(1).max(2),
  watermark: z.string().min(1),
  fontStylesheets: z.array(z.string().url()).default([]),
  // P3 第④项：书法字体自托管。file = 裁剪后的小字体，source = 字体原文件（都相对品牌目录）；为 null 时退回系统楷体
  brushFont: SelfHostedFont.nullable().default(null),
  // 41号：英文装饰字体（新中式中英混排里的宽体大写衬线），同一条自托管管线；为 null 时退回系统衬线
  latinFont: SelfHostedFont.nullable().default(null),
  // 53号（高斯）：详情正文楷体（手机没有自带楷体），同一条自托管管线，只裁正文用到的字；为 null 时退回系统楷体 / 宋体
  bodyFont: SelfHostedFont.nullable().default(null),
  // 53号（高斯）：圆形店标印章上的字（方形小印仍用 seal）；不写就和 seal 一样
  logoSeal: z.string().min(1).max(2).optional(),
  // 35号 Q4 招牌三句（门店框第二行，如「明厨亮灶 · 当日现采 · 一菜一锅」）；不写就不显示
  trustLine: z.array(z.string().min(1)).default([]),
  // 47号：列表里带金棕书签条的「招牌」分类、滑到时背景换青绿冷光的「饮品」分类（分类 key）
  signatureCategories: z.array(z.string()).default([]),
  drinkCategories: z.array(z.string()).default([]),
  // 40号 §四英文标签（41号终版）：英文只做装饰性结构层，永远不替代中文。categories 按分类 key，sections 按区块
  englishLabels: z.object({
    categories: z.record(z.string(), z.string()),
    sections: z.record(z.string(), z.string()),
  }).default({ categories: {}, sections: {} }),
});
export type Brand = z.infer<typeof Brand>;

/** 设计 token：颜色、圆角、字号全走这里，代码里 0 散写色值（23号 §七）。 */
export const TokenSet = z.record(z.string(), z.string());
export const Tokens = z.object({
  customer: TokenSet, // 顾客端成品态
  customerSkeleton: TokenSet, // 顾客端骨架态（26号：中性灰白、无品牌元素）
  admin: TokenSet,
  provisional: z.array(z.string()), // 尚未经老板确认的 token 名
});
export type Tokens = z.infer<typeof Tokens>;
