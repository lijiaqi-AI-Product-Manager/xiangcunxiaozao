/**
 * 构建期把「当前店」的配置注入前端：
 * - 虚拟模块 virtual:brand → 品牌信息 + 该端的设计 token
 * - index.html 里提前写入 CSS 变量和页面标题（不闪屏、代码里不出现店名）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { loadEnv, type Plugin, type UserConfig } from 'vite';
import { Brand, Tokens } from '../../contract/src/brand.ts';

export type Side = 'customer' | 'admin';

export function tokensToCss(set: Record<string, string>, selector = ':root'): string {
  return `${selector}{${Object.entries(set).map(([k, v]) => `--${k}:${v}`).join(';')}}`;
}

/**
 * 26号两态并行：顾客端默认「成品态」；地址加 ?skin=skeleton 切到「骨架态」（中性灰白、无品牌元素，只做功能验证）。
 * 在页面画出来之前就定好外观，避免先闪一下另一种样子。
 */
const SKIN_BOOT = `<script>(function(){try{var q=new URLSearchParams(location.search).get('skin');if(q==='skeleton'||q==='finished'){sessionStorage.setItem('skin',q)}var s=sessionStorage.getItem('skin')}catch(e){}document.documentElement.dataset.skin=s==='skeleton'?'skeleton':'finished'})()</script>`;

/**
 * 38号 4.2 动效分档（小样六轮验证过的同一套）：normal 全开 / minimal 去掉视差 / lite 再去掉毛玻璃、氛围色、渐显 /
 * static =「减弱动态效果」全部静止。?tier= 可强制（测试、截图用）。画面出来之前就定好，不闪
 */
const TIER_BOOT = `<script>(function(){var r=document.documentElement,q=null;try{q=new URLSearchParams(location.search).get('tier')}catch(e){}
function d(){if(matchMedia('(prefers-reduced-motion: reduce)').matches)return'static';var n=navigator,m=n.deviceMemory,c=n.hardwareConcurrency,s=n.connection&&n.connection.saveData;
if(s||(m&&m<=2)||(c&&c<=4))return'lite';if((m&&m<=4)||(c&&c<=6))return'minimal';return'normal'}
r.dataset.tier=/^(normal|minimal|lite|static)$/.test(q||'')?q:d();r.dataset.forced=q?'1':''})()</script>`;

/** 53号（高斯）：标题标签层的数字、英文不用书法——同一个字体名下 ASCII 和几个符号走衬线体，汉字走书法（tokens.json 的书法字体栈第一个就是它） */
const LATIN_UI_FACE = 'UI Latin';
const LATIN_UI_RANGE = 'U+0020-007E,U+00B7,U+2019,U+2212';

/** 品牌氛围图（墨晕、纸纹、宣纸纤维、墨痕）：放在品牌目录 art/ 下，按文件名生成 --art-文件名 变量，样式里只认变量 */
const ART_ROUTE = '/brand-art/';
function artFiles(repoRoot: string) {
  const { dir } = loadBrand(repoRoot);
  const art = resolve(dir, 'art');
  if (!existsSync(art)) return [];
  return readdirSync(art).filter((f) => f.endsWith('.svg')).map((f) => ({ path: resolve(art, f), url: ART_ROUTE + f, token: `art-${f.replace(/\.svg$/, '')}` }));
}

function loadBrand(repoRoot: string) {
  const env = loadEnv('', repoRoot, '');
  const id = env.BRAND;
  if (!id) throw new Error('缺少 BRAND 环境变量（见根目录 .env）');
  const dir = resolve(repoRoot, 'brands', id);
  const brand = Brand.parse(JSON.parse(readFileSync(resolve(dir, 'brand.json'), 'utf8')));
  const tokens = Tokens.parse(JSON.parse(readFileSync(resolve(dir, 'tokens.json'), 'utf8')));
  return { brand, tokens, dir };
}

