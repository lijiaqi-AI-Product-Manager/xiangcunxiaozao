// 56号 前后对比图：会员黑金 / 我的页 / 印章 + 水滴 / 菜名一行 / 取餐「请取餐」去绿。前 = 上一次交付（e72f981）的截图，目录由 OLD56_DIR 指定；后 = 现在主程序实拍
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'docs', 'screenshots', 'p4-redesign');
mkdirSync(OUT, { recursive: true });
const OLD = process.env.OLD56_DIR ?? '';
const CUSTOMER = 'http://localhost:5183';
const API = 'http://localhost:8788';
const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const old = (f: string) => readFileSync(resolve(OLD, f)).toString('base64');

test.skip(!OLD || !existsSync(resolve(OLD, '15-会员-会员卡.png')), '没有指定上一版截图目录（OLD56_DIR）');
test.use({ actionTimeout: 10_000 });

const png = async (page: Page, clip?: { x: number; y: number; width: number; height: number }) => (await page.screenshot({ clip })).toString('base64');
const calm = async (page: Page) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(700); };
async function sheet(page: Page, file: string, title: string, rows: { label: string; cells: { img: string; cap: string; w?: number }[] }[]) {
  await page.setViewportSize({ width: 1200, height: 400 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:20px;background:linen;font:15px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:black}
    h1{font-size:22px;margin:0 0 14px}.row{display:flex;flex-wrap:wrap;gap:16px;margin-bottom:18px;align-items:flex-start}
    .lab{writing-mode:vertical-rl;font-weight:700;font-size:18px;padding:6px 4px;border-radius:6px;background:black;color:white}
    .row.after .lab{background:darkgoldenrod}figure{margin:0}img{display:block;border-radius:12px;box-shadow:0 2px 10px silver}
    figcaption{padding:6px 2px 0;font-size:14px;max-width:375px}</style><h1>${title}</h1>
    ${rows.map((r, i) => `<div class="row${i ? ' after' : ''}"><div class="lab">${r.label}</div>${r.cells.map((c) => `<figure><img style="width:${c.w ?? 260}px" src="data:image/png;base64,${c.img}"><figcaption>${c.cap}</figcaption></figure>`).join('')}</div>`).join('')}`);
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(OUT, file), fullPage: true });
}
let token = '';
async function admin(request: APIRequestContext, path: string, data: unknown) {
  if (!token) token = ((await (await request.post(`${API}/api/admin/login`, { data: { password: 'e2e-test-password' } })).json()) as { token: string }).token;
  return (await request.post(`${API}${path}`, { data, headers: { authorization: `Bearer ${token}` } })).json() as Promise<Record<string, string>>;
}

test('56号 前后对比图', async ({ browser, request }) => {
  test.setTimeout(300_000);
  const page = await (await browser.newContext(PHONE)).newPage();
  const out = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();

  // ---------- 会员体系 ----------
  await page.goto(`${CUSTOMER}/?table=8&tier=normal#member`);
  await expect(page.getByRole('form', { name: '会员登录' })).toBeVisible();
  await calm(page);
  const login = await png(page);
  const m = await admin(request, '/api/admin/members', { phone: '0100000456', pin: '2468' });
  await admin(request, `/api/admin/members/${m.id}/recharge`, { amountSen: 20000, note: '测试充值', requestId: 'compare56-recharge-1' });
  const f = page.getByRole('form', { name: '会员登录' });
  await f.getByLabel('会员号').fill(m.memberNo!);
  await f.getByLabel('4 位密码').fill('2468');
  await f.getByRole('button', { name: '登录会员' }).click();
  await expect(page.locator('.balance')).toBeVisible();
  await calm(page);
  const card = await png(page);
  const tones: string[] = [];
  for (const t of ['black', 'earth', 'gold', 'platinum']) {
    await page.goto(`${CUSTOMER}/?table=8&tier=normal&card=${t}#member`);
    await expect(page.locator('.member-card')).toBeVisible();
    await calm(page);
    const b = (await page.locator('.member-card').boundingBox())!;
    tones.push(await png(page, { x: b.x - 6, y: b.y - 6, width: b.width + 12, height: b.height + 12 }));
  }
  await sheet(out, '对比-56号-会员黑金.png', '56号：会员体系黑金化（登录页黑金卡、「登录会员」黑条金字；会员卡按大画卡的语言做成黑金卡面）', [
    { label: '前', cells: [{ img: old('14-会员-登录前.png'), cap: '登录页：白卡 + 红底白字按钮' }, { img: old('15-会员-会员卡.png'), cap: '会员卡：白底红字平卡' }] },
    { label: '后', cells: [{ img: login, cap: '登录页：黑金卡浮在宣纸上，深色玻璃输入框 + 金细线，「登录会员」黑条金字' }, { img: card, cap: '会员卡：竖排 SIGNATURE + 竖排书法水印 + 双环圆戳 + 鎏金余额 + 远山暗纹' }] },
    { label: '色板', cells: tones.map((img, i) => ({ img, w: 280, cap: ['黑金（现用）', '土黄金（?card=earth）', '黄金（?card=gold）', '铂金（?card=platinum）'][i]! })) },
  ]);

  // ---------- 我的页 ----------
  await page.goto(`${CUSTOMER}/?table=8&tier=normal#me`);
  await expect(page.getByRole('heading', { name: `会员 ${m.memberNo}` })).toBeVisible();
  await calm(page);
  await sheet(out, '对比-56号-我的页.png', '56号：我的页去掉绿 / 蓝 / 粉——顶卡黑金，功能格同一暖土色系的深浅，会员储值那格黑金', [
    { label: '前', cells: [{ img: old('16-我的.png'), cap: '墨绿顶卡 + 莫兰迪绿 / 粉 / 蓝 / 米黄四格' }] },
    { label: '后', cells: [{ img: await png(page), cap: '黑金顶卡 + 宣纸金 / 驼色 / 黑金 / 赭金四格' }] },
  ]);

  // ---------- 印章（双环、停得更久）+ 水滴 ----------
  await page.goto(`${CUSTOMER}/?table=8&tier=normal`);
  await expect(page.getByRole('heading', { name: '招牌跳跳蛙' })).toBeVisible();
  await calm(page);
  const stampAt = async (x: number, y: number, wait: number) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(wait);
    // 截图本身要几百毫秒：先把动画停在这一刻再截，截完放开
    await page.evaluate(() => document.getAnimations().forEach((a) => a.pause()));
    const img = await png(page, { x: x - 90, y: y - 70, width: 180, height: 140 });
    await page.evaluate(() => document.getAnimations().forEach((a) => a.play()));
    await page.mouse.move(2, 400); // 松手前移开：按下点可能落在菜名链接上，原地松手会点进详情
    await page.mouse.up();
    await page.waitForTimeout(1400);
    return img;
  };
  const s1 = await stampAt(170, 160, 250);
  const s2 = await stampAt(170, 160, 850);
  const add = (await page.getByRole('button', { name: '加购 招牌跳跳蛙' }).boundingBox())!;
  await page.getByRole('button', { name: '加购 招牌跳跳蛙' }).click();
  await page.waitForTimeout(420);
  const drop = await png(page, { x: 0, y: Math.max(0, add.y - 160), width: 375, height: 812 - Math.max(0, add.y - 160) });
  await sheet(out, '对比-56号-印章与水滴.png', '56号：圆戳回到原来的双环章；点按小印停约 0.8 秒；水滴更大、抛得更高', [
    { label: '前', cells: [{ img: old('对比-问题一-印章.png'), w: 600, cap: '上一版：单细环，0.7 秒就淡掉' }] },
    { label: '后', cells: [{ img: s1, w: 220, cap: '按下 0.25 秒：双环湘字章' }, { img: s2, w: 220, cap: '按下 0.85 秒：还停着' }, { img: drop, w: 260, cap: '加购：红色水滴「+1」从加号抛向下面的结算托盘' }] },
  ]);

  // ---------- 菜名一行 ----------
  const names: string[] = [];
  for (const uid of ['s04', 's01', 'l02', 'e02']) {
    await page.goto(`${CUSTOMER}/?table=8&tier=normal#dish/${uid}`);
    await expect(page.locator('.detail-name')).toBeVisible();
    await calm(page);
    names.push(await png(page, { x: 0, y: 330, width: 375, height: 220 }));
  }
  await sheet(out, '对比-56号-菜名一行.png', '56号：菜名一行（详情页标题框原来缩成最窄宽度，短名字也被断成两行；现在先降字号、再收字距，全量自查见 56号菜名断行自查.md）', [
    { label: '前', cells: [{ img: old('总览-01.png'), w: 1100, cap: '上一版详情页首屏总览：芭乐甘露、西瓜椰青茶、招牌手打柠檬茶……都断成两行' }] },
    { label: '后', cells: names.map((img, i) => ({ img, w: 260, cap: ['芭乐甘露', '西瓜椰青茶', '单枞鸭香手打柠檬茶（9 字，自动降到 28px）', '招牌剁椒鱼'][i]! })) },
  ]);

  // ---------- 取餐「请取餐」去绿 ----------
  await page.goto(`${CUSTOMER}/?table=8&tier=normal`);
  await page.getByRole('button', { name: '加购 农家一碗香' }).click();
  await page.locator('.cartbar-go').click();
  await page.getByText('现金（到柜台）').click();
  await page.getByRole('button', { name: /提交订单/ }).click();
  await expect(page.locator('.hero-no')).toBeVisible();
  const device = await page.evaluate(() => localStorage.getItem('cart-id'));
  const [o] = await (await page.request.get(`${API}/api/order/mine?device=${device}`)).json() as { id: string }[];
  await admin(request, `/api/admin/orders/${o!.id}/status`, { to: 'cooking' });
  await admin(request, `/api/admin/orders/${o!.id}/status`, { to: 'done' });
  await page.reload();
  await expect(page.locator('.hero-status')).toHaveText('已完成');
  await calm(page);
  await sheet(out, '对比-56号-取餐请取餐.png', '56号：取餐「请取餐」状态从绿色改成黑金胶囊鎏金字', [
    { label: '前', cells: [{ img: old('12-取餐-请取餐.png'), cap: '绿色胶囊' }] },
    { label: '后', cells: [{ img: await png(page), cap: '黑金胶囊 + 鎏金字（图标 + 文字 + 颜色三重编码不变）' }] },
  ]);
});
