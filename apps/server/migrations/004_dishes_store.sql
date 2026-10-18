-- 菜品管理（上下架/改价/图片）与营业状态（P2 第三批）
-- 菜单原始数据仍是 menu.json（批准稿，不改）；老板在后台的改动单独存一层，叠加显示。

CREATE TABLE dish_overrides (
  dish_uid      TEXT PRIMARY KEY,
  listed        INTEGER,          -- NULL = 跟随菜单；0 = 下架；1 = 上架
  price_sen     INTEGER CHECK (price_sen IS NULL OR price_sen >= 0),
  image_closed  TEXT,             -- 老板上传的图（/media/...），优先于菜单里的图
  updated_at    TEXT NOT NULL
);

-- 每次改动留痕：谁、什么时候、改了什么、从多少改到多少
CREATE TABLE dish_changes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  dish_uid   TEXT NOT NULL,
  field      TEXT NOT NULL CHECK (field IN ('listed', 'price', 'image')),
  old_value  TEXT,
  new_value  TEXT,
  operator   TEXT NOT NULL,
  at         TEXT NOT NULL
);

CREATE TRIGGER dish_changes_append_only_u BEFORE UPDATE ON dish_changes
BEGIN SELECT RAISE(ABORT, 'dish_changes is append-only'); END;
CREATE TRIGGER dish_changes_append_only_d BEFORE DELETE ON dish_changes
BEGIN SELECT RAISE(ABORT, 'dish_changes is append-only'); END;
