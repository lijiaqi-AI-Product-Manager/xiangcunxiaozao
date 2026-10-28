/**
 * 打印调度器：订单创建 → 小票机 + 标签机
 *
 * 四条硬规则（比"下单就打印"多想了四步）：
 *
 * 1. **绝不阻塞下单**。下单接口照常 200/201 返回，打印在后台队列跑。
 *    打印机没开 ≠ 顾客下不了单——这是不可退让的。
 *
 * 2. **失败重试 + 留痕**。打印机没开/网络抖/纸卡了都会失败。
 *    失败指数退避重试，最终失败交给 sink 落库，老板端能看到"哪单没打出来"并手动重打。
 *    绝不能出现"单下了纸没出"的静默事故。
 *
 * 3. **串行化**。同一台机器同时收两单，字节流会交织成乱码。每台机器一条独立队列。
 *
 * 4. **幂等**。同一订单同一目标只打一次，防重试/重复事件导致重复出纸。
 */

import type { PrinterChannel } from './transport.ts';
import { renderCups, renderReceipt, type PrintConfig, type PrintOrder, type ShopInfo } from './templates.ts';

export type TargetName = 'receipt' | 'label';

export interface TargetSpec {
  name: TargetName;
  enabled: boolean;
  channel: PrinterChannel;
  config: PrintConfig;
  /** 标签专用：桌号用三倍字还是两倍字（小票忽略） */
  bigTable?: boolean;
  retries: number;
  backoffMs: number;
}

export interface PrintJobResult {
  target: TargetName;
  orderNo: string;
  ok: boolean;
  attempts: number;
  pages: number;
  error?: string;
  at: string;
}

export type PrintJobSink = (r: PrintJobResult) => void;

export interface DispatcherOptions {
  targets: TargetSpec[];
  sink?: PrintJobSink;
}

interface QueueItem {
  target: TargetName;
  orderNo: string;
  payloads: Buffer[];
  attempts: number;
  resolve: (r: PrintJobResult) => void;
}

const now = (): string => new Date().toISOString();

export class PrintDispatcher {
  private targets = new Map<TargetName, TargetSpec>();
  private queues = new Map<TargetName, QueueItem[]>();
  private running = new Set<TargetName>();
  /** 幂等表：排队时就占位（key = target:orderNo），不等到打成功——否则并发两次都放行 */
  private claimed = new Set<string>();
  private sink?: PrintJobSink;

  constructor(opts: DispatcherOptions) {
    for (const t of opts.targets) {
      this.targets.set(t.name, t);
      this.queues.set(t.name, []);
    }
    this.sink = opts.sink;
  }

  /** 订单创建入口（同步返回，不等打印机） */
  printOrder(order: PrintOrder, shop: ShopInfo): void {
    for (const [name, spec] of this.targets) {
      if (!spec.enabled) continue;
      const key = `${name}:${order.order_no}`;
      if (this.claimed.has(key)) continue;
      let payloads: Buffer[];
      try {
        payloads = name === 'receipt'
          ? [renderReceipt(order, shop, spec.config)]
          : renderCups(order, { bigTable: spec.bigTable ?? true }, spec.config);
      } catch (e) {
        this.emit({ target: name, orderNo: order.order_no, ok: false, attempts: 0, pages: 0, error: `排版失败：${(e as Error).message}`, at: now() });
        continue;
      }
      if (payloads.length === 0) continue;
      this.claimed.add(key);
      this.enqueue({ target: name, orderNo: order.order_no, payloads, attempts: 0, resolve: () => undefined });
    }
  }

  /** 手动重打（老板端点"重新打印"） */
  reprint(target: TargetName, order: PrintOrder, shop: ShopInfo): Promise<PrintJobResult> {
    const spec = this.targets.get(target);
    if (!spec) {
      return Promise.resolve({ target, orderNo: order.order_no, ok: false, attempts: 0, pages: 0, error: '目标不存在', at: now() });
    }
    const payloads = target === 'receipt'
      ? [renderReceipt(order, shop, spec.config)]
      : renderCups(order, { bigTable: spec.bigTable ?? true }, spec.config);
    return new Promise((resolve) => {
      this.enqueue({ target, orderNo: order.order_no, payloads, attempts: 0, resolve });
    });
  }

  /**
   * 两台机器同时探，不是一台一台来。
   *
   * 打印机没开机时，health() 要等到超时才返回（约 5 秒）。串行跑两台就是 10 秒，
   * 老板打开「打印设置」看着一行「加载中…」干等十秒，很容易以为页面坏了。
   * 两台互不依赖，并行之后最坏也就一次超时的时间。
   */
  async healthAll(): Promise<Record<string, { enabled: boolean; ok: boolean; detail: string }>> {
    const entries = await Promise.all(
      [...this.targets].map(async ([name, spec]) => {
        const h = spec.enabled ? await spec.channel.health() : { ok: false, detail: '未启用' };
        return [name, { enabled: spec.enabled, ...h }] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  private emit(r: PrintJobResult): void {
    if (!this.sink) return;
    try {
      this.sink(r);
    } catch {
      /* 落库失败不能反噬打印 */
    }
  }

  private enqueue(item: QueueItem): void {
    const q = this.queues.get(item.target);
    if (!q) return;
    q.push(item);
    void this.drain(item.target);
  }

  private async drain(target: TargetName): Promise<void> {
    if (this.running.has(target)) return;
    const spec = this.targets.get(target);
    const q = this.queues.get(target);
    if (!spec || !q) return;
    this.running.add(target);
    try {
      while (q.length > 0) {
        const item = q.shift() as QueueItem;
        let lastErr = '';
        let ok = false;
        for (let attempt = 0; attempt <= spec.retries; attempt++) {
          item.attempts += 1;
          try {
            for (const p of item.payloads) await spec.channel.send(p);
            ok = true;
            break;
          } catch (e) {
            lastErr = (e as Error).message;
            if (attempt < spec.retries) await new Promise((r) => setTimeout(r, spec.backoffMs * 2 ** attempt));
          }
        }
        const result: PrintJobResult = {
          target,
          orderNo: item.orderNo,
          ok,
          attempts: item.attempts,
          pages: item.payloads.length,
          error: ok ? undefined : lastErr,
          at: now(),
        };
        this.emit(result);
        item.resolve(result);
      }
    } finally {
      this.running.delete(target);
    }
  }
}
