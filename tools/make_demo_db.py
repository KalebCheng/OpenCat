"""Build the bundled SQLite sample database.

Creates `examples/demo.db` with a small but realistic commerce schema, so a first
run has something to browse without needing a server.

    python tools/make_demo_db.py
"""

from __future__ import annotations

import random
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "examples" / "demo.db"

SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE customers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    email       TEXT    NOT NULL UNIQUE,
    country     TEXT    NOT NULL DEFAULT 'CN',
    tier        TEXT    NOT NULL DEFAULT 'standard'
                CHECK (tier IN ('standard', 'silver', 'gold')),
    credit      NUMERIC(12, 2) DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT 1,
    joined_at   DATETIME NOT NULL,
    notes       TEXT
);

CREATE TABLE products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sku         TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    category    TEXT    NOT NULL,
    unit_price  NUMERIC(10, 2) NOT NULL,
    stock       INTEGER NOT NULL DEFAULT 0,
    attributes  JSON,
    created_at  DATETIME NOT NULL
);

CREATE TABLE orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    status       TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled', 'refunded')),
    total        NUMERIC(12, 2) NOT NULL DEFAULT 0,
    placed_at    DATETIME NOT NULL,
    shipped_at   DATETIME
);

CREATE TABLE order_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id  INTEGER NOT NULL REFERENCES products(id),
    quantity    INTEGER NOT NULL CHECK (quantity > 0),
    unit_price  NUMERIC(10, 2) NOT NULL,
    UNIQUE (order_id, product_id)
);

CREATE INDEX idx_orders_customer ON orders (customer_id);
CREATE INDEX idx_orders_placed_at ON orders (placed_at);
CREATE INDEX idx_order_items_product ON order_items (product_id);
CREATE INDEX idx_products_category ON products (category);

CREATE VIEW order_summary AS
SELECT
    o.id                AS order_id,
    c.name              AS customer,
    c.country           AS country,
    o.status            AS status,
    o.total             AS total,
    COUNT(i.id)         AS line_items,
    o.placed_at         AS placed_at
