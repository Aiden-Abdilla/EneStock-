-- 0003: stores/locations, stock per location, transfers, categories,
-- minimum stock levels, and who made each movement.
--
-- Existing stock and history are kept: everything moves to a "Main store"
-- location (rename it afterwards in the app), and every past movement is
-- recorded as having happened there.

CREATE TABLE locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(trim(name)) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO locations (id, name) VALUES (1, 'Main store');

-- Stock on hand per item per location. items.quantity stays as the total
-- across all locations; the trigger below keeps the two in step.
CREATE TABLE stock (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  PRIMARY KEY (item_id, location_id)
);
INSERT INTO stock (item_id, location_id, quantity) SELECT id, 1, quantity FROM items WHERE quantity > 0;
CREATE INDEX idx_stock_location ON stock(location_id);

ALTER TABLE items ADD COLUMN category TEXT CHECK (category IS NULL OR length(category) <= 60);
ALTER TABLE items ADD COLUMN min_qty INTEGER CHECK (min_qty IS NULL OR min_qty BETWEEN 0 AND 1000000);

-- movements gains: location, per-location balance, transfer destination, actor.
CREATE TABLE movements_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  item_name TEXT NOT NULL,
  barcode TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out', 'transfer')),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100000),
  -- Item total across all locations after this movement (unchanged by transfers).
  resulting_balance INTEGER NOT NULL CHECK (resulting_balance >= 0),
  -- For in/out: where it happened. For transfers: where it came from.
  location_id INTEGER NOT NULL DEFAULT 1 REFERENCES locations(id) ON DELETE RESTRICT,
  location_balance INTEGER NOT NULL CHECK (location_balance >= 0),
  to_location_id INTEGER REFERENCES locations(id) ON DELETE RESTRICT,
  to_location_balance INTEGER CHECK (to_location_balance IS NULL OR to_location_balance >= 0),
  reason TEXT NOT NULL DEFAULT 'scan' CHECK (reason IN ('scan', 'adjustment')),
  note TEXT CHECK (note IS NULL OR length(note) <= 200),
  actor TEXT CHECK (actor IS NULL OR length(actor) <= 120),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((direction = 'transfer') = (to_location_id IS NOT NULL AND to_location_balance IS NOT NULL)),
  CHECK (to_location_id IS NULL OR to_location_id != location_id)
);
-- Before this migration there was one store, so the location balance equals the item total.
INSERT INTO movements_new (id, request_id, item_id, item_name, barcode, direction, quantity, resulting_balance, location_id, location_balance, reason, note, created_at)
  SELECT id, request_id, item_id, item_name, barcode, direction, quantity, resulting_balance, 1, resulting_balance, reason, note, created_at FROM movements;
DROP TRIGGER movement_updates_stock;
DROP TABLE movements;
ALTER TABLE movements_new RENAME TO movements;
CREATE INDEX idx_movements_created_at ON movements(created_at, id);
CREATE INDEX idx_movements_item_id ON movements(item_id, created_at);

-- One INSERT = one atomic change. Each balance is only applied if the stored
-- value is exactly what the movement expected; otherwise the whole INSERT is
-- rolled back, so concurrent scans can never double-count or go negative.
CREATE TRIGGER movement_updates_stock AFTER INSERT ON movements
BEGIN
  UPDATE items SET quantity = NEW.resulting_balance
  WHERE id = NEW.item_id
    AND quantity = CASE NEW.direction WHEN 'in' THEN NEW.resulting_balance - NEW.quantity
                                      WHEN 'out' THEN NEW.resulting_balance + NEW.quantity
                                      ELSE NEW.resulting_balance END;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'stale inventory balance') END;

  INSERT OR IGNORE INTO stock (item_id, location_id, quantity) VALUES (NEW.item_id, NEW.location_id, 0);
  UPDATE stock SET quantity = NEW.location_balance
  WHERE item_id = NEW.item_id AND location_id = NEW.location_id
    AND quantity = CASE NEW.direction WHEN 'in' THEN NEW.location_balance - NEW.quantity
                                      ELSE NEW.location_balance + NEW.quantity END;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'stale location balance') END;

  INSERT OR IGNORE INTO stock (item_id, location_id, quantity)
    SELECT NEW.item_id, NEW.to_location_id, 0 WHERE NEW.direction = 'transfer';
  UPDATE stock SET quantity = NEW.to_location_balance
  WHERE NEW.direction = 'transfer' AND item_id = NEW.item_id AND location_id = NEW.to_location_id
    AND quantity = NEW.to_location_balance - NEW.quantity;
  SELECT CASE WHEN NEW.direction = 'transfer' AND changes() != 1 THEN RAISE(ABORT, 'stale destination balance') END;
END;
