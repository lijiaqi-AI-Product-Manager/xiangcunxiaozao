// P2 第三批验收：菜品管理（改价/上传图片/上下架）→ 暂停接单与打烊 → 页内取消原因 → 对账全局横幅 + 红点
// → 断网重连补单 → 「我的」首屏退出会员。截图存进 docs/screenshots/p2-batch3/
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test, type Page } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = resolve(ROOT, 'docs', 'screenshots', 'p2-batch3');
mkdirSync(SHOTS, { recursive: true });
const CUSTOMER = 'http://localhost:5183';
const ADMIN = 'http://localhost:5184';
const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage });

/** 吉隆坡现在几点之后 h 小时的 HH:MM，用来设一个「当前不在营业时间」的窗口 */
const klPlus = (h: number) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.now() + h * 3600000));

async function placeCashOrder(phone: Page, dishLabel: string) {
  await phone.goto(`${CUSTOMER}/?table=9`);
  await phone.getByRole('button', { name: `加购 ${dishLabel}` }).click();
  await expect(phone.locator('.cartbar-go')).toBeVisible({ timeout: 10000 });
  await phone.locator('.cartbar-go').click();
  await phone.getByText('现金（到柜台）').click();
  await phone.getByRole('button', { name: /提交订单/ }).click();
  await expect(phone.locator('.hero-status')).toHaveText('待制作');
  return (await phone.locator('.hero-no').innerText()).trim();
}

