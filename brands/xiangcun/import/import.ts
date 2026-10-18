/**
 * 本店专用导入器：把三份原始文档（11号清单 / 04号文案 / 08号问答）机械转换成 menu.json + faq.json，
 * 并输出一份给老板逐条核对的校验报告。
 *
 * 规矩：只搬运，不改写。唯一的文字改动是 24号裁决 #16 的问答纠错，单独列在 FAQ_CORRECTIONS 里并写进报告。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Faq, Menu, type Dish, type Disassembly, type PendingFlag } from '@pkg/contract';

type SectionKey = 'l' | 's' | 'm' | 'xl' | 'can' | 'a' | 'b' | 'c' | 'd' | 'e' | 'v';

interface SectionDef {
  key: SectionKey;
  header: string; // 11号清单里的 "## ..." 标题（去掉序号）
  crossDupSuffix: string; // 编号与其他区重复时追加的后缀（如 D01 罐装 vs D01 热菜）
  disassembly: Disassembly;
}

// 24号 #14/#15：D/E/V = 双图法；A/B/C = 标注层；饮品不做
const SECTIONS: SectionDef[] = [
  { key: 'l', header: '香水柠檬茶系列 L', crossDupSuffix: 'l', disassembly: 'none' },
  { key: 's', header: '水果柠檬茶系列 S', crossDupSuffix: 's', disassembly: 'none' },
  { key: 'm', header: '轻乳鲜茶系列 M', crossDupSuffix: 'm', disassembly: 'none' },
  { key: 'xl', header: '一升桶装霸王杯系列 XL', crossDupSuffix: 'xl', disassembly: 'none' },
  { key: 'can', header: '罐装饮品 D（罐装线，与D区热菜编号并行，照写）', crossDupSuffix: 'can', disassembly: 'none' },
  { key: 'a', header: '开胃凉菜 A', crossDupSuffix: 'a', disassembly: 'annotation' },
  { key: 'b', header: '下饭小炒 B（含田园时蔬）', crossDupSuffix: 'b', disassembly: 'annotation' },
  { key: 'c', header: '家常小炒 C', crossDupSuffix: 'c', disassembly: 'annotation' },
  { key: 'd', header: '招牌烧菜 D（热菜线）', crossDupSuffix: 'hot', disassembly: 'dual-image' },
  { key: 'e', header: '店长推荐 E', crossDupSuffix: 'e', disassembly: 'dual-image' },
  { key: 'v', header: '镇店硬菜 V', crossDupSuffix: 'v', disassembly: 'dual-image' },
];

// 菜名后面的括号是整理人的批注，不是菜名的一部分；只剥离这几种，其余括号（如「青岛啤酒（瓶装）」）原样保留
const ANNOTATION_PATTERNS = [/（旧版保留）$/, /（编号重复，照写）$/, /（金黄豆干.*非黑色！）$/];

// 22号 #9 / 24号 #13：清单漏行但保留的旧菜，插在同编号菜品之后
const RETAINED_ROWS = [
  { section: 'c' as const, code: 'C11', name: '外婆菜炒肉末', price: 25, note: '11号清单无此行；22号裁决 #9 保留，价格取自04号文案库' },
];

// 22号裁决：待高斯本人确认的项，先按裁决值进数据并打标
const PENDING: Record<string, PendingFlag[]> = {
  l01: ['gauss:price'],
  a07: ['gauss:color'],
  m01: ['gauss:name'],
};

const FAQ_CORRECTIONS = [
  {
    question: 1,
    from: '鸡蛋先煎出锅、肉片煸出油脂、青椒木耳单独断生，猛火合炒三十秒，',
    to: '一锅出，鸡蛋炒散先出锅定形，肉片煸出油脂，青椒木耳单独断生，最后猛火合炒三十秒，鸡蛋回锅裹汁出锅。',
    basis: '25号终裁 §1.2 定稿（取代24号 #16）；按老板批准，保留原答案开头「不是。」与结尾「您下单才开始做。」',
  },
];

// 25号终裁 §1.3：菜名以清单为准后，对齐 ② 详情简介的文案（军师定稿）。
// 两处按老板批准的推荐微调：C04「不吃香菜的备注去掉」→「不吃香菜可备注去掉」（军师原意见同条括注）；
// E07 删去「配米饭是死刑级美味」（04号文风：讲事实不讲形容词）。
const COPY_CORRECTIONS: { uid: string; field: 'intro'; to: string; basis: string }[] = [
  { uid: 'b11', field: 'intro', to: '油麦菜娇气，过火即老。猛火快攻，断生就出锅，脆嫩全看灶上那几秒。', basis: '25号 §1.3' },
  { uid: 'c04', field: 'intro', to: '牛肚先卤后炒，脆韧两层。香菜段是灵魂，不吃香菜可备注去掉，锅气不减。', basis: '25号 §1.3（措辞微调）' },
  { uid: 'c05', field: 'intro', to: '黄牛肉切薄片，猛火锁住汁水，香菜垫底吸油增香。湘菜馆考功力，先看这盘。', basis: '25号 §1.3' },
  { uid: 'e07', field: 'intro', to: '肥肠洗七遍，先煮后煸，煸到边缘起泡才下辣椒。越嚼越香。', basis: '25号 §1.3（删去夸张语）' },
];

interface RawRow {
  section: SectionKey;
  code: string;
  name: string;
  price: number;
  sourceNote: string | null;
  origin: string;
}

interface CopyEntry {
  code: string;
  name: string;
  price: number;
  hook: string | null;
  intro: string | null;
  ingredients: { name: string; note: string }[];
  origin: string | null;
  steps: string[];
  flavorRoute: string | null;
}

const toSen = (rm: number) => Math.round(rm * 100);
const stripBold = (s: string) => s.replace(/\*\*/g, '').trim();

