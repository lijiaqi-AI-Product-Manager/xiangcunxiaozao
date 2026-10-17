/* 快速冒烟：加载页面收集错误 + 截图 */
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  const url = 'file:///home/z/my-project/xiangcunxiaozao/design/dist/v2-ink/index.html';
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  // 点一次加购看交互
  const stamp = await page.$('.stamp-add');
  if (stamp) { await stamp.click(); await page.waitForTimeout(500); }
  const qty = await page.$('.qty-n');
  console.log('加购后数量控件:', qty ? await qty.textContent() : '未出现');
  console.log('结算条has类:', await page.$eval('#checkoutBar', el => el.className));
  await page.screenshot({ path: '/tmp/smoke1.png' });
  // 详情页
  const errors2 = [];
  page.on('pageerror', e => errors2.push(e.message));
  await page.goto(url.replace('index.html', 'detail.html?id=F01'), { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: '/tmp/smoke2.png' });
  console.log('首页错误:', errors.length ? errors : '无');
  console.log('详情页错误:', errors2.length ? errors2 : '无');
  console.log('字体加载:', await page.evaluate(() => document.fonts.check('16px "LXGW WenKai"')));
  console.log('perf档位:', await page.evaluate(() => document.documentElement.dataset.perf));
  await browser.close();
})();
