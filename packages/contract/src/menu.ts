import { z } from 'zod';

/**
 * 菜品数据契约（21号 §4，按 22/24 号裁决落地）。
 * - uid：内部身份证，永不重复；code：顾客看到的编号，允许重复（E11 ×3、C11 ×2 照写）。
 * - 金额一律按「仙」存整数（RM 19.9 → 1990）。
 * - 图片路径直接放在菜品上，初始全空，出图后由导入单回填（24号 #1）。
 */

export const PendingFlag = z.enum([
  'gauss:price', // 价格待高斯核实（L01）
  'gauss:color', // 颜色描述待高斯定（A07）
  'gauss:name', // 菜名用字待高斯定（M01）
]);
export type PendingFlag = z.infer<typeof PendingFlag>;

export const Ingredient = z.object({
  name: z.string().min(1),
  note: z.string(),
});

/** 「拆开看看」用哪种做法：双图法（S级）/ 标注层（B级）/ 不做（饮品、主食） */
export const Disassembly = z.enum(['dual-image', 'annotation', 'none']);
export type Disassembly = z.infer<typeof Disassembly>;

export const Dish = z.object({
  uid: z.string().regex(/^[a-z0-9-]+$/),
  code: z.string(),
  name: z.string().min(1),
  priceSen: z.number().int().nonnegative().nullable(),
  unit: z.string().nullable(),
  categoryKey: z.string().min(1),
  // 文案层（04号六层结构）；没有文案的菜一律为空，不编
  hook: z.string().nullable(), // ① 一句话钩子
  intro: z.string().nullable(), // ② 详情简介（22号 #20 批准为可选字段）
  ingredients: z.array(Ingredient), // ③ 食材档案
  origin: z.string().nullable(), // ④ 源流故事
  steps: z.array(z.string()), // ⑤ 工序
  flavorRoute: z.string().nullable(), // ⑥ 风味之路（可选）
  // 辣度：v1 走备注制（22号 #20 / 24号 #5），结构化辣度暂不启用
  spice: z.null(),
  images: z.object({
    closed: z.string().nullable(),
    exploded: z.string().nullable(),
    // 小格子用的小图（点单页每行左边 64×64、详情页标题上方那条）。
    // 老板在后台传图时顺手压一张 200px 的；没有就跟 closed 用同一张——两处永远是同一道菜、同一张图。
    thumb: z.string().nullable().default(null),
  }),
  disassembly: Disassembly,
  orderable: z.boolean(),
  // 今日售罄（28号 #5）：照常显示、置灰、不能加购；第二个营业日自动恢复。menu.json 里没有这个字段，默认 false
  soldOut: z.boolean().default(false),
  // 「拆开看看」B 级标注层（22号 R2 方案4）：食材在合拢图上的位置，x / y 是 0–1 的相对坐标。
  // 由出图后人工标注回填；没有坐标时详情页退回「食材层」展示
  annotations: z.array(z.object({ ingredient: z.string().min(1), x: z.number().min(0).max(1), y: z.number().min(0).max(1) })).default([]),
  pending: z.array(PendingFlag),
  sourceNote: z.string().nullable(), // 数据源里写在菜名后的括号批注，原样留档
});
export type Dish = z.infer<typeof Dish>;

/**
 * 风味之路给顾客看的部分：截到第一个全角「（」为止（30号 §二.1 A 方案）。
 * 括号里是插画路线号、画师说明、跨点标注等制作信息，留在数据里给 M0 地图面板用，顾客端不显示。
 */
export function flavorRouteLabel(route: string | null): string | null {
  if (!route) return null;
  const cut = route.split('（')[0]!.trim();
  return cut || null;
}

/**
 * 「拆开看看」展开后主视觉用哪种：分解图（S 级有图）/ 合拢图标注（B 级有图有坐标）/ 食材层（图没到时的统一退路）。
 * 返回 null = 不显示「拆开看看」按钮：饮品主食不做，或者批准稿没写食材、图也没到——点开是空的不如不放。
 */
export type TakeApartView = 'exploded' | 'pins' | 'layers';
export function takeApartView(d: Pick<Dish, 'disassembly' | 'images' | 'annotations' | 'ingredients'>): TakeApartView | null {
  if (d.disassembly === 'dual-image' && d.images.exploded) return 'exploded';
  if (d.disassembly === 'annotation' && d.images.closed && d.annotations.length > 0) return 'pins';
  if (d.disassembly !== 'none' && d.ingredients.length > 0) return 'layers';
  return null;
}

export const Category = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  pending: z.boolean(), // 命名与顺序待高斯定（22号 #19）
});
export type Category = z.infer<typeof Category>;

export const Menu = z.object({
  generatedFrom: z.array(z.string()),
  categories: z.array(Category),
  dishes: z.array(Dish),
  bundles: z.array(z.object({ name: z.string(), rule: z.string() })),
});
export type Menu = z.infer<typeof Menu>;

export const FaqItem = z.object({ q: z.string(), a: z.string() });
export const Faq = z.object({
  boards: z.array(z.object({ title: z.string(), items: z.array(FaqItem) })),
});
export type Faq = z.infer<typeof Faq>;
