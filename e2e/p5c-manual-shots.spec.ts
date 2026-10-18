// 58号 任务6 老板使用手册配图：老板端「今日招牌」怎么配（菜品管理页顶部），配好后顾客端点单页顶部的样子。
// 只截图、不改业务数据：测试结束把今日招牌清空。截图存进 docs/screenshots/p5-closeout/
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = resolve(ROOT, 'docs', 'screenshots', 'p5-closeout');
mkdirSync(SHOTS, { recursive: true });
const ADMIN = 'http://localhost:5184';
const CUSTOMER = 'http://localhost:5183';

test('手册配图：今日招牌配置 → 顾客端顶部大画', async ({ browser }) => {
  const desk = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await desk.goto(ADMIN);
  await desk.getByLabel('老板密码').fill('e2e-test-password');
  await desk.getByRole('button', { name: '登录' }).click();
  await desk.locator('.side').getByRole('link', { name: '菜品管理' }).click();
  const names = ['湘味油泼牛肉', '招牌跳跳蛙'];
  for (const [i, name] of names.entries()) {
    await desk.getByRole('button', { name: `把 ${name} 设为今日招牌` }).click();
    await expect(desk.locator('.today-list li')).toHaveCount(i + 1); // 等上一道存好再点下一道
  }
  await desk.screenshot({ path: resolve(SHOTS, '老板-今日招牌配置.png') });

  const phone = await (await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
  await phone.goto(`${CUSTOMER}/?table=8&tier=static`);
  await expect(phone.locator('.deck')).toBeVisible();
  await phone.screenshot({ path: resolve(SHOTS, '顾客-今日招牌大画.png') });

  const token = await desk.evaluate(() => localStorage.getItem('admin-token') ?? '');
  await desk.request.post(`${ADMIN}/api/admin/today`, { headers: { authorization: `Bearer ${token}` }, data: { dishes: [] } });
});
