import type { Server as HttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { EventEmitter } from 'node:events';
import type { OrderEvent } from './events.js';

/**
 * 后厨实时推送（D2核心）：
 * - 鉴权：连接时 ?token=（kitchen 或 admin 令牌），失败立即关闭
 * - 心跳：服务端 30s ping 一轮，连续两轮无 pong 踢掉死连接
 * - 事件：order:new / order:status 广播给所有已认证连接
 * - 客户端另有 HTTP 轮询兜底（5s），WS 断了也不漏单（双保险，前端实现）
 */

interface AuthedSocket {
  ws: WebSocket;
  role: 'kitchen' | 'admin';
  alive: boolean;
}

function tokenMatches(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface WsHandle {
  /** 关闭WS服务并清理心跳定时器（测试收尾用） */
  close: () => void;
}

export function setupWs(
  server: HttpServer,
  bus: EventEmitter,
  adminToken: string,
  kitchenToken: string
): WsHandle {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 });

  const authed = new Set<AuthedSocket>();

  wss.on('connection', (ws, req) => {
    let role: 'kitchen' | 'admin' | null = null;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const token = url.searchParams.get('token') ?? '';
      if (token.length > 0 && tokenMatches(token, adminToken)) role = 'admin';
      else if (token.length > 0 && tokenMatches(token, kitchenToken)) role = 'kitchen';
    } catch {
      role = null;
    }
    if (!role) {
      ws.close(4001, 'unauthorized');
      return;
    }
    const sock: AuthedSocket = { ws, role, alive: true };
    authed.add(sock);
    ws.on('pong', () => (sock.alive = true));
    ws.on('close', () => authed.delete(sock));
    ws.on('error', () => authed.delete(sock));
    ws.send(JSON.stringify({ type: 'hello', role, now: new Date().toISOString() }));
  });

  // 心跳：两轮无 pong 视为死连接
  const HEARTBEAT_MS = 30_000;
  const hb = setInterval(() => {
    for (const s of authed) {
      if (!s.alive) {
        s.ws.terminate();
        authed.delete(s);
        continue;
      }
      s.alive = false;
      try {
        s.ws.ping();
      } catch {
        authed.delete(s);
      }
    }
  }, HEARTBEAT_MS);
  hb.unref?.();

  const broadcast = (ev: OrderEvent) => {
    const msg = JSON.stringify(ev);
    for (const s of authed) {
      if (s.ws.readyState === WebSocket.OPEN) {
        try {
          s.ws.send(msg);
        } catch {
          authed.delete(s);
        }
      }
    }
  };

  bus.on('order:new', (ev: OrderEvent) => broadcast(ev));
  bus.on('order:status', (ev: OrderEvent) => broadcast(ev));

  wss.on('error', (err) => console.error(JSON.stringify({ t: new Date().toISOString(), msg: 'WS服务异常', err: String(err) })));

  return {
    close: () => {
      clearInterval(hb);
      for (const s of authed) {
        try {
          s.ws.terminate();
        } catch {
          /* 已断开 */
        }
      }
      authed.clear();
      wss.close();
    },
  };
}
