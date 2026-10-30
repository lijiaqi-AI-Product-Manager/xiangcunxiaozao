/**
 * 打印通道：把字节送到纸上
 *
 * 五种接法，覆盖你店里所有可能：
 * 1) net      —— 网络打印机 / 网口转 USB 打印服务器（推荐，最稳）。打印机 = 局域网 IP:9100
 * 2) usb      —— USB 线直插跑本程序的电脑（Linux 设备节点 /dev/usb/lp0；Windows 只能是蓝牙串口）
 * 3) winspool —— Windows 本机 USB：按打印机队列名直送（不共享、不经驱动重编码），详见 WinSpoolChannel
 * 4) system   —— 交给操作系统打印队列（lp / Windows 共享名）
 * 5) mock     —— 演练模式，只记录不发，没接机器也能跑通全流程自测
 *
 * 上层（调度器）只认 PrinterChannel 接口，底下换线完全不改业务代码。
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseStatus, statusQuery, statusText, type PrinterStatus } from './escpos.ts';

export type TransportKind = 'net' | 'usb' | 'winspool' | 'system' | 'mock';

/**
 * Windows 本机 USB 打印用的 RAW 助手（P/Invoke 调 winspool.drv）。
 * 用绝对路径：服务器可能从仓库根目录启动，也可能从 apps/server 启动。
 * 文件在 scripts/ 下，四层 up 正好是仓库根。
 */
export const RAW_PRINT_SCRIPT = fileURLToPath(new URL('../../../../scripts/win-raw-print.ps1', import.meta.url));

export interface PrinterChannel {
  readonly kind: TransportKind;
  readonly label: string;
  send(payload: Buffer): Promise<void>;
  /** 连通性探测（不打印） */
  health(): Promise<{ ok: boolean; detail: string }>;
}

export interface ChannelOptions {
  host?: string;
  port?: number;
  device?: string;
  queue?: string;
  timeoutMs?: number;
  /** 测试用：覆盖 Windows RAW 助手的路径 */
  script?: string;
}

/** 网络打印机（RAW 9100） */
export class NetChannel implements PrinterChannel {
  readonly kind = 'net' as const;
  readonly label: string;
  private host: string;
  private port: number;
  private timeoutMs: number;

  constructor(o: ChannelOptions) {
    if (!o.host) throw new Error('网络打印机缺少 IP 地址');
    this.host = o.host;
    this.port = o.port ?? 9100;
    this.timeoutMs = o.timeoutMs ?? 5000;
    this.label = `网络 ${this.host}:${this.port}`;
  }

  send(payload: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = new net.Socket();
      let settled = false;
      const done = (err?: Error): void => {
        if (settled) return;
        settled = true;
        sock.destroy();
        if (err) reject(err);
        else resolve();
      };
      sock.setTimeout(this.timeoutMs);
      sock.once('connect', () => {
        sock.write(payload, (e) => {
          if (e) return done(e);
          // 等数据真正发完再关，否则尾巴会被截断
          sock.end(() => done());
        });
      });
      sock.once('timeout', () => done(new Error(`连接 ${this.host}:${this.port} 超时`)));
      sock.once('error', (e) => done(new Error(`连接 ${this.host}:${this.port} 失败：${e.message}`)));
      sock.connect(this.port, this.host);
    });
  }

  /**
   * 真检测，不是只测网线通不通。
   *
   * 旧实现只 connect 一下就报绿灯：缺纸、盖开着、机器离线都照样绿，老板被骗过。
   * 现在发 DLE EOT（打印机状态 + 离线状态）问机器「你现在怎么样」，
   * 回话按位判缺纸/盖开/离线；没回话就老实说「机器没回话」，不冒充做了检测。
   *
   * 两条查询是**一条一条问**的：真实打印机收到几条查询会按顺序回几个字节，
   * 但把两条塞进同一个 write 里，某些机型只认最后一条（实测芯烨就是这样），
   * 于是我们永远收不齐两个字节、只能等超时。一问一答最稳。
   */
  health(): Promise<{ ok: boolean; detail: string }> {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      let settled = false;
      let rx: number | null = null;
      let reading: 1 | 2 = 1;
      const pending: PrinterStatus[] = [];
      const done = (r: { ok: boolean; detail: string }): void => {
        if (settled) return;
        settled = true;
        sock.destroy();
        resolve(r);
      };
      const ask = (n: 1 | 2): void => {
        reading = n;
        rx = null;
        sock.write(statusQuery(n));
      };
      const finish = (): void => {
        const st = pending[0];
        const off = pending[1];
        const merged = st && off
          ? { ...st, paperOut: off.paperOut || st.paperOut, coverOpen: off.coverOpen || st.coverOpen }
          : (st ?? { answered: false, paperOut: false, paperNearEnd: false, coverOpen: false, error: false, offline: false });
        const bad = statusText(merged);
        done(bad ? { ok: false, detail: bad } : { ok: true, detail: `${this.host}:${this.port} 在线，纸和盖子都正常` });
      };
      sock.setTimeout(this.timeoutMs);
      sock.once('connect', () => ask(1));
      sock.on('data', (chunk) => {
        if (rx === null) rx = chunk[0]!;
        pending.push(parseStatus(reading, rx));
        if (reading === 1) ask(2);
        else finish();
      });
      sock.once('timeout', () => {
        // 连上了但机器没回字节：网线通、机器可能没装纸或没开
        done({ ok: false, detail: `${this.host}:${this.port} 连上了但机器没回话：检查电源、纸和盖子` });
      });
      sock.once('error', (e) => done({ ok: false, detail: `${this.host}:${this.port} 不通：${e.message}` }));
      sock.once('close', () => {
        // 机器主动断线，且还没收齐
        done({ ok: false, detail: `${this.host}:${this.port} 连上后被机器断开：多半是机器报错，看一眼面板灯` });
      });
      sock.connect(this.port, this.host);
    });
  }
}

