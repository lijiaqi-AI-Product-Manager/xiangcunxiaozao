// 生成「全测试清单」：真实跑一遍单元/接口测试，读取结果，再列出端到端流程的每一个步骤。
// 用法：npm run test:inventory → 输出 docs/P2-测试清单.md
import { execSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const out = resolve('test-results', 'vitest.json');
execSync(`npx vitest run --reporter=json --outputFile=${out}`, { stdio: 'ignore' });
const report = JSON.parse(readFileSync(out, 'utf8')) as {
  numTotalTests: number; numPassedTests: number;
  testResults: { name: string; assertionResults: { ancestorTitles: string[]; title: string; status: string }[] }[];
};
rmSync(out, { force: true });

const lines: string[] = ['# P2 全测试清单', '', '> 由 `npm run test:inventory` 自动生成，请勿手改。', ''];
lines.push(`## 一、单元 / 接口测试：${report.numPassedTests} / ${report.numTotalTests} 通过`, '');
for (const file of report.testResults.sort((a, b) => a.name.localeCompare(b.name))) {
  const rel = file.name.replace(/\\/g, '/').replace(/^.*?\/(apps|packages|scripts)\//, '$1/');
  lines.push(`### ${rel}（${file.assertionResults.length} 项）`, '');
  for (const t of file.assertionResults) {
    lines.push(`- ${t.status === 'passed' ? '✅' : '❌'} ${[...t.ancestorTitles, t.title].join(' › ')}`);
  }
  lines.push('');
}

lines.push('## 二、端到端流程（真浏览器，独立测试数据库）', '');
for (const spec of ['p2a-ordering', 'p2b-members', 'p2c-dishes-store', 'p2d-batch4']) {
  const src = readFileSync(resolve('e2e', `${spec}.spec.ts`), 'utf8');
  for (const m of src.matchAll(/^test\('([^']+)'/gm)) {
    lines.push(`### ${m[1]}（e2e/${spec}.spec.ts）`, '');
    const steps = [...src.matchAll(/test\.step\('([^']+)'/g)].map((s) => s[1]);
    for (const s of steps) lines.push(`- ${s}`);
    lines.push('');
    if (spec === 'p2d-batch4') break; // 该文件第二个 test（两态截图）没有分步骤，单独列
  }
}
lines.push('### 两态并行截图（e2e/p2d-batch4.spec.ts）', '', '- 顾客端 6 个页面 × 成品态 / 骨架态各一张；并断言骨架态没有印章等品牌元素', '');
writeFileSync(resolve('docs', 'P2-测试清单.md'), lines.join('\n'));
console.log(`已生成 docs/P2-测试清单.md：${report.numPassedTests}/${report.numTotalTests} 单元/接口测试`);
