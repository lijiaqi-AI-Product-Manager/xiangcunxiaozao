// 58号 任务4 门店信息：老板端填地址 / 电话 / 营业时间 / WhatsApp → 顾客端「我的」页门店小卡和功能格副字跟着变；
// 没填的那一行不显示，四项全空整张卡不显示（不再出现「待提供」）。号码、地址都是测试假数据（全 0）。
// 截图存进 docs/screenshots/p5-closeout/
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = resolve(ROOT, 'docs', 'screenshots', 'p5-closeout');
mkdirSync(SHOTS, { recursive: true });
const ADMIN = 'http://localhost:5184';
const CUSTOMER = 'http://localhost:5183';

async function fill(desk: Page, v: { 地址: string; 电话: string; 营业时间: string; WhatsApp: string }) {
  const f = desk.getByRole('form', { name: '门店信息' });
  for (const [k, val] of Object.entries(v)) await f.getByLabel(k, { exact: true }).fill(val);
  await f.getByRole('button', { name: '保存' }).click();
}

test('门店信息：老板端编辑，顾客端联动；空值不显示', async ({ browser }) => {
  const desk = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  // 回归：开发模式下页面挂载两次、读两次门店信息；第二次故意晚到 1.5 秒——旧代码会在老板填到一半时把表单冲空
  let reads = 0;
  let lateArrived!: () => void;
  const late = new Promise<void>((r) => { lateArrived = r; });
  await desk.route('**/api/admin/store-info', async (route) => {
    const second = route.request().method() === 'GET' && ++reads === 2;
    if (second) await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
    if (second) setTimeout(lateArrived, 300); // 等页面处理完这次晚到的结果
  });
  await desk.goto(ADMIN);
  await desk.getByLabel('老板密码').fill('e2e-test-password');
  await desk.getByRole('button', { name: '登录' }).click();
  await desk.locator('.side').getByRole('link', { name: '门店信息' }).click();

  // 看不懂的营业时间当场拦住，不保存
  await fill(desk, { 地址: '', 电话: '', 营业时间: '中午到晚上', WhatsApp: '' });
  await expect(desk.getByRole('alert')).toContainText('看不懂');
  await late;
  await expect(desk.getByRole('form', { name: '门店信息' }).getByLabel('营业时间', { exact: true })).toHaveValue('中午到晚上'); // 没被晚到的读取冲掉

  await fill(desk, { 地址: '测试地址 0 号', 电话: '03-0000 0000', 营业时间: '11:00-15:00, 17:00-22:00', WhatsApp: '+60 10-000 0000' });
  await expect(desk.getByRole('status')).toContainText('已保存');
  await expect(desk.getByRole('region', { name: '顾客端预览' })).toContainText('11:00–15:00，17:00–22:00');
  await desk.screenshot({ path: resolve(SHOTS, '老板-门店信息.png'), fullPage: true });

  const phone = await (await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
  await phone.goto(`${CUSTOMER}/?table=8&tier=static#me`);
  const card = phone.locator('#me-store');
  await expect(card).toContainText('11:00–15:00，17:00–22:00');
  await expect(card).toContainText('03-0000 0000');
  await expect(card).toContainText('+60 10-000 0000');
  await expect(card).toContainText('测试地址 0 号');
  await expect(card.getByRole('link', { name: /电话/ })).toHaveAttribute('href', 'tel:0300000000');
  await expect(card.getByRole('link', { name: /WhatsApp/ })).toHaveAttribute('href', 'https://wa.me/60100000000');
  await expect(phone.locator('.me-tile', { hasText: '门店信息' })).toContainText('11:00–15:00');
  await expect(phone.getByText('待提供')).toHaveCount(0);
  await card.scrollIntoViewIfNeeded();
  await phone.screenshot({ path: resolve(SHOTS, '顾客-我的-门店信息四项.png') });

  // 只留地址：其余三行不显示
  await fill(desk, { 地址: '测试地址 0 号', 电话: '', 营业时间: '', WhatsApp: '' });
  await expect(desk.getByRole('status')).toContainText('已保存');
  await phone.reload();
  await expect(card).toContainText('测试地址 0 号');
  await expect(card).not.toContainText('电话');
  await expect(card).not.toContainText('WhatsApp');
  await expect(phone.getByText('待提供')).toHaveCount(0);

  // 四项全空（且没设接单时间段）：整张卡和功能格都不显示
  const token = await desk.evaluate(() => localStorage.getItem('admin-token') ?? '');
  const auth = { authorization: `Bearer ${token}` };
  const status = await (await desk.request.get(`${ADMIN}/api/store/status`)).json() as { openAt: string | null; closeAt: string | null };
  await desk.request.post(`${ADMIN}/api/admin/store`, { headers: auth, data: { openAt: '', closeAt: '' } });
  await fill(desk, { 地址: '', 电话: '', 营业时间: '', WhatsApp: '' });
  await expect(desk.getByRole('region', { name: '顾客端预览' })).toContainText('不显示门店小卡');
  await phone.reload();
  await expect(phone.getByRole('heading', { name: '未登录会员' })).toBeVisible();
  await expect(phone.locator('#me-store')).toHaveCount(0);
  await expect(phone.locator('.me-tile', { hasText: '门店信息' })).toHaveCount(0);
  await expect(phone.getByText('待提供')).toHaveCount(0);
  await desk.request.post(`${ADMIN}/api/admin/store`, { headers: auth, data: { openAt: status.openAt ?? '', closeAt: status.closeAt ?? '' } });
});