/**
 * USB 直连
 *
 * Linux：设备节点（/dev/usb/lp0），直接 writeFile 就是裸字节，最省事。
 * Windows：**没有**等价节点（\\.\USB001 是假节点，写进去打印机不动）。
 *   两条路：
 *     1）装好原厂驱动、在「打印机属性 → 共享」开共享，用 system 通道（推荐，见 SystemChannel）
 *     2）蓝牙配对后系统会建一个出向 COM 口，DEVICE 填 \\.\COM5 —— 串口是裸字节，
 *        波特率取系统里给该 COM 口设的值（SPP 默认 9600）。只能应急，线一抖就断。
 */
export class UsbChannel implements PrinterChannel {
  readonly kind = 'usb' as const;
  readonly label: string;
  private device: string;
  constructor(o: ChannelOptions) {
    if (!o.device) throw new Error('USB 打印机缺少设备路径（Linux: /dev/usb/lp0；Windows 蓝牙串口: \\\\.\\COM5）');
    this.device = o.device;
    this.label = `USB ${this.device}`;
  }
  async send(payload: Buffer): Promise<void> {
    const fs = await import('node:fs/promises');
    await fs.writeFile(this.device, payload);
  }
  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const fs = await import('node:fs/promises');
      await fs.access(this.device, fs.constants.W_OK);
      return { ok: true, detail: `${this.device} 可写` };
    } catch (e) {
      return { ok: false, detail: `${this.device} 不可写：${(e as Error).message}` };
    }
  }
}

/**
 * 系统打印队列
 *
 * Linux/macOS：`lp -o raw`，raw 模式不碰字节。
 *
 * Windows：**必须走 `copy /b` 到共享名，不能用 `print`**。
 *   `print` 是文本打印：ESC/POS 里的 0x0C（换页）、0x0D（回车）会被当控制字符吃掉，
 *   打出来是半张票、乱码或者干脆空转——这是「Linux 上好好的、搬到 Windows 就不出纸」的头号原因。
 *   `copy /b` 是二进制原样拷贝，spooler 才把整段字节送给打印机。
 *   前提：打印机属性里勾了共享（共享名 = PRINT_*_QUEUE；也可以直接填 \\机器名\共享名）。
 */