function parseMenuList(md: string) {
  const rows: RawRow[] = [];
  const staples: { name: string; desc: string; price: string }[] = [];
  const bundles: { name: string; rule: string }[] = [];
  const stripped: { code: string; note: string }[] = [];
  let current: SectionDef | 'staple' | 'bundle' | null = null;

  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^## [一二三四五六七八九十]+、(.+)$/);
    if (h) {
      const title = h[1]!.trim();
      if (title === '主食与其他') current = 'staple';
      else if (title.startsWith('超值套餐')) current = 'bundle';
      else {
        const def = SECTIONS.find((s) => s.header === title);
        if (!def) throw new Error(`11号清单出现未登记的分区标题：「${title}」`);
        current = def;
      }
      continue;
    }
    if (!current) continue;
    // 分隔线之后是清单的统计脚注（「统计：菜品约86道…」），不是套餐，不能当套餐收进来
    if (/^-{3,}$/.test(line.trim())) { current = null; continue; }
    if (current === 'bundle') {
      const b = line.match(/^\*\*(.+?)\*\*：(.+)$/);
      if (b) bundles.push({ name: b[1]!, rule: b[2]!.trim() });
      continue;
    }
    const cells = line.match(/^\|(.+)\|$/)?.[1]!.split('|').map((c) => c.trim());
    if (!cells || cells.length !== 3 || /^-+$/.test(cells[0]!) || cells[0] === '编号' || cells[0] === '项') continue;
    if (current === 'staple') {
      staples.push({ name: cells[0]!, desc: cells[1]!, price: cells[2]! });
      continue;
    }
    const [code, rawName, price] = cells as [string, string, string];
    if (!/^[A-Z]{1,2}\d{2}$/.test(code)) throw new Error(`编号格式异常：${line}`);
    let name = rawName;
    let sourceNote: string | null = null;
    for (const p of ANNOTATION_PATTERNS) {
      const m = name.match(p);
      if (m) {
        sourceNote = m[0];
        name = name.slice(0, m.index).trim();
        stripped.push({ code, note: m[0] });
      }
    }
    const rm = Number(price);
    if (!Number.isFinite(rm)) throw new Error(`价格无法识别：${line}`);
    rows.push({ section: current.key, code, name, price: rm, sourceNote, origin: '11号清单' });
  }
  return { rows, staples, bundles, stripped };
}