FROM orders o
JOIN customers   c ON c.id = o.customer_id
LEFT JOIN order_items i ON i.order_id = o.id
GROUP BY o.id;
"""

FIRST_NAMES = [
    "Wei", "Fang", "Min", "Lei", "Jing", "Hao", "Yan", "Qiang", "Xin", "Tao",
    "Alice", "Bruno", "Chloe", "Diego", "Emma", "Farid", "Greta", "Hiro",
    "Ines", "Jonas", "Kaia", "Luca", "Mira", "Noor", "Omar", "Petra",
]
LAST_NAMES = [
    "Zhang", "Wang", "Li", "Zhao", "Chen", "Liu", "Yang", "Huang", "Wu", "Zhou",
    "Silva", "Nguyen", "Kim", "Patel", "Rossi", "Novak", "Haddad", "Costa",
]
COUNTRIES = ["CN", "SG", "JP", "DE", "US", "BR", "GB", "AU", "CA", "FR"]
TIERS = ["standard", "standard", "standard", "silver", "gold"]

CATALOGUE = [
    ("Mechanical Keyboard K87", "peripherals", 89.00, {"switch": "brown", "layout": "TKL", "wireless": False}),
    ("Wireless Mouse M2", "peripherals", 39.50, {"dpi": 16000, "buttons": 6, "wireless": True}),
    ("27\" 4K Monitor", "displays", 429.00, {"panel": "IPS", "refresh": 60, "hdr": True}),
    ("34\" Ultrawide Monitor", "displays", 749.00, {"panel": "VA", "refresh": 144, "hdr": True}),
    ("USB-C Dock 12-in-1", "accessories", 119.00, {"ports": 12, "power_delivery": 100}),
    ("Noise Cancelling Headphones", "audio", 279.00, {"anc": True, "battery_hours": 30}),
    ("Studio Microphone", "audio", 149.00, {"pattern": "cardioid", "connector": "USB-C"}),
    ("NVMe SSD 2TB", "storage", 189.00, {"interface": "PCIe 4.0", "read_mbps": 7000}),
    ("External SSD 1TB", "storage", 109.00, {"interface": "USB 3.2", "read_mbps": 1050}),
    ("Laptop Stand Aluminium", "accessories", 45.00, {"adjustable": True, "material": "aluminium"}),
    ("Webcam 4K", "peripherals", 159.00, {"resolution": "4K", "fps": 30, "autofocus": True}),
    ("Desk Mat XL", "accessories", 29.00, {"width_mm": 900, "material": "felt"}),
    ("Ergonomic Chair", "furniture", 599.00, {"adjustable_lumbar": True, "warranty_years": 5}),
    ("Standing Desk 160cm", "furniture", 899.00, {"height_range_mm": [650, 1300], "motor": "dual"}),
    ("Portable Projector", "displays", 349.00, {"lumens": 800, "resolution": "1080p"}),
]


def main() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    if DB_PATH.exists():
        DB_PATH.unlink()

    random.seed(20240501)
    connection = sqlite3.connect(DB_PATH)
    connection.executescript(SCHEMA)

    # --- customers ---------------------------------------------------------
    now = datetime(2024, 5, 1, 9, 0, 0)
    customers = []
    for index in range(120):
        name = f"{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}"
        email = f"{name.lower().replace(' ', '.')}{index}@example.com"
        joined = now - timedelta(days=random.randint(30, 900))
        customers.append(
            (
                name,
                email,
                random.choice(COUNTRIES),
                random.choice(TIERS),
                round(random.uniform(0, 5000), 2),
                random.random() > 0.12,
                joined.strftime("%Y-%m-%d %H:%M:%S"),
                None,
            )
        )
    connection.executemany(
        "INSERT INTO customers (name, email, country, tier, credit, is_active, joined_at, notes)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        customers,
    )

    # A couple of deliberately awkward rows, so the grid has something to show.
    connection.execute(
        "UPDATE customers SET notes = ? WHERE id = 1",
        ("VIP since day one — prefers email contact, timezone GMT+8.",),
    )
    connection.execute(
        "UPDATE customers SET notes = ? WHERE id = 2",
        ("Long note to exercise the cell viewer: " + "lorem ipsum " * 40,),
    )
    connection.execute("UPDATE customers SET credit = NULL WHERE id = 3")

    # --- products ----------------------------------------------------------
    products = []
    for index, (name, category, price, attributes) in enumerate(CATALOGUE, start=1):
        products.append(
            (
                f"SKU-{index:04d}",
                name,
                category,
                price,
                random.randint(0, 400),
                sqlite3.Binary(__import__("json").dumps(attributes).encode()),
                (now - timedelta(days=random.randint(1, 600))).strftime("%Y-%m-%d %H:%M:%S"),
            )
        )
    connection.executemany(
        "INSERT INTO products (sku, name, category, unit_price, stock, attributes, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        products,
    )

    # --- orders + items ----------------------------------------------------
    catalog = list(
        connection.execute("SELECT id, unit_price FROM products").fetchall()
    )
    statuses = ["pending", "paid", "paid", "shipped", "shipped", "cancelled", "refunded"]

    for order_index in range(1, 401):
        customer_id = random.randint(1, 120)
        status = random.choice(statuses)
        placed = now - timedelta(days=random.randint(0, 400), hours=random.randint(0, 23))
        shipped = None
        if status in ("shipped", "refunded"):
            shipped = (placed + timedelta(days=random.randint(1, 6))).strftime(
                "%Y-%m-%d %H:%M:%S"
            )

        line_count = random.randint(1, 4)
        chosen = random.sample(catalog, line_count)
        lines = [
            (product_id, random.randint(1, 3), unit_price)
            for product_id, unit_price in chosen
        ]
        total = round(sum(quantity * price for _, quantity, price in lines), 2)

        cursor = connection.execute(
            "INSERT INTO orders (customer_id, status, total, placed_at, shipped_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (
                customer_id,
                status,
                total,
                placed.strftime("%Y-%m-%d %H:%M:%S"),
                shipped,
            ),
        )
        order_id = cursor.lastrowid
        connection.executemany(
            "INSERT INTO order_items (order_id, product_id, quantity, unit_price)"
            " VALUES (?, ?, ?, ?)",
            [(order_id, p, q, price) for p, q, price in lines],
        )

    connection.commit()

    counts = {
        table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in ("customers", "products", "orders", "order_items")
    }
    connection.close()

    size = DB_PATH.stat().st_size
    print(f"wrote {DB_PATH} ({size / 1024:.1f} KiB)")
    for table, count in counts.items():
        print(f"  {table}: {count} rows")


if __name__ == "__main__":
    main()