/** P3 第④项 + 41号：书法字体、英文装饰字体都从自己的服务器加载（裁剪后的小字体），不再依赖谷歌字体 */
const FONT_ROUTE = '/brand-font/';
function fontFiles(repoRoot: string) {
  const { brand, dir } = loadBrand(repoRoot);
  // 书法字体首屏就要用（占位图、水印），预加载；英文字体只在用到时才下载
  // 53号：详情正文楷体也自托管，只在详情页用到，不预加载
  return [{ font: brand.brushFont, preload: true }, { font: brand.latinFont, preload: false }, { font: brand.bodyFont, preload: false }]
    .flatMap(({ font, preload }) => (font ? [{ family: font.family, path: resolve(dir, font.file), url: FONT_ROUTE + basename(font.file), preload, weight: font.weightRange?.join(' '), latin: font === brand.latinFont }] : []));
}
function fontHead(repoRoot: string): string {
  const files = fontFiles(repoRoot);
  if (!files.length) return '';
  const face = (family: string, f: (typeof files)[number], range = '') =>
    `@font-face{font-family:"${family}";src:url("${f.url}") format("woff2");${f.weight ? `font-weight:${f.weight};` : ''}${range ? `unicode-range:${range};` : ''}font-display:swap}`;
  // font-display: swap —— 字体到之前先用系统字体显示，绝不出现空白
  return files.filter((f) => f.preload).map((f) => `<link rel="preload" href="${f.url}" as="font" type="font/woff2" crossorigin>`).join('')
    + `<style>${files.map((f) => face(f.family, f) + (f.latin ? face(LATIN_UI_FACE, f, LATIN_UI_RANGE) : '')).join('')}</style>`;
}

export function brandPlugin(repoRoot: string, side: Side, titleSuffix: string): Plugin {
  const VIRTUAL = 'virtual:brand';
  const RESOLVED = '\0' + VIRTUAL;
  return {
    name: 'brand-config',
    resolveId: (id) => (id === VIRTUAL ? RESOLVED : null),
    // 开发时直接从品牌目录读字体；打包时把它放进产物，部署后同样从自己的域名加载
    configureServer(server) {
      if (side !== 'customer') return;
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0];
        const f = fontFiles(repoRoot).find((x) => x.url === url);
        const a = f ? null : artFiles(repoRoot).find((x) => x.url === url);
        if (!f && !a) return next();
        res.setHeader('content-type', f ? 'font/woff2' : 'image/svg+xml');
        res.setHeader('cache-control', 'no-cache');
        res.end(readFileSync((f ?? a)!.path));
      });
    },
    generateBundle() {
      if (side !== 'customer') return;
      for (const f of [...fontFiles(repoRoot), ...artFiles(repoRoot)]) this.emitFile({ type: 'asset', fileName: f.url.slice(1), source: readFileSync(f.path) });
    },
    load(id) {
      if (id !== RESOLVED) return null;
      const { brand, tokens } = loadBrand(repoRoot);
      return `export default ${JSON.stringify({ brand, tokens: side === 'customer' ? tokens.customer : tokens.admin })};`;
    },
    transformIndexHtml(html) {
      const { brand, tokens } = loadBrand(repoRoot);
      const art = Object.fromEntries(artFiles(repoRoot).map((a) => [a.token, `url("${a.url}")`]));
      const css = side === 'customer'
        ? tokensToCss({ ...tokens.customer, ...art }) + tokensToCss(tokens.customerSkeleton, ':root[data-skin=skeleton]')
        : tokensToCss(tokens.admin);
      const head = side === 'customer'
        ? SKIN_BOOT + TIER_BOOT + fontHead(repoRoot) + brand.fontStylesheets.map((href) => `<link rel="stylesheet" href="${href}">`).join('')
        : '';
      return html
        .replace('<!--brand-title-->', `<title>${brand.shortName} · ${titleSuffix}</title>${head}`)
        .replace('<!--brand-tokens-->', `<style id="brand-tokens">${css}</style>`)
        .replace('<html>', `<html lang="${brand.locale}">`);
    },
  };
}

/** 两个前端共用的 Vite 设置：路径别名（不依赖 npm 软链接）+ 把 /api 转给后端 */
export function sharedConfig(repoRoot: string): UserConfig {
  return {
    envDir: repoRoot,
    resolve: {
      // 不把路径换成「真实路径」：某些 Windows 打包环境下真实路径不可读
      preserveSymlinks: true,
      alias: {
        '@pkg/contract': resolve(repoRoot, 'packages/contract/src/index.ts'),
        '@pkg/ui-kit': resolve(repoRoot, 'packages/ui-kit/src/index.ts'),
      },
    },
    server: {
      host: '0.0.0.0',
      fs: { allow: [repoRoot] },
      proxy: Object.fromEntries(['/api', '/media'].map((p) => [p, `http://127.0.0.1:${loadEnv('', repoRoot, '').API_PORT || '8787'}`])),
    },
  };
}
