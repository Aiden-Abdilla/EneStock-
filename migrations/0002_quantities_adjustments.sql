-- 0002: allow multi-unit movements (e.g. "stock in 10 patch leads") and
-- stock-take count adjustments. SQLite cannot alter a CHECK constraint, so the
-- movements table is rebuilt and existing history is copied across unchanged.
-- Nothing references movements, so dropping the old table is safe.
CREATE TABLE movements_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  item_name TEXT NOT NULL,
  barcode TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100000),
  resulting_balance INTEGER NOT NULL CHECK (resulting_balance >= 0),
  reason TEXT NOT NULL DEFAULT 'scan' CHECK (reason IN ('scan', 'adjustment')),
  note TEXT CHECK (note IS NULL OR length(note) <= 200),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO movements_new (id, request_id, item_id, item_name, barcode, direction, quantity, resulting_balance, reason, note, created_at)
  SELECT id, request_id, item_id, item_name, barcode, direction, quantity, resulting_balance, 'scan', NULL, created_at FROM movements;
DROP TRIGGER movement_updates_stock;
DROP TABLE movements;
ALTER TABLE movements_new RENAME TO movements;
CREATE INDEX idx_movements_created_at ON movements(created_at, id);
CREATE INDEX idx_movements_item_id ON movements(item_id, created_at);
-- Same guarantee as before, now for N units: the stock update only applies if
-- the item's balance is exactly what the movement expected, else the whole
-- INSERT is rolled back.
CREATE TRIGGER movement_updates_stock AFTER INSERT ON movements
BEGIN
  UPDATE items
  SET quantity = NEW.resulting_balance
  WHERE id = NEW.item_id
    AND quantity = CASE NEW.direction WHEN 'in' THEN NEW.resulting_balance - NEW.quantity
                                              ELSE NEW.resulting_balance + NEW.quantity END;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'stale inventory balance') END;
END;