function parseCopy(md: string): CopyEntry[] {
  const entries: CopyEntry[] = [];
  const blocks = md.split(/\r?\n(?=### )/).filter((b) => b.startsWith('### '));
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const head = lines[0]!.match(/^### ([A-Z]\d{2}) (.+?) · RM ([\d.]+)/);
    if (!head) throw new Error(`文案标题格式异常：${lines[0]}`);
    const e: CopyEntry = {
      code: head[1]!, name: head[2]!.trim(), price: Number(head[3]),
      hook: null, intro: null, ingredients: [], origin: null, steps: [], flavorRoute: null,
    };
    let inIngredients = false;
    for (const raw of lines.slice(1)) {
      const line = raw.trim();
      if (line.startsWith('①')) e.hook = stripBold(line.slice(1));
      else if (line.startsWith('②')) e.intro = stripBold(line.slice(1));
      else if (line.startsWith('③')) { inIngredients = true; continue; }
      else if (line.startsWith('④')) e.origin = stripBold(line.slice(1).replace(/^源流：/, ''));
      else if (line.startsWith('⑤')) e.steps = stripBold(line.slice(1).replace(/^工序：/, '')).split('→').map((s) => s.trim()).filter(Boolean);
      else if (line.startsWith('⑥')) e.flavorRoute = stripBold(line.slice(1).replace(/^风味之路：/, ''));
      if (inIngredients && line.startsWith('- ')) {
        const body = stripBold(line.slice(2));
        const i = body.indexOf('：');
        if (i < 0) throw new Error(`${e.code} 食材条目缺少「：」：${line}`);
        e.ingredients.push({ name: body.slice(0, i).trim(), note: body.slice(i + 1).trim() });
      } else if (!line.startsWith('- ') && line !== '') {
        inIngredients = false;
      }
    }
    for (const k of ['hook', 'intro', 'origin', 'flavorRoute'] as const) {
      if (!e[k]) throw new Error(`${e.code} 缺少文案层：${k}`);
    }
    if (e.ingredients.length === 0 || e.steps.length === 0) throw new Error(`${e.code} 缺少食材卡或工序`);
    entries.push(e);
  }
  return entries;
}

function parseFaq(md: string) {
  const start = md.indexOf('## 三、');
  const end = md.indexOf('## 四、');
  if (start < 0 || end < 0) throw new Error('08号文件找不到问答章节');
  const boards: { title: string; items: { q: string; a: string }[] }[] = [];
  let pendingQ: { n: number; q: string } | null = null;
  for (const line of md.slice(start, end).split(/\r?\n/)) {
    const b = line.match(/^### 板块[一二三四五六七八九十]+：(.+?)（/);
    if (b) { boards.push({ title: b[1]!, items: [] }); continue; }
    const q = line.match(/^\*\*问(\d+)：(.+)\*\*$/);
    if (q) { pendingQ = { n: Number(q[1]), q: q[2]! }; continue; }
    const a = line.match(/^答：(.+)$/);
    if (a && pendingQ) {
      let answer = a[1]!.trim();
      for (const fix of FAQ_CORRECTIONS.filter((f) => f.question === pendingQ!.n)) {
        if (answer.split(fix.from).length !== 2) throw new Error(`问${fix.question}：纠错原文「${fix.from}」没有恰好出现一次`);
        answer = answer.replace(fix.from, fix.to);
      }
      boards.at(-1)!.items.push({ q: pendingQ.q, a: answer });
      pendingQ = null;
    }
  }
  return { boards };
}

function assignUids(rows: RawRow[]) {
  const globalCount = new Map<string, Set<SectionKey>>();
  for (const r of rows) {
    if (!globalCount.has(r.code)) globalCount.set(r.code, new Set());
    globalCount.get(r.code)!.add(r.section);
  }
  const seenInSection = new Map<string, number>();
  const sectionDupTotal = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.section}|${r.code}`;
    sectionDupTotal.set(k, (sectionDupTotal.get(k) ?? 0) + 1);
  }
  return rows.map((r) => {
    const k = `${r.section}|${r.code}`;
    let uid = r.code.toLowerCase();
    if (globalCount.get(r.code)!.size > 1) uid += `-${SECTIONS.find((s) => s.key === r.section)!.crossDupSuffix}`;
    if (sectionDupTotal.get(k)! > 1) {
      const i = seenInSection.get(k) ?? 0;
      seenInSection.set(k, i + 1);
      uid += 'abcdefghij'[i];
    }
    return { ...r, uid };
  });
}

export function run(brandDir: string) {
  const src = (f: string) => readFileSync(join(brandDir, 'source', f), 'utf8');
  const list = parseMenuList(src('menu-list-v2.0.md'));
  const copies = parseCopy(src('copy-v1.3.md'));
  const faq = Faq.parse(parseFaq(src('faq-08.md')));
  const copyMap = JSON.parse(readFileSync(join(brandDir, 'copy-map.json'), 'utf8')) as {
    overrides: Record<string, { uid: string; basis: string }>;
  };

  // 插入保留旧菜
  const rows = [...list.rows];
  for (const r of RETAINED_ROWS) {
    const at = rows.findIndex((x) => x.section === r.section && x.code === r.code);
    if (at < 0) throw new Error(`保留旧菜找不到插入位置：${r.code}`);
    rows.splice(at + 1, 0, { section: r.section, code: r.code, name: r.name, price: r.price, sourceNote: null, origin: r.note });
  }
  const withUid = assignUids(rows);

  // 文案挂接
  const byCode = new Map<string, string[]>();
  for (const r of withUid) byCode.set(r.code, [...(byCode.get(r.code) ?? []), r.uid]);
  const copyByUid = new Map<string, CopyEntry>();
  const mapping: { copy: CopyEntry; uid: string; basis: string }[] = [];
  for (const c of copies) {
    const o = copyMap.overrides[c.code];
    let uid: string;
    let basis: string;
    if (o) { uid = o.uid; basis = o.basis; }
    else {
      const cands = byCode.get(c.code) ?? [];
      if (cands.length !== 1) throw new Error(`文案 ${c.code} ${c.name} 无法按编号唯一对应（候选 ${cands.length} 个），需在 copy-map.json 里指定`);
      uid = cands[0]!;
      basis = '同编号';
    }
    if (!withUid.some((r) => r.uid === uid)) throw new Error(`对照表指向不存在的菜品：${c.code} → ${uid}`);
    if (copyByUid.has(uid)) throw new Error(`两条文案挂到同一道菜：${uid}`);
    copyByUid.set(uid, c);
    mapping.push({ copy: c, uid, basis });
  }

  const dishes: Dish[] = withUid.map((r) => {
    const c = copyByUid.get(r.uid);
    const sec = SECTIONS.find((s) => s.key === r.section)!;
    return {
      uid: r.uid, code: r.code, name: r.name, priceSen: toSen(r.price), unit: null,
      categoryKey: r.section,
      hook: c?.hook ?? null, intro: c?.intro ?? null, ingredients: c?.ingredients ?? [],
      origin: c?.origin ?? null, steps: c?.steps ?? [], flavorRoute: c?.flavorRoute ?? null,
      spice: null, images: { closed: null, exploded: null },
      disassembly: sec.disassembly, orderable: true, soldOut: false, annotations: [],
      pending: PENDING[r.uid] ?? [], sourceNote: r.sourceNote,
    };
  });

  // 主食与其他：米饭/咸鸭蛋按份点（24号 #12）；配送费属外卖，本轮不上架
  for (const s of list.staples) {
    if (s.name.startsWith('套餐')) continue;
    const m = s.price.match(/^([\d.]+)(?:\/(.+))?$/);
    if (!m) throw new Error(`主食价格无法识别：${s.name} ${s.price}`);
    const isDelivery = s.name.startsWith('配送费');
    const uid = { 米饭: 'staple-rice', 下饭咸鸭蛋: 'staple-salted-egg', '配送费（一）': 'delivery-fee-1', '配送费（二）': 'delivery-fee-2' }[s.name];
    if (!uid) throw new Error(`未登记的主食条目：${s.name}`);
    dishes.push({
      uid, code: '', name: s.name, priceSen: toSen(Number(m[1])), unit: m[2] ?? null,
      categoryKey: 'staple', hook: null, intro: null, ingredients: [], origin: null, steps: [],
      flavorRoute: null, spice: null, images: { closed: null, exploded: null }, disassembly: 'none',
      orderable: !isDelivery, soldOut: false, annotations: [], pending: [], sourceNote: s.desc === '—' ? null : s.desc,
    });
  }
  const setMeals = list.staples.find((s) => s.name.startsWith('套餐'));
  const bundles = [
    ...list.bundles,
    ...(setMeals ? [{ name: setMeals.name, rule: `${setMeals.desc}（内容待高斯提供，本期不上架）` }] : []),
  ];

  for (const fix of COPY_CORRECTIONS) {
    const d = dishes.find((x) => x.uid === fix.uid);
    if (!d || d[fix.field] === null) throw new Error(`文案修正找不到目标：${fix.uid}.${fix.field}`);
    d[fix.field] = fix.to;
  }

  const brand = JSON.parse(readFileSync(join(brandDir, 'brand.json'), 'utf8')) as { categoryOrder: string[]; categoryNames: Record<string, string> };
  const menu = Menu.parse({
    generatedFrom: ['source/menu-list-v2.0.md', 'source/copy-v1.3.md', 'copy-map.json'],
    categories: brand.categoryOrder.map((key) => ({ key, name: brand.categoryNames[key] ?? key, pending: true })),
    dishes,
    bundles,
  });

  writeFileSync(join(brandDir, 'menu.json'), JSON.stringify(menu, null, 2) + '\n');
  writeFileSync(join(brandDir, 'faq.json'), JSON.stringify(faq, null, 2) + '\n');
  writeFileSync(join(brandDir, 'reports', 'validation.md'), report(menu, list, mapping, faq));
  return { menu, faq };
}

function report(
  menu: Menu,
  list: ReturnType<typeof parseMenuList>,
  mapping: { copy: CopyEntry; uid: string; basis: string }[],
  faq: Faq,
) {
  const dishes = menu.dishes;
  const listRows = list.rows.length;
  const codeCount = new Map<string, number>();
  for (const d of dishes) if (d.code) codeCount.set(d.code, (codeCount.get(d.code) ?? 0) + 1);
  const dupCodes = [...codeCount].filter(([, n]) => n > 1);
  const byUid = new Map(dishes.map((d) => [d.uid, d]));
  const count = (f: (d: Dish) => boolean) => dishes.filter(f).length;
  const catName = new Map(menu.categories.map((c) => [c.key, c.name]));
  const p = (sen: number | null) => (sen === null ? '—' : String(sen / 100));

  const out: string[] = [];
  out.push('# 菜单数据校验报告', '', '> 由导入脚本自动生成，请勿手改。重新生成：`npm run import:menu`。', '');
  out.push('## 一、总数核对', '');
  out.push('| 项 | 数量 |', '| --- | --- |');
  out.push(`| 11号清单菜品行（带编号） | ${listRows} |`);
  out.push(`| 保留旧菜（22号 #9） | ${RETAINED_ROWS.length} |`);
  out.push(`| 带编号菜品合计 | ${count((d) => d.code !== '')} |`);
  out.push(`| 主食与其他（米饭/咸鸭蛋/配送费） | ${count((d) => d.code === '')} |`);
  out.push(`| 其中可点单 | ${count((d) => d.orderable)} |`);
  out.push(`| 挂上文案的菜 | ${mapping.length} / 48 |`);
  out.push(`| 拆开看看：双图法（S级） | ${count((d) => d.disassembly === 'dual-image')} |`);
  out.push(`| 拆开看看：标注层（B级） | ${count((d) => d.disassembly === 'annotation')} |`);
  out.push(`| 不做拆开看看 | ${count((d) => d.disassembly === 'none')} |`);
  out.push(`| 已有图片 | ${count((d) => d.images.closed !== null)}（初始全空，24号 #1） |`, '');
  out.push(`重复编号（照写不合并，内部ID已区分）：${dupCodes.map(([c, n]) => `${c}×${n}`).join('、')}`, '');

  out.push('## 二、文案挂接对照（请逐条勾选）', '');
  out.push('| 确认 | 文案编号 | 文案菜名 | 文案价 | → 内部ID | 清单编号 | 清单菜名（显示用） | 清单价 | 依据 |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const m of mapping) {
    const d = byUid.get(m.uid)!;
    const nameDiff = m.copy.name !== d.name ? ' ⚠名不同' : '';
    const priceDiff = toSen(m.copy.price) !== d.priceSen ? ' ⚠价不同' : '';
    out.push(`| [ ] | ${m.copy.code} | ${m.copy.name} | ${m.copy.price} | ${m.uid} | ${d.code} | ${d.name}${nameDiff} | ${p(d.priceSen)}${priceDiff} | ${m.basis} |`);
  }
  out.push('');

  out.push('## 三、从菜名中剥离的批注（原文留在 sourceNote 字段）', '');
  for (const s of list.stripped) out.push(`- ${s.code}：${s.note}`);
  out.push('');

  out.push('## 四、待高斯确认（已按裁决值进数据并打标）', '');
  for (const d of dishes.filter((x) => x.pending.length)) out.push(`- ${d.code} ${d.name}（${p(d.priceSen)}）：${d.pending.join('、')}`);
  out.push('- 全部分类的命名与顺序：pending（22号 #19）', '');

  out.push('## 五、文字改动（只有下面这些，其余一律原样搬运）', '');
  for (const f of FAQ_CORRECTIONS) out.push(`- 问${f.question}：「${f.from}」→「${f.to}」，依据：${f.basis}`);
  for (const f of COPY_CORRECTIONS) out.push(`- ${f.uid} ② 详情简介 →「${f.to}」，依据：${f.basis}`);
  out.push(`- 问答共 ${faq.boards.reduce((n, b) => n + b.items.length, 0)} 条，${faq.boards.length} 个板块`, '');

  out.push('## 六、完整菜单', '');
  out.push('| 内部ID | 编号 | 菜名 | 价格RM | 单位 | 分类 | 文案 | 拆开看看 | 可点 |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const d of dishes) {
    out.push(`| ${d.uid} | ${d.code || '—'} | ${d.name} | ${p(d.priceSen)} | ${d.unit ?? ''} | ${catName.get(d.categoryKey) ?? d.categoryKey} | ${d.hook ? '有' : '—'} | ${d.disassembly} | ${d.orderable ? '是' : '否'} |`);
  }
  out.push('');
  out.push('## 七、套餐规则（原文记录，本期不实现组合逻辑）', '');
  for (const b of menu.bundles) out.push(`- **${b.name}**：${b.rule}`);
  out.push('');
  return out.join('\n');
}
