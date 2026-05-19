const initSqlJs = require("sql.js");
const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "chatbot.db");

async function seedDatabase() {
  const SQL = await initSqlJs();

  // Load existing database or create new one
  let db;
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
    console.log("📁 Database loaded from: chatbot.db");
  } else {
    db = new SQL.Database();
    console.log("📁 Database created: chatbot.db");
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_phone TEXT NOT NULL,
      customer_message TEXT NOT NULL,
      bot_response TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_name TEXT NOT NULL,
      brand TEXT NOT NULL,
      price REAL NOT NULL,
      stock INTEGER DEFAULT 1,
      UNIQUE(product_name, brand)
    );

    CREATE INDEX IF NOT EXISTS idx_phone ON conversations(customer_phone);
    CREATE INDEX IF NOT EXISTS idx_product ON inventory(product_name);
  `);

  console.log("✅ Tables and indexes created");

  // Seed inventory
  const count = db.exec("SELECT COUNT(*) as count FROM inventory");
  const rowCount = count.length > 0 ? count[0].values[0][0] : 0;

  if (rowCount === 0) {
    const products = [
      { product_name: "Unga ugali", brand: "Soko", price: 160 },
      { product_name: "Unga ugali", brand: "Pembe", price: 140 },
      { product_name: "Unga ugali", brand: "Tamu", price: 160 },
      { product_name: "Rice", brand: "Basmati King", price: 450 },
      { product_name: "Rice", brand: "Pishori", price: 380 },
      { product_name: "Sugar", brand: "Mumias", price: 220 },
      { product_name: "Sugar", brand: "Local", price: 210 },
      { product_name: "Cooking Oil", brand: "Kapa", price: 520 },
      { product_name: "Cooking Oil", brand: "Nyota", price: 500 },
    ];

    const stmt = db.prepare(
      `INSERT OR IGNORE INTO inventory (product_name, brand, price, stock) VALUES (?, ?, ?, 1)`,
    );

    products.forEach((p) => {
      stmt.run([p.product_name, p.brand, p.price]);
    });

    stmt.free();

    console.log("✅ Inventory seeded with 9 products");
  } else {
    console.log(`✅ Inventory already exists (${rowCount} items)`);
  }

  // Save database to disk
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
  console.log("💾 Database saved to chatbot.db");

  db.close();
  console.log("🎉 Seeding complete!");
}

seedDatabase().catch((err) => {
  console.error("❌ Failed to seed database:", err);
  process.exit(1);
});