export class SystemChannel implements PrinterChannel {
  readonly kind = 'system' as const;
  readonly label: string;
  private queue: string;
  constructor(o: ChannelOptions) {
    if (!o.queue) throw new Error('系统打印队列缺少队列名（Windows 填共享名，Linux 填 lp 队列名）');
    this.queue = o.queue;
    this.label = `系统队列 ${this.queue}`;
  }
  send(payload: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      void (async () => {
        const [{ spawn }, os, path, fs] = await Promise.all([
          import('node:child_process'),
          import('node:os'),
          import('node:path'),
          import('node:fs/promises'),
        ]);
        const tmp = path.join(os.tmpdir(), `xc-print-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`);
        await fs.writeFile(tmp, payload);
        const isWin = process.platform === 'win32';
        // 已经是 UNC 的（\\POS-PC\XP-236B）原样用；只给了共享名的补成 \\localhost\共享名
        const share = this.queue.startsWith('\\\\') ? this.queue : `\\\\localhost\\${this.queue}`;
        const cmd = isWin ? 'cmd' : 'lp';
        const args = isWin ? ['/c', 'copy', '/b', tmp, share] : ['-d', this.queue, '-o', 'raw', tmp];
        const child = spawn(cmd, args, { windowsHide: true });
        let err = '';
        child.stdout.on('data', (d) => (err += String(d)));
        child.stderr.on('data', (d) => (err += String(d)));
        child.once('error', reject);
        child.once('close', (code) => {
          void fs.unlink(tmp).catch(() => undefined);
          if (code === 0) return resolve();
          reject(
            new Error(
              isWin
                ? `系统队列失败（${code}）：${this.queue} 可能没开共享或名字不对。打印机属性 → 共享，勾上并把共享名填进 PRINT_*_QUEUE；也可以改用网口（KIND=net）`
                : `打印命令失败（${code}）：${err.slice(0, 200)}`
            )
          );
        });
      })().catch(reject);
    });
  }
  async health(): Promise<{ ok: boolean; detail: string }> {
    return new Promise((resolve) => {
      void (async () => {
        const { spawn } = await import('node:child_process');
        const isWin = process.platform === 'win32';
        const child = isWin
          ? spawn(
              'powershell',
              ['-NoProfile', '-NonInteractive', '-Command', `(Get-Printer -Name '${this.queue.replace(/'/g, "''")}' -ErrorAction Stop).Name`],
              { windowsHide: true }
            )
          : spawn('lpstat', ['-p', this.queue], { windowsHide: true });
        let out = '';
        child.stdout.on('data', (d) => (out += String(d)));
        child.once('error', () => resolve({ ok: false, detail: '找不到系统打印命令' }));
        child.once('close', (code) =>
          resolve(code === 0 ? { ok: true, detail: `${this.queue} 在线` } : { ok: false, detail: `${this.queue} 未找到或离线` })
        );
      })();
    });
  }
}

/**
 * Windows 本机 USB 打印（直送 spooler，不需要共享）
 *
 * 为什么单独做一条通道：
 *   - `usb` 在 Windows 没有可写设备节点（\\\\.\\USB001 是假的），只能靠蓝牙串口；
 *   - `system` 的 Windows 实现走 `copy /b` 到共享名，前提是先开「打印机共享」，
 *     收银机没开共享、或者 SMB 被安全策略挡住时，就卡在这一步；
 *   - 直接调 spooler 的 RAW 数据类型，不共享、不过驱动渲染，插上 USB 就能打。
 *
 * 实现方式是 scripts/win-raw-print.ps1（Add-Type 调 winspool.drv 的
 * StartDocPrinter(level 1, "RAW") / WritePrinter）。每次打印起一个 PowerShell 进程，
 * 首次约 1 秒（编译 C#），之后每次几百毫秒——小票一天几十张，这点开销无所谓，
 * 换来的是不依赖任何常驻服务或原生模块。
 *
 * 前提：这台打印机已经在「控制面板 → 设备和打印机」里，QUEUE 填它的名字。
 * 驱动选「Generic / Text Only」也可以——RAW 数据类型下驱动不参与渲染。
 */
export class WinSpoolChannel implements PrinterChannel {
  readonly kind = 'winspool' as const;
  readonly label: string;
  private queue: string;
  private script: string;
  private timeoutMs: number;

  constructor(o: ChannelOptions = {}) {
    if (!o.queue) throw new Error('Windows 本机打印缺少打印机名称（填控制面板里那台打印机的名字）');
    this.queue = o.queue;
    this.script = o.script ?? RAW_PRINT_SCRIPT;
    // 首次调用要编译 C#，给足时间；正常打印几百毫秒
    this.timeoutMs = o.timeoutMs ?? 20_000;
    this.label = `Windows 打印队列 ${this.queue}`;
  }

