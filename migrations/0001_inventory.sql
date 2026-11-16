PRAGMA foreign_keys = ON;
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  barcode TEXT NOT NULL UNIQUE CHECK (length(barcode) BETWEEN 1 AND 128),
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  item_name TEXT NOT NULL,
  barcode TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity = 1),
  resulting_balance INTEGER NOT NULL CHECK (resulting_balance >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_movements_created_at ON movements(created_at, id);
CREATE INDEX idx_movements_item_id ON movements(item_id);
-- Every successful movement is a single SQLite transaction, including the
-- change to items.quantity. A failed INSERT cannot run this trigger.
CREATE TRIGGER movement_updates_stock AFTER INSERT ON movements
BEGIN
  UPDATE items
  SET quantity = NEW.resulting_balance
  WHERE id = NEW.item_id
    AND quantity = CASE NEW.direction WHEN 'in' THEN NEW.resulting_balance - 1
                                              ELSE NEW.resulting_balance + 1 END;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'stale inventory balance') END;
END;
