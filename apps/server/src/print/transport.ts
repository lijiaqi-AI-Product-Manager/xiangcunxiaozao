/**
 * 打印通道：把字节送到纸上
 *
 * 三种接法，覆盖你店里所有可能：
 * 1) net    —— 网络打印机 / 网口转 USB 打印服务器（推荐，最稳）。打印机 = 局域网 IP:9100
 * 2) usb    —— USB 线直插跑本程序的电脑（Linux 设备节点 /dev/usb/lp0，Windows 走共享名）
 * 3) system —— 交给操作系统打印队列（lp / Windows print 命令）
 * 4) mock   —— 演练模式，只记录不发，没接机器也能跑通全流程自测
 *
 * 上层（调度器）只认 PrinterChannel 接口，底下换线完全不改业务代码。
 */

import net from 'node:net';
import { parseStatus, statusQuery, statusText, type PrinterStatus } from './escpos.ts';

export type TransportKind = 'net' | 'usb' | 'system' | 'mock';

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

/** USB 直连（Linux 设备节点） */
export class UsbChannel implements PrinterChannel {
  readonly kind = 'usb' as const;
  readonly label: string;
  private device: string;
  constructor(o: ChannelOptions) {
    if (!o.device) throw new Error('USB 打印机缺少设备路径（如 /dev/usb/lp0）');
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

/** 系统打印队列 */
export class SystemChannel implements PrinterChannel {
  readonly kind = 'system' as const;
  readonly label: string;
  private queue: string;
  constructor(o: ChannelOptions) {
    if (!o.queue) throw new Error('系统打印队列缺少队列名');
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
        const cmd = isWin ? 'print' : 'lp';
        const args = isWin ? [`/D:${this.queue}`, tmp] : ['-d', this.queue, '-o', 'raw', tmp];
        const child = spawn(cmd, args, { windowsHide: true });
        let err = '';
        child.stderr.on('data', (d) => (err += String(d)));
        child.once('error', reject);
        child.once('close', (code) => {
          void fs.unlink(tmp).catch(() => undefined);
          if (code === 0) resolve();
          else reject(new Error(`打印命令失败（${code}）：${err.slice(0, 200)}`));
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
          ? spawn('wmic', ['printer', 'get', 'name'], { windowsHide: true })
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
    case 'system':
      return new SystemChannel(o);
    case 'mock':
      return new MockChannel();
    default:
      throw new Error(`不支持的打印通道：${String(kind)}`);
  }
}