  send(payload: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      void (async () => {
        if (process.platform !== 'win32') {
          reject(new Error('winspool 只用于 Windows；Linux 请用 usb 或 system 通道'));
          return;
        }
        const [os, path, fs] = await Promise.all([
          import('node:os'),
          import('node:path'),
          import('node:fs/promises'),
        ]);
        const tmp = path.join(os.tmpdir(), `xc-print-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`);
        await fs.writeFile(tmp, payload);
        const cleanup = (): void => {
          void fs.unlink(tmp).catch(() => undefined);
        };
        const child = spawn(
          'powershell.exe',
          [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', this.script,
            '-Printer', this.queue,
            '-Path', tmp,
          ],
          { windowsHide: true }
        );
        let msg = '';
        child.stdout.on('data', (d) => (msg += String(d)));
        child.stderr.on('data', (d) => (msg += String(d)));

        const timer = setTimeout(() => {
          child.kill();
          cleanup();
          reject(new Error(`Windows 打印超过 ${Math.round(this.timeoutMs / 1000)} 秒没返回：打印机可能卡纸或脱机，看一眼面板灯`));
        }, this.timeoutMs);

        child.once('error', (e) => {
          clearTimeout(timer);
          cleanup();
          reject(new Error(`启动 PowerShell 失败：${e.message}`));
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          cleanup();
          if (code === 0) {
            resolve();
            return;
          }
          const raw = msg.trim();
          if (raw.startsWith('OPENPRINTER:')) {
            reject(new Error(`Windows 里找不到打印机「${this.queue}」：控制面板 → 设备和打印机，名字要一字不差（区分空格）`));
          } else if (raw.startsWith('FILENOTFOUND:')) {
            reject(new Error('打印临时文件没写成：磁盘满了或临时目录被安全软件锁住'));
          } else if (raw.startsWith('ADDTYPE:')) {
            reject(new Error(`Windows 打印助手启动失败：${raw.slice(8, 200)}`));
          } else if (raw.startsWith('STARTDOC:') || raw.startsWith('STARTPAGE:') || raw.startsWith('WRITE:')) {
            reject(new Error(`Windows 打印队列拒收（${raw}）：多半是打印机脱机、纸尽或驱动报错，先在控制面板打一张测试页`));
          } else if (raw.startsWith('PARTIAL:')) {
            reject(new Error(`只送出了部分字节（${raw.slice(8)}）：打印机缓冲区异常，重插 USB 再试`));
          } else {
            reject(new Error(`Windows 打印失败（退出码 ${code}）：${raw.slice(0, 200) || '没有返回原因'}`));
          }
        });
      })().catch(reject);
    });
  }

  health(): Promise<{ ok: boolean; detail: string }> {
    return new Promise((resolve) => {
      if (process.platform !== 'win32') {
        resolve({ ok: false, detail: 'winspool 只用于 Windows' });
        return;
      }
      const child = spawn(
        'powershell.exe',
        [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          `(Get-Printer -Name '${this.queue.replace(/'/g, "''")}' -ErrorAction Stop).Name`,
        ],
        { windowsHide: true }
      );
      let out = '';
      child.stdout.on('data', (d) => (out += String(d)));
      child.stderr.on('data', (d) => (out += String(d)));
      child.once('error', () => resolve({ ok: false, detail: '找不到 PowerShell，无法检查 Windows 打印队列' }));
      child.once('close', (code) => {
        if (code === 0 && out.trim()) resolve({ ok: true, detail: `Windows 队列「${this.queue}」已安装` });
        else resolve({ ok: false, detail: `Windows 里没有打印机「${this.queue}」：控制面板 → 设备和打印机，确认名字` });
      });
    });
  }
}

/** 演练通道 */
export class MockChannel implements PrinterChannel {
  readonly kind = 'mock' as const;
  readonly label = '演练模式（不实际打印）';
  sent: Buffer[] = [];
  async send(payload: Buffer): Promise<void> {
    this.sent.push(payload);
  }
  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: '演练模式始终正常' };
  }
}

export function createChannel(kind: TransportKind, o: ChannelOptions = {}): PrinterChannel {
  switch (kind) {
    case 'net':
      return new NetChannel(o);
    case 'usb':
      return new UsbChannel(o);
    case 'winspool':
      return new WinSpoolChannel(o);
    case 'system':
      return new SystemChannel(o);
    case 'mock':
      return new MockChannel();
    default:
      throw new Error(`不支持的打印通道：${String(kind)}`);
  }
}
