// 顾客端各页面共用的小零件：品牌配置、金额格式、页面跳转
import { formatPrice } from '@pkg/contract';
import { currentSkin } from '@pkg/ui-kit';
import config from 'virtual:brand';

export const { brand } = config;
// 26号两态并行：成品态显示水印、印章、书法占位、线稿空状态；骨架态一律不显示品牌元素
export const FINISHED = currentSkin() === 'finished';
/** 方形小印的字（分组字标、详情标题、风味之路）——高斯：方印仍是「灶」 */
export const SEAL = FINISHED ? brand.seal : null;
/** 圆戳的字（店标、点按小印、详情落款）——53号起是品牌配置 logoSeal，没写就和方印一样 */
export const LOGO_SEAL = FINISHED ? (brand.logoSeal ?? brand.seal) : null;
// 货币符号和数字之间用不换行空格：窄屏上「RM」和「40」不会被拆到两行
export const money = (sen: number | null | undefined) => `${brand.currency.symbol} ${formatPrice(sen)}`;
export const payLabel = (key: string) => brand.paymentMethods.find((m) => m.key === key)?.label ?? key;

/** 跳到某个页面（#order / #checkout / #dish/e01 …），并回到页面顶部 */
export const go = (route: string) => { location.hash = route; window.scrollTo({ top: 0 }); };

/**
 * 菜单页的「记忆」：滚动位置。从菜单点进某道菜再返回，顾客回到原来翻到的位置，
 * 不用从 86 道菜的第一道重新往下翻（54号起分类是滚动定位，位置记住了，分类高亮自然跟着回来）。
 */
export const listMemory = { scrollY: 0, restore: false };

export function openDish(uid: string) {
  listMemory.scrollY = window.scrollY;
  listMemory.restore = true;
  go(`dish/${uid}`);
}

/** 返回菜单：菜单页渲染出来后按 listMemory 滚回原位 */
export const backToList = () => go('order');
