import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { buildApp } from '../src/app.js';
import { makeBus } from '../src/events.js';
import { setupWs } from '../src/ws.js';
import { openDb } from '../src/db.js';

/** 每个测试文件一套独立环境：临时目录数据库 + 随机端口 + 测试令牌 + WS */
export async function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcz-test-'));
  const dbFile = path.join(dir, 't.db');
  const db = openDb(dbFile);
  const adminToken = 'test-admin-token-0123456789ab';
  const kitchenToken = 'test-kitchen-token-0123456789ab';

  const bus = makeBus();
  const app = buildApp({
    db,
    bus,
    adminToken,
    kitchenToken,
    limits: { orderPerMin: 100000, globalPerMin: 1000000 }, // 测试放开限流
  });
  const server = http.createServer(app);
  const wsHandle = setupWs(server, bus, adminToken, kitchenToken);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const wsBase = `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`;

  const jsonHeaders = { 'Content-Type': 'application/json' };
  const admin = { ...jsonHeaders, Authorization: `Bearer ${adminToken}` };
  const kitchen = { ...jsonHeaders, Authorization: `Bearer ${kitchenToken}` };

  const createDish = async (name: string, price: string | number) => {
    const res = await fetch(`${base}/api/dishes`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ name, price }),
    });
    return { status: res.status, body: (await res.json()) as { id: number } };
  };

  const order = async (body: unknown) => {
    const res = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const close = async () => {
    wsHandle.close(); // 先杀WS再关HTTP，否则 server.close() 会挂死
    server.close();
    try {
      db.close();
    } catch {
      /* 持久性测试可能已关闭 */
    }
  };

  return { base, wsBase, admin, kitchen, jsonHeaders, db, dbFile, dir, createDish, order, close };
}
