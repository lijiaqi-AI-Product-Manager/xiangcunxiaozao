// 47号 §九：每个组件 / 任务出前后对比图（同一状态并排）——「前」= 上一轮交付时的样子，「后」= 现在
// 用法：node docs/design/redesign/小样/compare.mjs [轮次 47 | 48，默认 48] [对比基准提交，默认按轮次：47 → fb10765、48 → fdcfb6d]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const { chromium } = await import(pathToFileURL(join(ROOT, 'node_modules', 'playwright', 'index.mjs')).href);
const SHOTS = join(HERE, 'shots');
const ROUND = process.argv[2] ?? '48';
const BASE = process.argv[3] ?? { 47: 'fb10765', 48: 'fdcfb6d', 49: '27adf48', 51: '7fbef3b', 53: 'a3e8684', '53b': '907fad4', '53c': 'b31e5b2' }[ROUND];

// 「前」：从 git 取出基准提交的页面（不含截图），字体路径改成绝对地址
const BEFORE = mkdtempSync(join(tmpdir(), 'xiaoyang-before-'));
const rel = 'docs/design/redesign/小样/';
for (const p of execFileSync('git', ['-C', ROOT, 'ls-tree', '-r', '--name-only', '-z', BASE, rel], { encoding: 'utf8' }).split('\0').filter((p) => p && !p.includes('/shots/') && /\.(html|css|js|svg)$/.test(p))) {
  let buf = execFileSync('git', ['-C', ROOT, 'show', `${BASE}:${p}`], { maxBuffer: 1 << 26 });
  if (p.endsWith('.html')) buf = Buffer.from(buf.toString('utf8').replaceAll('../../../../brands/', pathToFileURL(join(ROOT, 'brands')).href + '/'));
  writeFileSync(join(BEFORE, basename(p)), buf);
}
const before = (f) => pathToFileURL(join(BEFORE, f)).href + '?tier=normal';
const after = (f) => pathToFileURL(join(HERE, f)).href + '?tier=normal';
const TMP = join(SHOTS, '_cmp');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const browser = await chromium.launch();
let n = 0;
// 打开页面 → 可选准备动作 → 截选择器所在区域（四周留 pad），返回图片文件名
const crop = async (href, sel, { prep, pad = 10, clip, rel } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'zh-CN' });
  const page = await ctx.newPage();
  await page.goto(href);
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.waitForTimeout(1400);
  await page.evaluate(() => document.getAnimations().forEach((a) => { if (a.animationName === 'breath' || a.animationName === 'drift') { a.pause(); a.currentTime = 0; } }));
  if (prep) await prep(page);
  let box = clip;
  if (rel) { const b = await page.locator(sel).first().boundingBox(); box = { x: b.x + rel.x, y: b.y + rel.y, width: rel.width, height: rel.height }; } // 相对元素左上角取一块（放大看细节）
  else if (!box) {
    const b = await page.locator(sel).first().boundingBox();
    box = { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: Math.min(375, b.width + pad * 2), height: b.height + pad * 2 };
  }
  const file = `c${n++}.png`;
  await page.screenshot({ path: join(TMP, file), clip: box });
  await ctx.close();
  return file;
};
const pressed = (sel) => async (page) => { await page.locator(sel).first().hover(); await page.mouse.down(); await page.waitForTimeout(200); };
const selectTab = (i) => async (page) => { await page.locator('.dock .tab').nth(i).click(); await page.waitForTimeout(400); };
// 水滴角标：点加号后把所有动画停在第 t 毫秒
const blobAt = (t) => async (page) => {
  await page.locator('.row .add').nth(1).click();
  await page.evaluate((t) => document.getAnimations().forEach((a) => { if (!['breath', 'cloud'].includes(a.animationName)) { a.pause(); a.currentTime = t; } }), t);
  await page.waitForTimeout(80);
};

