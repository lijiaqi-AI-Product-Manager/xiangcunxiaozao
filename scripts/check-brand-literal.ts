// 产品化护栏（21号 §3.3）：通用代码里不许出现任何店名或店的配置ID，也不许散写色值（23号 §七）。
// 店的信息只能放在 brands/ 下；这里扫描 apps/ packages/ scripts/ 三个代码目录。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const CODE_DIRS = ['apps', 'packages', 'scripts', 'e2e'];
const SKIP = new Set(['node_modules', 'dist', 'dist-demo']); // 构建产物（dist-demo = 58号演示版，菜单快照里本来就有店名）
const EXT = /\.(ts|tsx|js|jsx|css|html|json)$/;
const SELF = 'scripts/check-brand-literal.ts';
const BRAND_PATTERN = new RegExp(['湘', '村'].join('') + '|' + ['xiang', 'cun'].join(''), 'i');
const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;
const RGB_COLOR = /rgba?\(/;
// 27号 #1：所有时间显示统一走门店时区（contract 的 formatDate / formatDateTime / formatClock），
// 不许用跟着「运行这台机器的时区」走的写法，也不许截 ISO 字符串当日期
const RAW_TIME = /toLocale(String|DateString|TimeString)\(|\.get(Hours|Minutes|Date|Month|FullYear|Day)\(|toISOString\(\)\.slice|\b\w*(at|At|date|Date|time|Time)\.slice\((0|5), ?10\)/;
const TIME_HOME = 'packages/contract/src/display.ts';
/**
 * 豁免：纯粹的「日期加减」不是「显示时间」，走 UTC 反而是对的。
 *
 * 例：2026-10-31 往后挪一天 应该得到 2026-11-01，不涉及时刻。
 * 用 UTC 中午做基准可以避开夏令时边界（某些时区某天只有 23 小时，按本地时间加减会漏一天）。
 * 所以这类行只要带了 check-allow-utc-date 标记就放过——但必须写明为什么，别随手加。
 */
const DATE_MATH_OK = /check-allow-utc-date/;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (EXT.test(name)) yield p;
  }
}

const hits: string[] = [];
for (const dir of CODE_DIRS.filter((d) => existsSync(d))) {
  for (const file of walk(dir)) {
    const rel = relative('.', file).replaceAll('\\', '/');
    if (rel === SELF) continue;
    readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      // 测试文件允许引用 brands/<店>/ 下的真实数据当测试数据（那些文件本来就是给这家店用的）；
      // 业务代码里出现店名/店ID 一律不许——那是换店就得改代码的意思。
      const isTest = /\.test\.(ts|tsx)$|\/(e2e|scripts)\/[^/]*\.spec\./.test(rel);
      if (BRAND_PATTERN.test(line) && !isTest) hits.push(`${rel}:${i + 1} 出现店名/店ID：${line.trim()}`);
      if (/\.(css|tsx|ts)$/.test(rel) && (HEX_COLOR.test(line) || RGB_COLOR.test(line)) && !/check-allow-color/.test(line)) {
        hits.push(`${rel}:${i + 1} 散写色值（应走 tokens.json）：${line.trim()}`);
      }
      if (/\.(tsx?)$/.test(rel) && rel !== TIME_HOME && RAW_TIME.test(line) && !DATE_MATH_OK.test(line)) {
        hits.push(`${rel}:${i + 1} 时间没走门店时区（应用 formatDate/formatDateTime/formatClock）：${line.trim()}`);
      }
    });
  }
}
if (hits.length) {
  console.error(`产品化检查失败（${hits.length} 处）：\n- ${hits.join('\n- ')}`);
  process.exit(1);
}
console.log('产品化检查通过：代码目录中没有店名、没有散写色值、时间显示全部走门店时区');
