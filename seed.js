const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "chatbot.db");

function seedDatabase() {
  console.log("🌱 Starting database seed...\n");

  // Initialize database with WAL mode for better concurrency
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  console.log("✅ Database initialized with WAL mode\n");

  // ============================================================================
  // CREATE TABLES
  // ============================================================================

  console.log("📋 Creating tables...");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      shop_id TEXT PRIMARY KEY,
      whatsapp_phone_id TEXT UNIQUE NOT NULL,
      shop_name TEXT NOT NULL,
      till_number TEXT,
      owner_phone TEXT,
      rider_phone TEXT,
      spreadsheet_id TEXT,
      currency TEXT DEFAULT 'KES',
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS shop_catalogs (
      shop_id TEXT PRIMARY KEY,
      products_json TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (shop_id) REFERENCES tenants(shop_id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_phone TEXT NOT NULL,
      customer_message TEXT NOT NULL,
      bot_response TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversation_state (
      customer_phone TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      current_step TEXT,
      metadata_json TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (shop_id) REFERENCES tenants(shop_id)
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_name TEXT NOT NULL,
      brand TEXT NOT NULL,
      price REAL NOT NULL,
      stock INTEGER DEFAULT 1,
      UNIQUE(product_name, brand)
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(customer_phone);
    CREATE INDEX IF NOT EXISTS idx_conversations_timestamp ON conversations(timestamp);
    CREATE INDEX IF NOT EXISTS idx_inventory_product ON inventory(product_name);
    CREATE INDEX IF NOT EXISTS idx_state_shop ON conversation_state(shop_id);
  `);

  console.log("✅ All tables and indexes created\n");

  // ============================================================================
  // SEED TENANTS
  // ============================================================================

  console.log("🏪 Seeding tenant configuration...");

  const existingTenant = db
    .prepare("SELECT 1 FROM tenants WHERE shop_id = ?")
    .get("shop_1");

  if (!existingTenant) {
    const tenants = [
      {
        shop_id: "shop_1",
        whatsapp_phone_id: process.env.BUSINESS_PHONE || "1040339102503628",
        shop_name: "Karibu Fair Price",
        till_number: process.env.TILL_NUMBER || "5544321",
        owner_phone: process.env.OWNER_PHONE || "254792305846",
        rider_phone: process.env.RIDER_PHONE || "254792120237",
        spreadsheet_id:
          process.env.SPREADSHEET_ID ||
          "1vifZdUbTvNnpyJ4bJZKAtxcQnLErY9WjevAAIc691dc",
        currency: "KES",
        status: "active",
      },
    ];

    const insertTenant = db.prepare(`
      INSERT INTO tenants 
      (shop_id, whatsapp_phone_id, shop_name, till_number, owner_phone, rider_phone, spreadsheet_id, currency, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const tenant of tenants) {
      insertTenant.run(
        tenant.shop_id,
        tenant.whatsapp_phone_id,
        tenant.shop_name,
        tenant.till_number,
        tenant.owner_phone,
        tenant.rider_phone,
        tenant.spreadsheet_id,
        tenant.currency,
        tenant.status,
      );
      console.log(`  ✅ Tenant "${tenant.shop_name}" created`);
    }
  } else {
    console.log("  ℹ️  Tenant already exists, skipping");
  }

  console.log();

  // ============================================================================
  // SEED SHOP CATALOGS
  // ============================================================================

  console.log("📦 Seeding shop catalogs...");

  const existingCatalog = db
    .prepare("SELECT 1 FROM shop_catalogs WHERE shop_id = ?")
    .get("shop_1");

  if (!existingCatalog) {
    const defaultCatalog = {
      "pishori rice": { price: 240, unit: "kg" },
      "sindano rice": { price: 180, unit: "kg" },
      "cooking oil": { price: 320, unit: "litre" },
      sugar: { price: 210, unit: "kg" },
      beans: { price: 160, unit: "kg" },
      bread: { price: 65, unit: "loaf" },
      milk: { price: 70, unit: "packet" },
      eggs: { price: 15, unit: "egg" },
    };

    db.prepare(
      "INSERT INTO shop_catalogs (shop_id, products_json) VALUES (?, ?)",
    ).run("shop_1", JSON.stringify(defaultCatalog));

    console.log(
      `  ✅ Shop catalog created with ${Object.keys(defaultCatalog).length} products`,
    );
  } else {
    console.log("  ℹ️  Catalog already exists, skipping");
  }

  console.log();

  // ============================================================================
  // SEED INVENTORY (Legacy - optional)
  // ============================================================================

  console.log("📚 Seeding inventory...");

  const inventoryCount = db
    .prepare("SELECT COUNT(*) as count FROM inventory")
    .get();
  const itemCount = inventoryCount?.count || 0;

  if (itemCount === 0) {
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
      "INSERT OR IGNORE INTO inventory (product_name, brand, price, stock) VALUES (?, ?, ?, 1)",
    );

    for (const product of products) {
      stmt.run(product.product_name, product.brand, product.price);
    }

    console.log(`  ✅ Inventory seeded with ${products.length} products`);
  } else {
    console.log(
      `  ℹ️  Inventory already exists (${itemCount} items), skipping`,
    );
  }

  console.log();

  // ============================================================================
  // SUMMARY
  // ============================================================================

  const stats = {
    tenants: db.prepare("SELECT COUNT(*) as count FROM tenants").get().count,
    catalogs: db.prepare("SELECT COUNT(*) as count FROM shop_catalogs").get()
      .count,
    inventory: db.prepare("SELECT COUNT(*) as count FROM inventory").get()
      .count,
    conversations: db
      .prepare("SELECT COUNT(*) as count FROM conversations")
      .get().count,
  };

  console.log("📊 Database Summary:");
  console.log(`  • Tenants: ${stats.tenants}`);
  console.log(`  • Shop Catalogs: ${stats.catalogs}`);
  console.log(`  • Inventory Items: ${stats.inventory}`);
  console.log(`  • Conversations: ${stats.conversations}`);
  console.log();

  db.close();
  console.log("🎉 Database seeding complete!\n");
}

// Run seeding
seedDatabase().catch((err) => {
  console.error("❌ Failed to seed database:", err.message);
  process.exit(1);
});