const O = '点单-淡黄-现状版.html', O1 = '点单-淡黄-Dock并入.html', DT = '详情-淡黄.html';
const blobClip = { x: 0, y: 160, width: 375, height: 600 };
const FULL = { x: 0, y: 0, width: 375, height: 812 };
const toView = (sel) => async (page) => { await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), sel); await page.waitForTimeout(500); };
// 48号大画态：滚到 y，把收起过渡停在第 t 毫秒（t 不给 = 等过渡走完）
const heroAt = (y, t) => async (page) => {
  await page.evaluate((y) => window.scrollTo(0, y), y);
  await page.waitForTimeout(t === undefined ? 700 : 60);
  if (t !== undefined) await page.evaluate((t) => document.getAnimations().forEach((a) => { if (a.transitionProperty) { a.pause(); a.currentTime = t; } }), t);
  await page.waitForTimeout(60);
};
const round48 = async () => [
  ['对比-48号-三抛光与首字', [
    ['抛光 ① 算盘珠 · 120° 柔散射高光（包浆感）', '容器底上叠一层 120° 斜向柔光：左上最亮、往右下散开，末端一点暖灰，像用久了的算盘珠', [
      [await crop(before(O), '.row[data-uid=e01] .qty'), '前'], [await crop(after(O), '.row[data-uid=e01] .qty'), '后']]],
    ['抛光 ② 分类条 · 饱和度 -5%、亮度 -3%', '底色 rgba(246,234,205) → rgba(243,229,195)，透明度不变；淡绿底单独配了同样处理过的绿纸色', [
      [await crop(before(O), '.cats-wrap', { pad: 4 }), '前'], [await crop(after(O), '.cats-wrap', { pad: 4 }), '后']]],
    ['抛光 ③ 水滴 · 下落途中拉成 (1.15, 0.85) 拖尾形', '起跳回弹之后、落到购物车之前，水滴横向拉长、纵向压扁，快落地前收回圆再压扁', [
      [await crop(before(O), null, { prep: blobAt(520), clip: blobClip }), '前 · 0.52 秒'], [await crop(after(O), null, { prep: blobAt(520), clip: blobClip }), '后 · 0.52 秒'],
      [await crop(before(O), null, { prep: blobAt(650), clip: blobClip }), '前 · 0.65 秒'], [await crop(after(O), null, { prep: blobAt(650), clip: blobClip }), '后 · 0.65 秒']]],
    ['裁定 · 同组首字重复取第三字', '同一组里撞字的 16 道改取（去掉修饰词后的）第三个字：湘西土匪鸭 土 → 鸭、干锅孜然羊肉 干 → 孜、凉拌海带丝 凉 → 海……', [
      [await crop(before(O), '.grp[aria-label="开胃凉拌"] .card', { prep: toView('.grp[aria-label="开胃凉拌"]'), pad: 0 }), '前 · 开胃凉拌'],
      [await crop(after(O), '.grp[aria-label="开胃凉拌"] .card', { prep: toView('.grp[aria-label="开胃凉拌"]'), pad: 0 }), '后 · 开胃凉拌']]],
  ]],
  ['对比-48号-大画态C方案与变体', [
    ['大画态 C 方案 · 进店大图 → 滑过 240px 收成「今日招牌」横幅卡', '横幅卡从上方滑入（0.32 秒，只动 transform）、分类条跟着下移让位、后面淡入一层纸色；收起后一屏 6 道。滑回顶部再展开', [
      [await crop(after('点单-淡黄-大画态结构.html'), null, { clip: FULL }), '进店（大图，首屏 4 道）'],
      [await crop(after('点单-淡黄-大画态结构.html'), null, { clip: FULL, prep: heroAt(560, 140) }), '收起中（0.14 秒）'],
      [await crop(after('点单-淡黄-大画态结构.html'), null, { clip: FULL, prep: heroAt(560) }), '收起后（一屏 6 道）']]],
    ['变体 · 淡绿底（带大画态）', '同一套组件和 C 方案；分类条、呼吸层都换成淡绿底自己的颜色', [
      [await crop(after('点单-淡绿-大画态结构.html'), null, { clip: FULL }), '进店'], [await crop(after('点单-淡绿-大画态结构.html'), null, { clip: FULL, prep: heroAt(560) }), '收起后'],
      [await crop(after('详情-淡绿.html'), null, { clip: FULL }), '详情页']]],
    ['变体 · 墨黑结构色（带大画态）', '结构色（英文标签、选中字、竖排字、工序数字）从深墨绿换成墨黑 #2B2622，其余不变', [
      [await crop(after('点单-淡黄-墨黑-大画态结构.html'), null, { clip: FULL }), '进店'], [await crop(after('点单-淡黄-墨黑-大画态结构.html'), null, { clip: FULL, prep: heroAt(560) }), '收起后'],
      [await crop(after('详情-淡黄-墨黑结构色.html'), null, { clip: FULL }), '详情页']]],
  ]],
];
// 49号：托盘扫光停在第 t 毫秒
const glintAt = (t) => async (page) => {
  await page.evaluate(() => document.querySelector('.cartbar').classList.add('glint'));
  await page.waitForTimeout(30);
  await page.evaluate((t) => document.getAnimations().forEach((a) => { if (a.animationName === 'glint') { a.pause(); a.currentTime = t; } }), t);
  await page.waitForTimeout(40);
};
const H = '点单-淡黄-大画态结构.html';
const round49 = async () => [
  ['对比-49号-视觉冲刺', [
    ['① 进店屏宣纸肌理 + 纸纹噪点', '列表区的纸纹在背景层，大图把它盖住了；现在大图上铺一层极浅的宣纸纤维 + 噪点（正片叠底 28%）。右边两张是局部放大', [
      [await crop(before(H), null, { clip: { x: 0, y: 0, width: 375, height: 250 } }), '前'], [await crop(after(H), null, { clip: { x: 0, y: 0, width: 375, height: 250 } }), '后'],
      [await crop(before(H), null, { clip: { x: 60, y: 120, width: 120, height: 90 } }), '前 · 放大'], [await crop(after(H), null, { clip: { x: 60, y: 120, width: 120, height: 90 } }), '后 · 放大']]],
    ['② 菜名 / 描述行距 +1.4px、分组标题字重 800 → 900', '菜名行高 21.6 → 23px、描述 19.6 → 21px；一屏仍 6 道', [
      [await crop(before(O), null, { clip: { x: 0, y: 160, width: 375, height: 240 } }), '前'], [await crop(after(O), null, { clip: { x: 0, y: 160, width: 375, height: 240 } }), '后']]],
    ['③ 横幅卡收起：ease-out-back', '落下用 cubic-bezier(.34,1.56,.64,1)：落到位时往下多走一点再弹回；收回去用利落的 ease-in。下面是同一时刻的对比（第 0.2 秒前一版已经停住，这一版正在过冲）', [
      ...(await Promise.all([[before(H), 100, '前 · 0.1 秒'], [after(H), 100, '后 · 0.1 秒'], [before(H), 200, '前 · 0.2 秒'], [after(H), 200, '后 · 0.2 秒'], [after(H), 300, '后 · 0.3 秒（回弹）']]
        .map(async ([href, t, cap]) => [await crop(href, null, { clip: { x: 0, y: 0, width: 375, height: 190 }, prep: heroAt(560, t) }), cap])))]],
    ['④ 横幅卡占位：菜单头版式', '没图时不再借列表同款首字缩略，改成金棕书签条 + 28px 书法菜名 + 右侧价格锚（价格在上、直达在下）', [
      [await crop(before(H), '.today', { prep: heroAt(560), pad: 8 }), '前'], [await crop(after(H), '.today', { prep: heroAt(560), pad: 8 }), '后']]],
    ['⑥ 墨玻璃：更透 + 亮晶晶', '墨 75% → 66%（再低白字在浅色底上不到 4.5）；顶边亮线加亮、左上角光斑、斜向镜面高光；每次水滴落进购物车，托盘上扫过一道光', [
      [await crop(before(O), '.cartbar', { pad: 6 }), '前'], [await crop(after(O), '.cartbar', { pad: 6 }), '后'], [await crop(after(O), '.cartbar', { pad: 6, prep: glintAt(400) }), '后 · 扫光中'],
      [await crop(before(O), '.dock', { pad: 6 }), '前 · Dock'], [await crop(after(O), '.dock', { pad: 6 }), '后 · Dock']]],
  ]],
];
// 51号：点加号后按真实时间等到水滴落地、落点柔光出现，再把动画停住
const landedAt = (ms) => async (page) => {
  await page.locator('.row .add').nth(1).click();
  await page.waitForTimeout(ms);
  await page.evaluate(() => document.getAnimations().forEach((a) => { if (!['breath', 'cloud'].includes(a.animationName)) a.pause(); }));
  await page.waitForTimeout(40);
};
const round51 = async () => [
  ['对比-51号-墨玻璃配方', [
    ['托盘（V2 去结算条）', '底：均匀墨 66% → 135° 渐变（左上 .68 薄亮 → 右下 .52 厚暗）；滤镜：模糊 10px → 18px + 饱和度 160% + 亮度 1.06；边缘光：一条均匀亮线 → 顶亮 / 左弱 / 底极弱 / 右无；左上静态柔光斑；表面极细噪点；白字、淡金字双层投影。⚠ 截图不渲染背景模糊，只能看结构，玻璃感以手机为准', [
      [await crop(before(O), '.cartbar', { pad: 8 }), '前（49号）'], [await crop(after(O), '.cartbar', { pad: 8 }), '后（51号）']]],
    ['局部放大：边缘光、光斑、噪点', '托盘左上角 120×44 放大：顶边亮线、左边弱光、左上暖白光斑、表面颗粒', [
      [await crop(before(O), '.cartbar', { rel: { x: -4, y: -4, width: 120, height: 44 } }), '前'], [await crop(after(O), '.cartbar', { rel: { x: -4, y: -4, width: 120, height: 44 } }), '后']]],
    ['Dock（只放图标，墨色再透一档）', '同一配方，渐变两端 .60 / .45；6 倍降速连点加购掉帧后按规格 6 降档：Dock 模糊 14px、去掉饱和度（托盘保 18px + 饱和度）。未选中页签字改纯白 + 加深一点的投影，白底最坏情况对比度 4.59', [
      [await crop(before(O), '.dock', { pad: 8 }), '前'], [await crop(after(O), '.dock', { pad: 8 }), '后']]],
    ['V1 并入 Dock', '带价格文字，用托盘配方（.68 / .52、18px、饱和度 160%）', [
      [await crop(before(O1), '.dock', { pad: 8 }), '前'], [await crop(after(O1), '.dock', { pad: 8 }), '后']]],
    ['加购反馈：斜向扫光 → 落点柔光扩散', '49号的斜向镜面扫光废止；水滴落进购物车时，落点一团暖白柔光扩散（scale 0 → 1.4、透明度 .35 → 0，0.5 秒）', [
      [await crop(before(O), '.cartbar', { pad: 8, prep: glintAt(400) }), '前 · 扫光'],
      [await crop(after(O), '.cartbar', { pad: 30, prep: landedAt(1000) }), '后 · 落点柔光（约 0.14 秒）'],
      [await crop(after(O), '.cartbar', { pad: 30, prep: landedAt(1180) }), '后 · 扩散（约 0.3 秒）']]],
    ['列表卡片：去掉背景模糊', '规格要求「列表卡片继续禁 backdrop-filter」——实际原来带着 16px 模糊，已去掉，改成不模糊的白 80%', [
      [await crop(before(O), null, { clip: { x: 0, y: 200, width: 375, height: 230 } }), '前（模糊 16px）'], [await crop(after(O), null, { clip: { x: 0, y: 200, width: 375, height: 230 } }), '后（不模糊）']]],
  ].filter(([, , imgs]) => imgs.length)],
];
// 53号：只为对比图临时换一下价格字体（看三种写法）
const priceFont = (css) => async (page) => { await page.addStyleTag({ content: css }); await page.waitForTimeout(150); };
const round53 = async () => [
  ['对比-53号-S形状圆化', [
    ['去结算按钮：六边形切角 → 圆角长方形', '和托盘同一个形状家族：独立条上的按钮 radius 20px（高 44，45%）；V1 并入 Dock 的按钮高 52，按「≥ 高度 40%」取 22px。深红底 + 淡金字保留', [
      [await crop(before(O), '.cartbar', { pad: 8 }), '前 · V2'], [await crop(after(O), '.cartbar', { pad: 8 }), '后 · V2'],
      [await crop(before(O1), '.dock', { pad: 8 }), '前 · V1'], [await crop(after(O1), '.dock', { pad: 8 }), '后 · V1']]],
    ['加号：小圆角方块 → 正圆', '视觉直径 32px（border-radius 50%），触控热区仍 44×44；按下缩到 0.92 的盖章手感不变', [
      [await crop(before(O), '.row:nth-child(2) .add', { pad: 6 }), '前'], [await crop(after(O), '.row:nth-child(2) .add', { pad: 6 }), '后'],
      [await crop(before(O), '.row[data-uid=e01] .qty', { pad: 6 }), '前 · 算盘珠'], [await crop(after(O), '.row[data-uid=e01] .qty', { pad: 6 }), '后 · 算盘珠']]],
    ['表里没列、按总则补齐的小件', '缩略图 64px：16px（25%）→ 26px（41%）；分类条原来只有上边两个角圆 → 胶囊；列表外容器 20 → 24px；托盘 23px、Dock 26px（都 ≥ 高度 40%）', [
      [await crop(before(O), null, { clip: { x: 0, y: 106, width: 375, height: 230 } }), '前'], [await crop(after(O), null, { clip: { x: 0, y: 106, width: 375, height: 230 } }), '后']]],
  ]],
  ['对比-53号-T书法字体', [
    ['门店区：店名、桌号、等待时间换书法', '店名 22px、桌号 16px、「16 分钟」21px；招牌三句（明厨亮灶…）是正文层，不换', [
      [await crop(before(O), '.store', { pad: 6 }), '前'], [await crop(after(O), '.store', { pad: 6 }), '后']]],
    ['列表：分组标题 20px、菜名 18px、价格 17px（书法），描述不换', '书法只有一种粗细：用加深一档的墨色 #221E1B 替代字重；价格朱砂 #C8372D 在纸白卡上 4.66 贴线，按 T3 加深到 #B02A21', [
      [await crop(before(O), null, { clip: { x: 0, y: 160, width: 375, height: 300 } }), '前'], [await crop(after(O), null, { clip: { x: 0, y: 160, width: 375, height: 300 } }), '后']]],
    ['底部：导航 13px、去结算、合计换书法；导航选中改朱砂', '页签字在墨玻璃上加投影，白底最坏情况最低 4.52', [
      [await crop(before(O), null, { clip: { x: 0, y: 660, width: 375, height: 152 } }), '前'], [await crop(after(O), null, { clip: { x: 0, y: 660, width: 375, height: 152 } }), '后']]],
    ['⚠ 价格「RM 48」三种写法（请军师 / 高斯定）', '马善政的英文字母是手写西文：「RM」读起来像「Rm」——正好是高斯三看第 ② 条担心的「写的什么都不像」。左：按规格整串书法；中：「RM 48」整串 Cinzel 衬线（和英文标签同一字体）；右：现状黑体', [
      [await crop(after(O), null, { clip: { x: 80, y: 220, width: 200, height: 210 } }), '整串书法（规格）'],
      [await crop(after(O), null, { clip: { x: 80, y: 220, width: 200, height: 210 }, prep: priceFont('.price,.sum{font-family:var(--font-latin)!important;font-weight:700!important;letter-spacing:.04em!important}') }), 'Cinzel 衬线'],
      [await crop(before(O), null, { clip: { x: 80, y: 220, width: 200, height: 210 } }), '黑体（前）']]],
    ['详情页：标题、价格、拆开看看、底栏', '详情正文段落、食材说明不换（正文层红线）', [
      [await crop(before(DT), null, { clip: { x: 0, y: 380, width: 375, height: 200 } }), '前'], [await crop(after(DT), null, { clip: { x: 0, y: 380, width: 375, height: 200 } }), '后'],
      [await crop(before(DT), '.dbar', { pad: 6 }), '前 · 底栏'], [await crop(after(DT), '.dbar', { pad: 6 }), '后 · 底栏']]],
  ]],
];
// 53号按高斯原话修订（53b）：透感、数字英文、字号、楷体正文、大画卡边距、手机水印
const H2 = '点单-淡黄-大画态结构.html', WB = '点单-淡黄-水印B门店落款.html';
const round53b = async () => [
  ['对比-53号修订-透感与字体', [
    ['店名框 / 分类条 / 列表：白板 → 纸白毛玻璃（透一点点）', '纸白 rgba(255,253,246) 店名框 .72、列表 .68、分类条 .70（真模糊 12px + 饱和度 140%）、算盘珠 .84（先按 .78 做，截图里和白板几乎没区别，再透一档）；墨晕和背景水印隐约透上来；每块顶边一道 1px 亮光、左边一丝、表面极细噪点、左上极淡柔光。真背景模糊只给背后有滚动内容的层（分类条、托盘、Dock），同屏最多 3 层', [
      [await crop(before(O), null, { clip: { x: 0, y: 0, width: 375, height: 420 } }), '前'], [await crop(after(O), null, { clip: { x: 0, y: 0, width: 375, height: 420 } }), '后']]],
    ['数字和英文：不用书法，改衬线体', '「RM 48」「16 分钟」「桌 8」「RM 96」、角标数字都换成和 CHEF\'S PICKS 同一家的衬线体（Cinzel）；汉字仍是书法。做法是一个字体名下数字英文走衬线、汉字走书法，不用逐处改', [
      [await crop(before(O), null, { clip: { x: 0, y: 0, width: 375, height: 120 } }), '前 · 门店区'], [await crop(after(O), null, { clip: { x: 0, y: 0, width: 375, height: 120 } }), '后 · 门店区'],
      [await crop(before(O), '.cartbar', { pad: 6 }), '前 · 托盘'], [await crop(after(O), '.cartbar', { pad: 6 }), '后 · 托盘']]],
    ['字号：店名 22 → 24、招牌三句 14 → 16、分类 15 → 17、底部页签 13 → 14', '都只大 1–2 号；一屏仍 6 道', [
      [await crop(before(O), '.cats-wrap', { pad: 4 }), '前 · 分类'], [await crop(after(O), '.cats-wrap', { pad: 4 }), '后 · 分类'],
      [await crop(before(O), '.dock', { pad: 6 }), '前 · 页签'], [await crop(after(O), '.dock', { pad: 6 }), '后 · 页签']]],
    ['详情正文用楷体（字号不变），区块标题保持', '详细介绍、源流、工序、食材说明换楷体；手机上没有自带楷体时会退到宋体（见说明第三节）', [
      [await crop(before(DT), '.sec', { pad: 6, prep: toView('.sec') }), '前'], [await crop(after(DT), '.sec', { pad: 6, prep: toView('.sec') }), '后']]],
  ]],
  ['对比-53号修订-大画卡与水印', [
    ['大画卡：贴屏 → 左右留 14px，看得出是一张卡', '圆角 20px + 边缘光 + 轻投影，浮在纸上；收起后的横幅卡同步 14px 边距。小标签「湘味油泼牛肉 RM 48」原样不动', [
      [await crop(before(H2), null, { clip: { x: 0, y: 0, width: 375, height: 300 } }), '前'], [await crop(after(H2), null, { clip: { x: 0, y: 0, width: 375, height: 300 } }), '后'],
      [await crop(after(H2), null, { clip: { x: 0, y: 0, width: 375, height: 200 }, prep: heroAt(560) }), '后 · 收起后横幅卡']]],
    ['手机上看得见「湘村小灶」：A / B 两个变体', 'A：水印进大画卡，大图左下竖排（SIGNATURE 旁边，灰墨 9%，画册落款）。B：并入门店框右下（灰墨 10%，不占高度）——独立的落款带 48–64px 都会把首屏挤到 5 道（实测只剩 9px 余量），按规格退到「并入门店区下沿」；B 在 360 宽的窄屏上放不下会自动不显示，不压字', [
      [await crop(before(O), null, { clip: { x: 0, y: 0, width: 375, height: 300 } }), '前（被面板挡死）'],
      [await crop(after(H2), null, { clip: { x: 0, y: 0, width: 375, height: 300 } }), 'A · 大画卡内'],
      [await crop(after(WB), null, { clip: { x: 0, y: 0, width: 375, height: 300 } }), 'B · 门店框右下']]],
  ]],
];
// 53号第二次修订（53c）：前置大水印、湘字圆印、点按印章、大画多张、详情实物图位 + 标题组
const tapAt = (x, y, t) => async (page) => {
  await page.mouse.move(x, y); await page.mouse.down(); await page.waitForTimeout(t); await page.mouse.up();
  await page.evaluate(() => document.getAnimations().forEach((a) => { if (!['breath', 'cloud', 'deck'].includes(a.animationName)) a.pause(); }));
  await page.waitForTimeout(40);
};
const swipeTo = (frac) => async (page) => { await page.evaluate((f) => { const t = document.querySelector('.hero-track'); t.style.scrollSnapType = 'none'; t.scrollLeft = t.clientWidth * f; }, frac); await page.waitForTimeout(500); };
const midList = async (page) => { await page.evaluate(() => window.scrollTo(0, 1400)); await page.waitForTimeout(800); };
const round53c = async () => [
  ['对比-53号二改-水印印章大画', [
    ['大水印挪到面板前面', '「湘村小灶」四个大字从背景层挪到店名框、分类条、列表的前面（托盘、Dock 之下），浅墨 7%：手机上不会再被面板盖死；字处仍是原来的墨色、不挡点按。小水印 A（大画卡内）、B（门店框右下）同时保留', [
      [await crop(before(O), null, { clip: FULL, prep: midList }), '前（只隐约看得到）'], [await crop(after(O), null, { clip: FULL, prep: midList }), '后']]],
    ['店标圆印「灶」→「湘」；方形小印仍是「灶」', '字写在品牌配置里（logoSeal），代码里不写死', [
      [await crop(before(O), '.store .seal', { pad: 8 }), '前'], [await crop(after(O), '.store .seal', { pad: 8 }), '后']]],
    ['点到哪里都盖一枚「湘」字小印（替代加号落印、触摸涟漪）', '手机、电脑都一样：按下处印盖下去 → 停一下 → 淡掉（0.7 秒，只动 transform / opacity）；减弱动态效果下只是出现一下再消失', [
      [await crop(before(O), null, { clip: { x: 150, y: 220, width: 225, height: 200 }, prep: tapAt(240, 330, 120) }), '前（涟漪光）'],
      [await crop(after(O), null, { clip: { x: 150, y: 220, width: 225, height: 200 }, prep: tapAt(240, 330, 120) }), '后 · 点列表'],
      [await crop(after(O), null, { clip: { x: 200, y: 580, width: 175, height: 230 }, prep: tapAt(310, 750, 120) }), '后 · 点底部导航']]],
    ['大画态：多张左右滑动，后面露出叠着的卡（堆叠态）', '演示放三张菜单里现有的招牌（湘味油泼牛肉、招牌跳跳蛙、脆皮爆汁烤鱼，价格照菜单）；右上小点显示第几张；滑走的那张轻轻缩小变淡；收起后的「今日招牌」横幅卡跟着当前这张换', [
      [await crop(before(H2), null, { clip: { x: 0, y: 0, width: 375, height: 330 } }), '前（单张）'],
      [await crop(after(H2), null, { clip: { x: 0, y: 0, width: 375, height: 330 } }), '后 · 第 1 张'],
      [await crop(after(H2), null, { clip: { x: 0, y: 0, width: 375, height: 330 }, prep: swipeTo(0.5) }), '后 · 滑动中'],
      [await crop(after(H2), null, { clip: { x: 0, y: 0, width: 375, height: 330 }, prep: swipeTo(1) }), '后 · 第 2 张']]],
  ]],
  ['对比-53号二改-详情页', [
    ['大图位留给实物图 / 手绘图；英文竖排 + 书法菜名 + 一笔浓墨 + 方印挪到价格上面', '没图时大图位只留水墨底 + 云斑（图到了自动换成实物图）；原来压在图上的标题组整组搬到价格上面，替换原来那行书法菜名。方印仍是 2 处（标题 + 风味之路）', [
      [await crop(before(DT), null, { clip: { x: 0, y: 0, width: 375, height: 560 } }), '前'], [await crop(after(DT), null, { clip: { x: 0, y: 0, width: 375, height: 560 } }), '后']]],
    ['详情正文换自托管楷体（霞鹜文楷）', '这台电脑有系统楷体，所以「前」也是楷体；手机上原来会退成宋体，现在字体跟着页面走，手机上也是楷体。只裁了详情正文用到的 1089 个字，241KB', [
      [await crop(before(DT), '.sec p', { pad: 6, prep: toView('.sec') }), '前（电脑系统楷体）'], [await crop(after(DT), '.sec p', { pad: 6, prep: toView('.sec') }), '后（霞鹜文楷）']]],
  ]],
];
const sheets = ROUND === '53c' ? await round53c() : ROUND === '53b' ? await round53b() :ROUND === '53' ? await round53() :ROUND === '51' ? await round51() :ROUND === '49' ? await round49() : ROUND === '48' ? await round48() : [
  ['对比-47号-六组件', [
    ['组件 1 · 朱砂印（加号）', '正圆 → 圆角方；朱砂 135° 渐变 + 红系投影 + 顶部内高光 + 1px 白描边。按下 = 整颗缩到 0.92、投影变近变淡（像印章按进纸里），松开带回弹。触控区仍 44×44', [
      [await crop(before(O), '.row:nth-child(2) .add'), '前'], [await crop(after(O), '.row:nth-child(2) .add'), '后'],
      [await crop(before(O), '.row:nth-child(2) .add', { prep: pressed('.row:nth-child(2) .add') }), '前 · 按下'], [await crop(after(O), '.row:nth-child(2) .add', { prep: pressed('.row:nth-child(2) .add') }), '后 · 按下']]],
    ['组件 2 · 算盘珠（数量调节器）', '减号 / 数字 / 加号装进一个浅色一体化容器（白 90% + 模糊）；加减号、数字用 Cinzel 衬线字形；减号深灰 #333、加号朱砂', [
      [await crop(before(O), '.row[data-uid=e01] .qty'), '前'], [await crop(after(O), '.row[data-uid=e01] .qty'), '后']]],
    ['组件 3 · 墨玻璃托盘（V2 独立去结算条）', '底 = 墨 75% + 模糊 10px + 顶部 1px 微光线；去结算 = 深红 → 暗红渐变 + 淡金字（对比度 6.3），两端微尖', [
      [await crop(before(O), '.cartbar'), '前'], [await crop(after(O), '.cartbar'), '后']]],
    ['组件 3 · 墨玻璃托盘（V1 并入 Dock）', '同一套托盘和烫金按钮；V1 / V2 都改了，最终看图选', [
      [await crop(before(O1), '.dock'), '前'], [await crop(after(O1), '.dock'), '后']]],
    ['组件 4 · 谷雨式分类条', '不要白药丸：字 + 条底金棕细线 + 选中项朱红圆点；选中字用结构色（深墨绿）加粗；条本体半透明纸色', [
      [await crop(before(O), '.cats-wrap', { pad: 4 }), '前'], [await crop(after(O), '.cats-wrap', { pad: 4 }), '后']]],
    ['组件 5 / 6 · 浮动胶囊 Dock + 药丸印章选中态', '离底 10px 悬浮、圆角 22px、墨玻璃底、大面积弥散阴影；选中 = 浅色药丸 + 品牌色微立体图标，未选中灰阶平铺；切换时药丸 180ms 滑过去', [
      [await crop(before(O), '.dock', { pad: 14 }), '前'], [await crop(after(O), '.dock', { pad: 14 }), '后 · 选中「点单」'], [await crop(after(O), '.dock', { pad: 14, prep: selectTab(1) }), '后 · 点「取餐」后']]],
    ['附加 · 水滴 blob 角标（前：只有落印）', '落印之后，「+1」水滴从加号挤出（压扁 → 回弹）→ 沿弧线飞向购物车 → 落下压扁消失，购物车角标这时才弹一下。路径、形变都只用 transform', [
      [await crop(before(O), null, { prep: blobAt(150), clip: blobClip }), '前 · 0.15 秒'],
      ...(await Promise.all([200, 330, 520, 700, 820].map(async (t) => [await crop(after(O), null, { prep: blobAt(t), clip: blobClip }), `后 · ${t / 1000} 秒`])))]],
  ]],
  ['对比-47号-排版缩略图图标大画位', [
    ['任务 B · 点单页分组标题', '英文从贴字升为结构元素：全大写、字距 0.15em、Cinzel 700，后面接一条细金线横贯到「13 道」，做成分割行（同一行，不加高度）', [
      [await crop(before(O), '.grp-head', { pad: 6 }), '前'], [await crop(after(O), '.grp-head', { pad: 6 }), '后']]],
    ['任务 B1 · 详情页区块标题（绿茶式双层）', '中文粗黑 26px / 英文宽体衬线全大写独立一行（字距 0.18em）/ 1px 细金线 #8C6A3F 横贯；方块字去掉', [
      [await crop(before(DT), '.sec-head', { pad: 8, prep: async (p) => p.evaluate(() => document.querySelector('.sec').scrollIntoView({ block: 'center' })) }), '前'],
      [await crop(after(DT), '.sec-head', { pad: 8, prep: async (p) => p.evaluate(() => document.querySelector('.sec').scrollIntoView({ block: 'center' })) }), '后']]],
    ['任务 C · 缩略图首字（C-A 墨字 / C-B 马卡龙，高斯二选一）', '两版都已按 43号跳过修饰词（招牌剁椒鱼 → 剁、糖醋排骨 → 排、湘味油泼牛肉 → 油）；C-A 墨痕减淡一档；C-B = 四色「有色的白」按菜品固定一色 + 顶部 1px 内高光 + 底部微阴影', [
      [await crop(before(O), null, { clip: { x: 16, y: 200, width: 100, height: 470 } }), '前（第二轮）'],
      [await crop(after(O), null, { clip: { x: 16, y: 200, width: 100, height: 470 } }), 'C-A 墨字'],
      [await crop(after('点单-淡黄-现状版-马卡龙.html'), null, { clip: { x: 16, y: 200, width: 100, height: 470 } }), 'C-B 马卡龙']]],
    ['任务 D · 图标微立体', '同色系深浅渐变 + 顶部 40% 白高光弧 + 底部同色投影；选中页签用品牌色，返回 / 展开等功能位用墨色，未选中页签保持灰阶平铺（组件 6 的规格）', [
      [await crop(before(O), '.tab.on', { pad: 2 }), '前 · 选中页签'], [await crop(after(O), '.tab.on', { pad: 2 }), '后 · 选中页签'],
      [await crop(before(DT), '.circle-btn', { pad: 4 }), '前 · 返回'], [await crop(after(DT), '.circle-btn', { pad: 4 }), '后 · 返回']]],
    ['任务 E1 · 点单页顶部双模态', 'images.json 不写 heroDish = 无图态（现状不变）；写了 = 大画态（全幅大图 + 径向聚光 + 左下竖排 SIGNATURE + 价格锚，门店信息浮在图上）。这里借水墨占位演示结构，真图由军师管线出', [
      [await crop(after(O), null, { clip: { x: 0, y: 0, width: 375, height: 300 } }), '无图态（生产默认）'],
      [await crop(after('点单-淡黄-大画态结构.html'), null, { clip: { x: 0, y: 0, width: 375, height: 300 } }), '大画态（结构演示）']]],
  ]],
];

