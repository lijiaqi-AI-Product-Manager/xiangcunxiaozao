// 金额显示检查：菜单价可以写 48 / 19.9，但账单类页面必须固定两位小数（48.00 / 19.90）。
//
// 为什么需要这条自动检查：已经出过一次——数据看板写 RM 1739.6、日结单写 RM 1739.60，
// 同一个数字两个页面不一样。这类问题不会报错、不会崩，只是老板对账时觉得「哪里怪」，
// 而人眼在 100 多个数字里几乎不可能一致地发现它。所以交给脚本看。
//
// 规则分两半：
//   ① 「账单语境」的文件里不许出现 formatPrice / 直接用 toFixed 之类自己拼小数
//   ② 菜单语境（dish / menu / price-edit）允许 formatPrice
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const CODE_DIRS = ['apps', 'packages'];
const SKIP = new Set(['node_modules', 'dist', 'dist-demo']);
const EXT = /\.(ts|tsx)$/;

/** 文件名或路径里带这些词的，算「账单语境」——这里面出现的金额都是钱，必须两位小数 */
const BILL_CONTEXT = /(Dashboard|Report|Members|Refunds|History|My|Receipt|Ledger|Checkout)/;
/** 这些词说明这一行是菜单价，允许 formatPrice */
const MENU_CONTEXT = /(dish|Dish|menu|Menu|price-edit|菜单|菜品|原价|单价)/;
/** 打印机模板自己排版（固定 32/48 列宽），金额位数由 ESC/POS 对齐逻辑决定，另有一套测试守着 */
const PRINT_TEMPLATE = /(print\/|templates\.ts|escpos\.ts)/;
/** 这一行确实在用 formatPrice */
const USES_PRICE = /\bformatPrice\s*\(/;
/** 这一行在调用顾客端的 money()（内部走 formatPrice，会省掉 .0） */
const USES_CUSTOMER_MONEY = /(?<![A-Za-z])(?<!bill)money\s*\(/;
/** 账单用词：出现这些词的那一行，金额一定是「要付 / 已付 / 要退」的钱，不能省小数位。
 *  顾客端没有「账单页」这个概念，账单元素散在点单、结算、我的各处，只能按用词认。 */
const BILL_WORDS = /(合计|小计|应付|实付|应收|共退|已退|退回|退款|余额|总计|这一桌|这单|本单|储值\s*\{|confirm|total|subtotal|balance|refund)/i;
/** 这些词出现在同一行时，说明说的是菜单价而不是账单 */
const PRICE_WORDS = /(priceSen|单价|每份|原价|dish\.unit)/;
/** 自己拼「元」的小数位：只认「除以 100」这种明确的「分转元」，不误伤 MB / px / 缩放比例 */
const HAND_ROLLED = /\b(sen|amount|balance|total|price|cash|change)\w*\s*\/\s*100\s*\)?\s*\.toFixed\s*\(\s*[12]\s*\)|\b(sen|amount|balance|total|price|cash|change)\w*\s*\/\s*100\)\.toFixed/;
/** 把 .00 去掉的写法：账单里出现就等于「时而有两位、时而没有」 */
const STRIP_ZEROS = /replace\s*\(\s*\/\\\.0{1,2}\$\/\s*,\s*['"]{2}\s*\)/;

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
    if (rel.includes('.test.')) continue; // 测试里本来就要分别验证两种写法
    if (PRINT_TEMPLATE.test(rel)) continue; // 小票模板另行保证两位小数（escpos 测试）
    const billFile = BILL_CONTEXT.test(rel);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    // 有的文件自己定义了一个 money()，但里面用的是 formatMoney（已经是两位小数）。
    // 这种只是名字不同，不算问题——不然就是让人为了讨好检查脚本去改名字。
    const localMoneyIsBill = lines.some((l) => /const\s+money\s*=.*formatMoney/.test(l));
    lines.forEach((line, i) => {
      // 注释里提到函数名不算。要用「索引是否在 // 之前」判断，
      // 不能直接 replace(/\/\/.*$/)——`https://` 这种字符串里也有 //，会把后半行整段吃掉。
      const slash = line.indexOf('//');
      const code = slash >= 0 ? line.slice(0, slash) : line;
      // 账单文件连 import 都不许带 formatPrice——带了迟早会用上
      if (billFile && /^\s*import\b/.test(code) && /\bformatPrice\b/.test(code)) {
        hits.push(`${rel}:${i + 1} 账单页面引入了 formatPrice（应改用 formatMoney → 固定两位小数）：${line.trim()}`);
        return;
      }
      if (code.trim().startsWith('import ')) return; // 其他 import 行不做判断
      if (billFile && USES_PRICE.test(code) && !MENU_CONTEXT.test(code)) {
        hits.push(`${rel}:${i + 1} 账单页面用了 formatPrice（应改用 formatMoney → 固定两位小数）：${line.trim()}`);
      }
      // 顾客端：这一行说的是「合计 / 退款 / 余额」，就不能用 money()（会显示成 RM 87.8）
      if (rel.startsWith('apps/customer/') && !localMoneyIsBill && USES_CUSTOMER_MONEY.test(code) && BILL_WORDS.test(code) && !PRICE_WORDS.test(code)) {
        hits.push(`${rel}:${i + 1} 账单金额用了 money()（应改用 billMoney → 固定两位小数）：${line.trim()}`);
      }
      if (!rel.endsWith('display.ts') && HAND_ROLLED.test(code) && !MENU_CONTEXT.test(code)) {
        hits.push(`${rel}:${i + 1} 自己拼金额小数位（应走 formatMoney）：${line.trim()}`);
      }
      if (STRIP_ZEROS.test(code) && /(RM|currency|money|rm\()/i.test(code)) {
        hits.push(`${rel}:${i + 1} 把金额结尾的 .00 去掉了（账单必须两位小数）：${line.trim()}`);
      }
    });
  }
}

if (hits.length) {
  console.error(`金额显示检查失败（${hits.length} 处）：\n- ${hits.join('\n- ')}`);
  process.exit(1);
}
console.log('金额显示检查通过：账单页面统一两位小数，没有自己拼小数位');
