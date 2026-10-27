/**
 * 打印留痕：把调度器的每一条结果记进 print_jobs 表
 *
 * 只做两件事：写一笔、读最近几笔。不做业务判断。
 * 写失败绝不能反噬打印——调度器那边已经 try/catch，这里再兜一层。
 */

import type { DB } from '../db.ts';
import type { PrintJobResult } from './dispatcher.ts';

export interface PrintLogRow {
  target: string;
  orderNo: string;
  ok: boolean;
  attempts: number;
  pages: number;
  error: string | null;
  at: string;
}

export class PrintLog {
  constructor(private db: DB) {}

  /** 给调度器当 sink 用 */
  record = (r: PrintJobResult): void => {
    try {
      this.db
        .prepare('INSERT INTO print_jobs (target, order_no, ok, attempts, pages, error, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(r.target, r.orderNo, r.ok ? 1 : 0, r.attempts, r.pages, r.error ?? null, r.at);
    } catch {
      /* 落库失败不能反噬打印 */
    }
  };

  /** 最近的记录，最新的在前。默认只给失败看得见的那几条 */
  recent(limit = 30, onlyFailed = false): PrintLogRow[] {
    const sql = `SELECT target, order_no, ok, attempts, pages, error, at FROM print_jobs
                 ${onlyFailed ? 'WHERE ok = 0' : ''} ORDER BY id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(limit) as {
      target: string; order_no: string; ok: number; attempts: number; pages: number; error: string | null; at: string;
    }[];
    return rows.map((r) => ({
      target: r.target,
      orderNo: r.order_no,
      ok: r.ok === 1,
      attempts: r.attempts,
      pages: r.pages,
      error: r.error,
      at: r.at,
    }));
  }

  /** 今天有几张纸没出来——老板端顶部角标用 */
  failedToday(businessDate: string): number {
    return this.db
      .prepare("SELECT COUNT(*) FROM print_jobs WHERE ok = 0 AND substr(at, 1, 10) = ?")
      .pluck()
      .get(businessDate) as number;
  }
}