for (const [name, sections] of sheets) {
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#fff;font:15px/1.5 "Microsoft YaHei",sans-serif;color:#2B2622;width:760px}
section{margin-bottom:30px}h2{font-size:18px;margin:0 0 4px}p{margin:0 0 10px;color:#5F564C}.row{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}figure{margin:0}figcaption{text-align:center;margin-top:4px;font-size:13px}
img{display:block;max-width:360px;max-height:420px;border-radius:10px;box-shadow:0 0 0 1px #0002}</style>
${sections.map(([t, note, imgs]) => `<section><h2>${t}</h2><p>${note}</p><div class="row">${imgs.map(([src, cap]) => `<figure><img src="_cmp/${src}"><figcaption>${cap}</figcaption></figure>`).join('')}</div></section>`).join('')}`;
  writeFileSync(join(SHOTS, '_sheet.html'), html);
  const ctx = await browser.newContext({ viewport: { width: 808, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(join(SHOTS, '_sheet.html')).href);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
  await ctx.close();
}
await browser.close();
rmSync(join(SHOTS, '_sheet.html'));
rmSync(TMP, { recursive: true, force: true });
rmSync(BEFORE, { recursive: true, force: true });
console.log(`对比图：${sheets.map(([n]) => `${n}.png`).join('、')}`);