test('菜品管理与营业', async ({ browser }) => {
  test.setTimeout(300_000); // 这一条覆盖的步骤最多（含断网等待），单独放宽
  const phone = await (await browser.newContext(PHONE)).newPage();
  const deskCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const desk = await deskCtx.newPage();
  desk.on('dialog', (d) => void d.accept()); // 改价、暂停接单的二次确认
  const nav = (name: string) => desk.locator('.side').getByRole('link', { name: new RegExp(`^${name}`) });
  const row = (name: string) => desk.locator('.dish-table tbody tr', { has: desk.getByRole('cell', { name, exact: true }) });

  await test.step('老板改价：E01 RM 48 → 52，显示菜单原价', async () => {
    await desk.goto(ADMIN);
    await desk.getByLabel('老板密码').fill('e2e-test-password');
    await desk.getByRole('button', { name: '登录' }).click();
    await nav('菜品管理').click();
    await expect(row('招牌跳跳蛙')).toBeVisible();
    await shot(desk, '01-老板-菜品管理');
    await desk.getByLabel('招牌跳跳蛙 价格').fill('52');
    await row('招牌跳跳蛙').getByRole('button', { name: '保存' }).click();
    await expect(row('招牌跳跳蛙')).toContainText('菜单原价 48');
  });

  await test.step('上传图片：正常图片成功；改了后缀的假图片给出可读提示', async () => {
    // 测试用占位图（只存在于自动测试的临时数据库里，不是菜品图）。
    // 30号 §三.4：上传测试专用「下饭咸鸭蛋」这道 fixture 菜——不进任何截图基线，招牌菜不再被测试图污染
    const png = await desk.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = c.height = 240;
      const g = c.getContext('2d')!;
      g.fillStyle = 'gray';
      g.fillRect(0, 0, 240, 240);
      g.fillStyle = 'white';
      g.font = '32px sans-serif';
      g.fillText('测试图片', 56, 130);
      return c.toDataURL('image/png').split(',')[1]!;
    });
    await desk.getByLabel('上传 下饭咸鸭蛋 图片').setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await expect(row('下饭咸鸭蛋').getByRole('button', { name: '换图' })).toBeVisible();
    await desk.getByLabel('上传 招牌剁椒鱼 图片').setInputFiles({ name: 'fake.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not really an image') });
    await expect(desk.getByRole('alert').filter({ hasText: '招牌剁椒鱼' })).toContainText('只支持 JPG、PNG、WebP 格式的图片');
    await shot(desk, '02-老板-改价与上传');
  });

  await test.step('下架爆炒土豆丝', async () => {
    await desk.getByRole('group', { name: '爆炒土豆丝 状态' }).getByRole('button', { name: '下架' }).click();
    await expect(desk.getByRole('group', { name: '爆炒土豆丝 状态' }).getByRole('button', { name: '下架' })).toHaveAttribute('aria-pressed', 'true');
    await desk.getByLabel('只看售罄 / 下架', { exact: false }).check();
    await shot(desk, '03-老板-已下架列表');
    await desk.getByLabel('只看售罄 / 下架', { exact: false }).uncheck();
  });

  await test.step('顾客端立即生效：新价格、新图片；下架的菜看不到', async () => {
    await phone.goto(`${CUSTOMER}/?table=9`);
    const frog = phone.locator('.dish', { hasText: '招牌跳跳蛙' });
    await expect(frog).toContainText('RM 52');
    await expect(frog.locator('img')).toHaveCount(0); // 招牌菜没被传测试图
    await phone.getByRole('tab', { name: '主食' }).click();
    await expect(phone.locator('.dish', { hasText: '下饭咸鸭蛋' }).locator('img')).toBeVisible();
    await phone.getByRole('tab', { name: '下饭小炒' }).click();
    await expect(phone.getByText('爆炒土豆丝')).toHaveCount(0);
    await phone.getByRole('tab', { name: '全部' }).click();
    await shot(phone, '04-顾客-新价格与新图片');
  });

  await test.step('老板删除图片（34号 A）：fixture 菜回到占位，顾客端立即生效；后面的截图里不再有测试图', async () => {
    await desk.getByLabel('搜索菜品').fill('咸鸭蛋');
    await desk.getByRole('button', { name: '删除 下饭咸鸭蛋 图片' }).click(); // 二次确认由上面的 dialog 处理自动接受
    await expect(row('下饭咸鸭蛋').getByRole('button', { name: '上传图片' })).toBeVisible();
    await expect(desk.getByRole('button', { name: '删除 下饭咸鸭蛋 图片' })).toHaveCount(0);
    await shot(desk, '04b-老板-删除图片后');
    await desk.getByLabel('搜索菜品').fill('');
    await phone.goto(`${CUSTOMER}/?table=9`);
    await phone.getByRole('tab', { name: '主食' }).click();
    await expect(phone.locator('.dish', { hasText: '下饭咸鸭蛋' }).locator('img')).toHaveCount(0);
  });

  await test.step('老板暂停接单：顾客端看到提示，结算按钮变「暂不接单」', async () => {
    await nav('实时订单').click();
    await desk.getByRole('button', { name: '暂停接单' }).click();
    await expect(desk.getByRole('status').filter({ hasText: '已暂停接单' })).toBeVisible();
    await shot(desk, '05-老板-已暂停接单');
    await phone.goto(`${CUSTOMER}/?table=9`);
    await expect(phone.getByText('本店暂停接单')).toBeVisible();
    await shot(phone, '06-顾客-暂停接单提示');
    await phone.getByRole('button', { name: '加购 农家一碗香' }).click();
    await phone.locator('.cartbar-go').click();
    await expect(phone.getByRole('button', { name: '暂不接单' })).toBeDisabled();
    await desk.getByRole('button', { name: '恢复接单' }).click();
    await expect(desk.getByRole('status').filter({ hasText: '营业中' })).toBeVisible();
  });

  await test.step('营业时间外：顾客端显示「已打烊」和营业时间', async () => {
    const open = klPlus(2);
    const close = klPlus(3);
    await desk.getByLabel('开门时间').fill(open);
    await desk.getByLabel('打烊时间').fill(close);
    await desk.locator('.panel.store').getByRole('button', { name: '保存' }).click();
    await expect(desk.getByRole('status').filter({ hasText: '已打烊' })).toBeVisible();
    await phone.goto(`${CUSTOMER}/?table=9`);
    await expect(phone.getByText(`营业时间 ${open}–${close}`).first()).toBeVisible();
    await expect(phone.getByRole('heading', { name: '招牌跳跳蛙' })).toBeVisible(); // 打烊时菜单照常能看
    await shot(phone, '07-顾客-已打烊');
    await desk.getByLabel('开门时间').fill('');
    await desk.getByLabel('打烊时间').fill('');
    await desk.locator('.panel.store').getByRole('button', { name: '保存' }).click();
    await expect(desk.getByRole('status').filter({ hasText: '营业中' })).toBeVisible();
  });

  await test.step('页内填写取消原因（不再用浏览器弹窗）', async () => {
    await phone.goto(`${CUSTOMER}/#order`);
    await phone.getByRole('button', { name: '查看购物车' }).click();
    await phone.getByRole('button', { name: '清空' }).click();
    await expect(phone.locator('.cartbar')).toHaveCount(0);
    const no = await placeCashOrder(phone, '农家一碗香');
    const t = desk.locator('.ticket', { has: desk.locator('.ticket-no', { hasText: no }) });
    await t.getByRole('button', { name: '取消' }).click();
    await t.getByRole('button', { name: '菜品售罄' }).click();
    await shot(desk, '08-老板-页内取消原因');
    await t.getByRole('button', { name: '确认取消' }).click();
    await expect(desk.locator('.cancelled')).toContainText('原因：菜品售罄');
  });

  await test.step('对账异常：任何页面顶部都有横幅，「开始接单」旁亮红点', async () => {
    // 模拟「有人绕过流水直接改了余额」：直接改测试数据库
    const db = new Database(resolve(ROOT, 'data', 'e2e.db'));
    db.prepare("UPDATE members SET balance_sen = balance_sen + 1000 WHERE member_no = '100001'").run();
    db.close();
    await nav('会员管理').click();
    await desk.getByRole('button', { name: '立即对账' }).click();
    await expect(desk.locator('.global-alert')).toContainText('对账发现 1 处不一致');
    await shot(desk, '09-老板-对账异常横幅');
    await nav('实时订单').click();
    await expect(desk.locator('.global-alert')).toBeVisible();
    await expect(desk.getByLabel('对账异常，去会员管理')).toBeVisible();
    await expect(desk.getByText('实时连接正常')).toBeVisible();
    await shot(desk, '10-老板-接单旁红点');
    // 测试完把数据改回来，再对一次账，横幅消失
    const db2 = new Database(resolve(ROOT, 'data', 'e2e.db'));
    db2.prepare("UPDATE members SET balance_sen = balance_sen - 1000 WHERE member_no = '100001'").run();
    db2.close();
    await nav('会员管理').click();
    await desk.getByRole('button', { name: '立即对账' }).click();
    await expect(desk.locator('.global-alert')).toHaveCount(0);
    await nav('实时订单').click();
  });

  await test.step('老板端断网：显示「连接中断」；恢复后自动补上断网期间的新单', async () => {
    await expect(desk.getByText('实时连接正常')).toBeVisible();
    await deskCtx.setOffline(true);
    await expect(desk.getByText('连接中断，正在自动重连…')).toBeVisible({ timeout: 15000 });
    await shot(desk, '11-老板-断网提示');
    const no = await placeCashOrder(phone, '凉拌黄瓜');
    await deskCtx.setOffline(false);
    await expect(desk.getByText('实时连接正常')).toBeVisible({ timeout: 20000 });
    await expect(desk.locator('.ticket-no', { hasText: no })).toBeVisible();
    await shot(desk, '12-老板-重连后补上新单');
  });

  await test.step('顾客断网：操作给出可读提示；恢复后购物车与服务器自动拉齐', async () => {
    await phone.goto(`${CUSTOMER}/?table=9`);
    await phone.getByRole('button', { name: '加购 凉拌木耳' }).click();
    await expect(phone.locator('.cartbar-badge')).toHaveText('1');
    await phone.context().setOffline(true);
    await phone.getByRole('button', { name: '增加 凉拌木耳' }).click();
    await expect(phone.getByRole('status')).toHaveText('网络连接失败，请检查网络后重试');
    await shot(phone, '13-顾客-断网提示');
    await phone.context().setOffline(false);
    await phone.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(phone.locator('.cartbar-badge')).toHaveText('1'); // 断网那下没生效，以服务器为准
  });

  await test.step('「我的」第一屏：会员状态与退出会员登录', async () => {
    await phone.goto(`${CUSTOMER}/#member`);
    const f = phone.getByRole('form', { name: '会员登录' });
    await f.getByLabel('会员号').fill('100001');
    await f.getByLabel('4 位密码').fill('2468');
    await f.getByRole('button', { name: '登录会员' }).click();
    await expect(phone.locator('.balance')).toBeVisible();
    await phone.goto(`${CUSTOMER}/#me`);
    await expect(phone.getByRole('heading', { name: '会员 100001' })).toBeVisible();
    await expect(phone.getByRole('button', { name: '再来一单' }).first()).toBeVisible(); // 这台手机下过单，不能显示「还没有订单」
    await expect(phone.getByText('还没有订单')).toHaveCount(0);
    await shot(phone, '14-顾客-我的首屏会员');
    await phone.getByRole('region', { name: '会员状态' }).getByRole('button', { name: '退出会员登录' }).click();
    await expect(phone.getByRole('heading', { name: '未登录会员' })).toBeVisible();
  });
});
