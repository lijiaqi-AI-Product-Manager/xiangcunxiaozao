/**
 * 全菜单种子数据 · 唯一权威源=04文案库v1.0（2026-10-13）
 * 红线：菜名/序号/价格一字不改；文案=米其林式克制（讲事实不讲形容词）
 * animation_key = 序号（S01..F01），驱动前端插画路由
 */
export interface SeedDish {
  code: string;
  name: string;
  desc: string;
  price_cents: number;
  category: string;
  avoid: string[];
}

const DISH_AVOID = ['不要香菜', '不要蒜'];

export const MENU_SEED: SeedDish[] = [
  // ===== S 小甜水 =====
  { code: 'S01', name: '西瓜海底椰霸王杯（一升桶）', desc: '手捣西瓜肉打底，椰乳清润，一升桶装与朋友分着喝。', price_cents: 1290, category: '小甜水', avoid: [] },
  { code: 'S02', name: '冰鲜薄荷柠檬水', desc: '新鲜薄荷与柠檬，冰水直出，解腻醒神。', price_cents: 390, category: '小甜水', avoid: [] },
  { code: 'S03', name: '水晶葡萄波波', desc: '葡萄紫红渐变，波波沉底。', price_cents: 590, category: '小甜水', avoid: [] },
  // ===== L 手打柠檬茶 =====
  { code: 'L01', name: '招牌手打柠檬茶', desc: '香水柠檬现捶，皮油迸香，酸爽回甘。', price_cents: 1190, category: '手打柠檬茶', avoid: [] },
  { code: 'L02', name: '单枞鸭香手打柠檬茶', desc: '潮州凤凰单丛入茶，茶香衬柠檬，一杯两香。', price_cents: 990, category: '手打柠檬茶', avoid: [] },
  { code: 'L05', name: '芽碧茉莉手打柠檬茶', desc: '茉莉窨香入茶，柠檬一点酸，花香一缕甜。', price_cents: 990, category: '手打柠檬茶', avoid: [] },
  { code: 'L06', name: '泰绿手打柠檬茶', desc: '泰式绿茶打底，翠绿透亮，清苦回甘。', price_cents: 990, category: '手打柠檬茶', avoid: [] },
  // ===== M 轻乳茶 =====
  { code: 'M01', name: '单枞压香轻乳茶', desc: '单丛焙香遇上轻乳，香而不腻，一杯见底。', price_cents: 990, category: '轻乳茶', avoid: [] },
  { code: 'M02', name: '桃桃乌龙轻乳茶', desc: '蜜桃果肉与乌龙同杯，果甜茶甘。', price_cents: 990, category: '轻乳茶', avoid: [] },
  { code: 'M05', name: '锡兰红茶轻乳茶', desc: '斯里兰卡锡兰红茶，茶色红亮，乳香顺滑。', price_cents: 1190, category: '轻乳茶', avoid: [] },
  { code: 'M06', name: '芽碧茉莉轻乳茶', desc: '茉莉窨香配轻乳，先闻花香，再喝茶味。', price_cents: 990, category: '轻乳茶', avoid: [] },
  // ===== A 开胃凉拌 =====
  { code: 'A01', name: '凉拌木耳', desc: '当日泡发木耳，酸辣汁浸透褶皱，脆嫩爽口。', price_cents: 800, category: '开胃凉拌', avoid: DISH_AVOID },
  { code: 'A02', name: '凉拌海带丝', desc: '海带切丝冰镇，蒜香醋汁，脆得有韧劲。', price_cents: 800, category: '开胃凉拌', avoid: DISH_AVOID },
  { code: 'A03', name: '剁椒皮蛋', desc: '溏心皮蛋对切，湖南剁椒铺面，热油一激。', price_cents: 800, category: '开胃凉拌', avoid: DISH_AVOID },
  { code: 'A04', name: '凉拌腐竹', desc: '腐竹煮到弹韧，红油拌开，豆香在嚼劲里。', price_cents: 800, category: '开胃凉拌', avoid: DISH_AVOID },
  { code: 'A05', name: '凉拌黄瓜', desc: '刀背拍裂，蒜香入味，脆到出水。', price_cents: 800, category: '开胃凉拌', avoid: DISH_AVOID },
  { code: 'A07', name: '油泼爆香黄金干', desc: '金黄香干切条，蒜末辣椒铺面，滚油当桌一泼。', price_cents: 990, category: '开胃凉拌', avoid: DISH_AVOID },
  // ===== B 下饭小炒 =====
  { code: 'B02', name: '爆炒土豆丝', desc: '土豆现切细丝，猛火快炒，酸辣脆爽。', price_cents: 1300, category: '下饭小炒', avoid: DISH_AVOID },
  { code: 'B03', name: '肉末酸豆角', desc: '老坛酸豆角配现煸肉末，酸咸开胃。', price_cents: 1500, category: '下饭小炒', avoid: DISH_AVOID },
  { code: 'B04', name: '西红柿炒鸡蛋', desc: '土鸡蛋炒大块，番茄炒出沙，汤汁拌饭。', price_cents: 1500, category: '下饭小炒', avoid: DISH_AVOID },
  { code: 'B05', name: '干锅包菜', desc: '手撕大片包菜，虾干提鲜，锅气十足。', price_cents: 1700, category: '下饭小炒', avoid: DISH_AVOID },
  { code: 'B07', name: '麻婆豆腐', desc: '豆腐嫩而不碎，麻辣红油，一勺浇饭。', price_cents: 1500, category: '下饭小炒', avoid: DISH_AVOID },
  { code: 'B08', name: '酸菜炒小笋', desc: '老坛酸菜配鲜嫩小笋，酸脆双响。', price_cents: 1700, category: '下饭小炒', avoid: DISH_AVOID },
  { code: 'B11', name: '清炒时蔬', desc: '当日时蔬，蒜香清炒，油盐之外不加戏。', price_cents: 1700, category: '下饭小炒', avoid: DISH_AVOID },
  { code: 'B12', name: '油泼牛肚丝', desc: '白卤牛肚切丝，红油拌香。', price_cents: 1700, category: '下饭小炒', avoid: DISH_AVOID },
  { code: 'B13', name: '外婆菜炒鸡蛋', desc: '湘西外婆菜配土鸡蛋，咸香下饭。', price_cents: 1800, category: '下饭小炒', avoid: DISH_AVOID },
  { code: 'B14', name: '酸菜炒粉皮', desc: '红薯粉皮透亮滑韧，酸菜酸香同炒。', price_cents: 1800, category: '下饭小炒', avoid: DISH_AVOID },
  // ===== C 家常小炒 =====
  { code: 'C03', name: '农家一碗香', desc: '五花肉、土鸡蛋、螺丝椒、木耳猛火合炒——香辣鲜嫩，米饭杀手。', price_cents: 2500, category: '家常小炒', avoid: DISH_AVOID },
  { code: 'C04', name: '香菜炒牛肚', desc: '卤香牛肚厚片，香菜大火一炒，脆韧交锋。', price_cents: 2500, category: '家常小炒', avoid: DISH_AVOID },
  { code: 'C05', name: '香菜炒牛肉', desc: '鲜牛肉现切，猛火不过十秒，香菜收尾。', price_cents: 2500, category: '家常小炒', avoid: DISH_AVOID },
  { code: 'C07', name: '酸菜鸡杂', desc: '鸡胗鸡肠配老坛酸菜，酸辣脆爽。', price_cents: 2500, category: '家常小炒', avoid: DISH_AVOID },
  { code: 'C08', name: '肉末茄子煲', desc: '砂锅慢煲，茄子吸饱肉香，上桌还咕嘟。', price_cents: 2800, category: '家常小炒', avoid: DISH_AVOID },
  { code: 'C09', name: '蒜香绝味凤爪', desc: '鸡爪焖透，蒜香浓郁，青柠解腻。', price_cents: 2800, category: '家常小炒', avoid: DISH_AVOID },
  { code: 'C10', name: '姜辣口味凤爪', desc: '老姜量足，干辣椒够猛，姜辣焖进骨头缝。', price_cents: 2800, category: '家常小炒', avoid: DISH_AVOID },
  { code: 'C11', name: '外婆菜炒肉末', desc: '外婆菜的咸香，肉末的油润，白饭不够吃。', price_cents: 2500, category: '家常小炒', avoid: DISH_AVOID },
  { code: 'C13', name: '红油猪耳尖', desc: '卤猪耳切薄片，红油拌开，脆骨弹牙。', price_cents: 2800, category: '家常小炒', avoid: DISH_AVOID },
  { code: 'C14', name: '青椒爆炒猪耳尖', desc: '卤香猪耳配螺丝椒，猛火合炒，锅气直冲。', price_cents: 2800, category: '家常小炒', avoid: DISH_AVOID },
  { code: 'C15', name: '卤水猪耳尖', desc: '老卤慢浸，切片即食，吃原味卤香。', price_cents: 2800, category: '家常小炒', avoid: DISH_AVOID },
  // ===== D 镇店硬菜 =====
  { code: 'D04', name: '油豆腐红烧肉', desc: '红烧肉烧出琥珀色，油豆腐吸饱汤汁。', price_cents: 3800, category: '镇店硬菜', avoid: DISH_AVOID },
  { code: 'D05', name: '干锅手撕鸡', desc: '盐焗鸡腿手撕成条，干锅端上桌小火不停。', price_cents: 3800, category: '镇店硬菜', avoid: DISH_AVOID },
  { code: 'D08', name: '湘村酸菜鱼', desc: '鱼现杀现片，老坛酸菜熬汤，酸汤奶白。', price_cents: 3800, category: '镇店硬菜', avoid: DISH_AVOID },
  { code: 'D09', name: '凯里酸汤鱼', desc: '贵州凯里做法，番茄自然发酵，木姜子提香。', price_cents: 3800, category: '镇店硬菜', avoid: DISH_AVOID },
  // ===== E 招牌菜 =====
  { code: 'E01', name: '招牌跳跳蛙', desc: '牛蛙现杀，猛火快炒。', price_cents: 4800, category: '招牌菜', avoid: DISH_AVOID },
  { code: 'E06', name: '油泼湘味牛肉', desc: '牛肉滑嫩，热油泼香。', price_cents: 4800, category: '招牌菜', avoid: DISH_AVOID },
  { code: 'E07', name: '干锅肥肠', desc: '肥肠先卤后煸，红绿辣椒蒜香，越煮越香。', price_cents: 4800, category: '招牌菜', avoid: DISH_AVOID },
  { code: 'E09', name: '西红柿牛腩', desc: '牛腩带筋慢炖，番茄土豆熬汤。', price_cents: 4800, category: '招牌菜', avoid: DISH_AVOID },
  { code: 'E10', name: '肥肠鱼', desc: '肥肠煸香垫底，鱼片滑嫩铺面，一锅双主角。', price_cents: 5800, category: '招牌菜', avoid: DISH_AVOID },
  // ===== F 炭火烤鱼 =====
  { code: 'F01', name: '脆皮爆汁烤鱼', desc: '整条现杀现烤，皮脆肉嫩。', price_cents: 7800, category: '炭火烤鱼', avoid: DISH_AVOID },
];
