import { openDb } from '../db.js';

/** 首次部署冒烟用：往空库塞 3 道测试菜。正式菜品由老板后台上传 */
const SEED_DISHES: [string, number, string][] = [
  ['农家一碗香', 1800, '招牌'],
  ['酸豆角炒肉末', 1500, '下饭神器'],
  ['紫苏炒田螺', 2200, '招牌'],
];

const db = openDb();
const n = (db.prepare('SELECT COUNT(*) AS c FROM dishes').get() as { c: number }).c;
if (n > 0) {
  console.log(`库里已有 ${n} 道菜，跳过种子数据`);
} else {
  const ins = db.prepare(
    `INSERT INTO dishes(name, price_cents, category) VALUES(?, ?, ?)`
  );
  for (const [name, price, category] of SEED_DISHES) ins.run(name, price, category);
  console.log(`已写入 ${SEED_DISHES.length} 道种子菜品`);
}
db.close();
