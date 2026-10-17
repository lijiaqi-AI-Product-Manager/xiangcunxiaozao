#!/usr/bin/env node
/* record.js —— 四段录屏（webm，375×812）
   ① 横幅卡收展循环×2  ② 水滴飞行×3  ③ 分区色温过渡  ④ 静置10s呼吸 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const DIST = path.resolve(__dirname, '../dist');
const REC = path.resolve(__dirname, '../recordings');
fs.rmSync(REC, { recursive: true, force: true });
fs.mkdirSync(REC, { recursive: true });

(async () => {
  const browser = await chromium.launch();

  async function newRec() {
    const ctx = await browser.newContext({
      viewport: { width: 375, height: 812 },
      recordVideo: { dir: REC, size: { width: 375, height: 812 } },
    });
    return ctx;
  }

  /* ① 横幅卡收展循环 ×2（hero 版） */
  {
    const ctx = await newRec();
    const p = await ctx.newPage();
    await p.goto(`file://${DIST}/hero/index.html?perf=normal`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(800);
    for (let i = 0; i < 2; i++) {
      await p.evaluate(() => window.scrollTo({ top: 420, behavior: 'smooth' }));
      await p.waitForTimeout(1100);
      await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await p.waitForTimeout(1100);
    }
    await ctx.close(); // 关闭触发视频落盘
  }

  /* ② 水滴飞行 ×3 + 加购（v2-ink） */
  {
    const ctx = await newRec();
    const p = await ctx.newPage();
    await p.goto(`file://${DIST}/v2-ink/index.html?perf=normal`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(700);
    for (let i = 0; i < 3; i++) {
      // 加购后按钮会被 qty 控件替换（DOM重建），每轮重新查询
      const target = i === 0
        ? '.dish-card .stamp-add'
        : '.qty button.qty-plus, .qty .qty-plus';
      await p.click(target, { noWaitAfter: true });
      await p.waitForTimeout(900);
    }
    await ctx.close();
  }

  /* ③ 分区色温过渡：湘菜区 → 饮品区（2.4s CSS 过渡） */
  {
    const ctx = await newRec();
    const p = await ctx.newPage();
    await p.goto(`file://${DIST}/v2-ink/index.html?perf=normal`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(600);
    const y = await p.evaluate(() => {
      const s = [...document.querySelectorAll('.cat-block')].find(b => b.dataset.zone === 'cool');
      return s.getBoundingClientRect().top + window.scrollY - 160;
    });
    await p.evaluate(v => window.scrollTo({ top: v, behavior: 'smooth' }), y);
    await p.waitForTimeout(3200); // 完整展示 2.4s 过渡
    await ctx.close();
  }

  /* ④ 静置 11s：纸的呼吸（24s 周期的半程可见） */
  {
    const ctx = await newRec();
    const p = await ctx.newPage();
    await p.goto(`file://${DIST}/v2-ink/index.html?perf=normal`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(11000);
    await ctx.close();
  }

  await browser.close();

  /* 重命名：按落盘顺序对应四段 */
  const files = fs.readdirSync(REC).filter(f => f.endsWith('.webm')).sort();
  const names = ['1-banner-cycle.webm', '2-water-drop.webm', '3-zone-shift.webm', '4-idle-breathe.webm'];
  files.forEach((f, i) => { if (names[i]) fs.renameSync(path.join(REC, f), path.join(REC, names[i])); });
  console.log('录屏完成:', fs.readdirSync(REC).join(', '));
})();
