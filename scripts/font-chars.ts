// 自托管字体要保留的字：生成字体（build-fonts）和数据校验（validate-data）用同一份清单，不会两边对不上
import { LEDGER_TYPE_LABEL, ORDER_STATUS_LABEL, type Brand, type Faq, type Menu } from '@pkg/contract';

/** ASCII 可见字符：菜名里有「100 Plus」「Tiger啤酒」这类英文数字，书法字体一并保留 */
const ASCII = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i)).join('');

/**
 * 53号 T：书法升为顾客端「标题标签层」字体——这些界面字也用书法画，必须都在裁剪后的字体里。
 * 正文层（菜品一句话、详情正文）永远不用书法，不在这里。
 */
export const BRUSH_UI_LABELS = [
  '点单', '取餐', '会员', '我的', // 底部导航
  '去结算', '直达', '拆开看看', '样食材', '合拢', // 按钮
  '桌', '当前等待约', '分钟', // 门店区：桌号、等待时间
  '今日招牌', '全部', // 横幅卡标签、分类条第一项
  '·', // 「去结算 · 2」这类按钮里的间隔点（ASCII 之外）
  // 54号：主程序换装后，弹层和面板标题也是书法
  '购物车', '没能加载出来',
  // 54号 第二批：结算 / 取餐 / 会员 / 我的 的页面标题、面板标题、取餐进度、功能格
  '确认订单', '核对菜品', '桌号与备注', '付款方式',
  '取餐号', '已下单', '制作中', '请取餐', '更早的订单',
  '会员登录', '储值余额', '储值规则', '消费记录', '未登录会员',
  '我的订单', '门店信息', '会员储值', '常见问题', '营业时间', '电话', '地址',
  '登录中…', // 56号：黑金登录页的按钮字也是书法
];

/** 书法字体：仪式位（35号 Q2）+ 53号起的标题标签层（菜名、价格、分组、分类、导航、按钮、桌号等待） */
export function brushChars(brand: Brand, menu: Menu, faq?: Faq): string[] {
  const text = [
    ...Object.values(ORDER_STATUS_LABEL), ...Object.values(LEDGER_TYPE_LABEL), // 54号：取餐状态、消费记录类型
    ...(faq?.boards.map((b) => b.title) ?? []), // 54号：「我的」页问答分组标题
    brand.seal, // 方形小印
    brand.logoSeal ?? '', // 圆形店标印章、点按留下的小印（53号）
    brand.watermark, // 背景水印
    brand.shortName, // 店名
    ...menu.dishes.map((d) => d.name), // 菜名（列表、详情大标题、缩略图首字）
    ...menu.dishes.flatMap((d) => d.ingredients.map((i) => i.name)), // 拆开看看的食材层
    ...menu.dishes.map((d) => d.unit ?? ''), // 价格后面的单位（「/份」）
    ...menu.categories.map((c) => c.name), ...Object.values(brand.categoryNames), // 分组标题、分类条
    ...brand.spiceOptions, // 购物车里的辣度（不辣 / 微辣 / 中辣 / 特辣 / 湖南辣）——少了「辣」字就悄悄掉成系统字体
    ...BRUSH_UI_LABELS,
    ASCII, // 价格「RM 48」、数字
  ].join('');
  return [...new Set([...text])].sort();
}

/**
 * 英文装饰字体（41号）：只留大写字母、数字和常用标点（全大写标签用不到小写）。
 * 英文标签本身也并进来——标签里如果出现了这个范围以外的字符，数据校验会拦住。
 */
// + − ：47号组件 2「算盘珠」数量调节器的加减号用衬线字形
// 53号（高斯原话）：标题标签层里的数字和英文不用书法，改用这个衬线体——菜名里的「100 Plus」「Tiger」有小写，整套 ASCII 都留
const LATIN = ASCII + "’·−";
export function latinChars(brand: Brand): string[] {
  const labels = [...Object.values(brand.englishLabels.categories), ...Object.values(brand.englishLabels.sections)].join('');
  return [...new Set([...LATIN, ...labels])].sort();
}

/** 53号：详情正文楷体——只留详情页正文真正用到的字（详细介绍、源流、工序、食材说明、风味之路），加 ASCII 和中文标点 */
const CJK_PUNCT = '，。、；：？！“”‘’（）《》——…·';
export function bodyChars(menu: Menu): string[] {
  const text = [
    ...menu.dishes.flatMap((d) => [d.intro ?? '', d.origin ?? '', d.flavorRoute ?? '', ...(d.steps ?? []), ...d.ingredients.map((i) => i.note ?? '')]),
    CJK_PUNCT,
    ASCII,
  ].join('');
  return [...new Set([...text])].filter((c) => c !== '\n').sort();
}

/** 品牌配置里有哪些自托管字体、各自要哪些字 */
export function selfHostedFonts(brand: Brand, menu: Menu, faq?: Faq) {
  return [
    { name: '书法字体', font: brand.brushFont, chars: () => brushChars(brand, menu, faq) },
    { name: '英文字体', font: brand.latinFont, chars: () => latinChars(brand) },
    { name: '正文楷体', font: brand.bodyFont, chars: () => bodyChars(menu) },
  ].filter((f): f is { name: string; font: NonNullable<Brand['brushFont']>; chars: () => string[] } => f.font !== null);
}
