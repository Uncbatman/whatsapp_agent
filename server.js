const express = require("express");
const axios = require("axios");
const initSqlJs = require("sql.js");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json());

const DB_PATH = path.join(__dirname, "chatbot.db");

// ============================================================================
// DATABASE SETUP (async)
// ============================================================================

let db;

async function initDatabase() {
  const SQL = await initSqlJs();

  // Load existing database file if it exists
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
    console.log("📁 Database loaded from: chatbot.db");
  } else {
    db = new SQL.Database();
    console.log("📁 Database created: chatbot.db");
  }

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

  saveDatabase();
  console.log("✅ Tables and indexes created");
}

/**
 * Save database state to disk
 */
function saveDatabase() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// ============================================================================
// SEED INVENTORY (Run once)
// ============================================================================

function seedInventory() {
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
    saveDatabase();

    console.log("✅ Inventory seeded with 9 products");
  } else {
    console.log(`✅ Inventory already exists (${rowCount} items)`);
  }
}

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

/**
 * Extract product name from customer message
 * Handles: "do you have unga ugali", "show me rice", "what prices for sugar" etc
 */
function extractProductName(message) {
  const productNames = [
    " unga ugali",
    "ugali",
    "unga",
    "rice",
    "sugar",
    "oil",
    "cooking oil",
    "flour",
    "salad",
    "mafuta ya kupika",
    "mafuta",
  ];

  const lowerMessage = message.toLowerCase();

  for (const product of productNames) {
    if (lowerMessage.includes(product)) {
      return product.toLowerCase();
    }
  }

  return null;
}

/**
 * Search inventory for a product
 */
function searchInventory(productName) {
  if (!productName) return [];

  const stmt = db.prepare(
    `SELECT product_name, brand, price, stock
     FROM inventory
     WHERE LOWER(product_name) = LOWER(?)
     ORDER BY price ASC`,
  );

  stmt.bind([productName]);
  const results = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    results.push(row);
  }
  stmt.free();

  return results;
}

/**
 * Format inventory results as WhatsApp message
 */
function formatInventoryResponse(results, productName) {
  if (results.length === 0) {
    return `Sorry, we don't have *${productName}* in stock right now.\n\nWe have: Rice, Sugar, Cooking Oil, and Ugali.\n\nWhat else can I help you with? 😊`;
  }

  let response = `📦 *${results[0].product_name.toUpperCase()}* - Available brands:\n\n`;

  results.forEach((item, index) => {
    response += `${index + 1}. *${item.brand}* - KES ${item.price}\n`;
  });

  response += `\nWhich brand would you like? Reply with the brand name! 🛒`;

  return response;
}

/**
 * Save conversation to database
 */
function saveConversation(phoneNumber, customerMessage, botResponse) {
  try {
    db.run(
      `INSERT INTO conversations (customer_phone, customer_message, bot_response)
       VALUES (?, ?, ?)`,
      [phoneNumber, customerMessage, botResponse],
    );
    saveDatabase();

    console.log(
      `💬 Saved | ${phoneNumber}: "${customerMessage.substring(0, 40)}..."`,
    );
  } catch (error) {
    console.error("❌ Failed to save conversation:", error.message);
  }
}

/**
 * Send message via WhatsApp Cloud API
 */
async function sendWhatsAppMessage(phoneNumber, messageText) {
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
  const BUSINESS_PHONE = process.env.BUSINESS_PHONE;

  if (!WHATSAPP_TOKEN || !BUSINESS_PHONE) {
    console.log("⚠️  WhatsApp credentials not configured. Message NOT sent.");
    console.log(`Would send to ${phoneNumber}: "${messageText}"`);
    return;
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${BUSINESS_PHONE}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: phoneNumber,
        type: "text",
        text: { body: messageText },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );

    console.log(`✅ Message sent to ${phoneNumber}`);
    return response.data;
  } catch (error) {
    const errorMsg = error.response?.data?.error?.message || error.message;
    console.error(`❌ Failed to send WhatsApp message: ${errorMsg}`);

    if (error.response?.data) {
      console.error("Response data:", error.response.data);
    }
  }
}

// ============================================================================
// WEBHOOK: Main Message Handler
// ============================================================================

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const phoneNumber =
      req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;

    if (!message || !phoneNumber || !message.text) {
      console.log("⚠️  Invalid message format");
      return res.status(200).send("OK");
    }

    const customerMessage = message.text.body.trim();

    console.log(`\n📨 Message from ${phoneNumber}: "${customerMessage}"`);

    const productName = extractProductName(customerMessage);

    let botResponse;

    if (!productName) {
      botResponse = `👋 *Karibu Fair Price!*\nWhat are you buying? 🛒`;
    } else {
      const results = searchInventory(productName);
      botResponse = formatInventoryResponse(results, productName);
    }

    saveConversation(phoneNumber, customerMessage, botResponse);

    await sendWhatsAppMessage(phoneNumber, botResponse);

    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Error in webhook:", error.message);
    res.status(500).send("Error");
  }
});

// ============================================================================
// WEBHOOK VERIFICATION (WhatsApp requirement)
// ============================================================================

app.get("/webhook", (req, res) => {
  const verifyToken = process.env.VERIFY_TOKEN;
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (!verifyToken) {
    console.error("❌ VERIFY_TOKEN not set in .env");
    return res.status(403).send("Forbidden");
  }

  if (token === verifyToken) {
    console.log("✅ Webhook verified by WhatsApp");
    res.status(200).send(challenge);
  } else {
    console.log("❌ Webhook verification failed - token mismatch");
    res.status(403).send("Forbidden");
  }
});

// ============================================================================
// ADMIN ENDPOINTS (View data)
// ============================================================================

app.get("/admin/conversations", (req, res) => {
  try {
    const stmt = db.prepare(
      `SELECT customer_phone, customer_message, bot_response, timestamp
       FROM conversations
       ORDER BY timestamp DESC
       LIMIT 100`,
    );

    const conversations = [];
    while (stmt.step()) {
      conversations.push(stmt.getAsObject());
    }
    stmt.free();

    res.json({
      total: conversations.length,
      conversations: conversations,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/admin/conversations/:phone", (req, res) => {
  try {
    const phone = req.params.phone;

    const stmt = db.prepare(
      `SELECT customer_message, bot_response, timestamp
       FROM conversations
       WHERE customer_phone = ?
       ORDER BY timestamp DESC`,
    );

    stmt.bind([phone]);
    const conversations = [];
    while (stmt.step()) {
      conversations.push(stmt.getAsObject());
    }
    stmt.free();

    res.json({
      phone: phone,
      total: conversations.length,
      conversations: conversations,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/admin/inventory", (req, res) => {
  try {
    const stmt = db.prepare(
      `SELECT product_name, brand, price, stock
       FROM inventory
       ORDER BY product_name, price ASC`,
    );

    const inventory = [];
    while (stmt.step()) {
      inventory.push(stmt.getAsObject());
    }
    stmt.free();

    res.json({
      total: inventory.length,
      inventory: inventory,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/admin/stats", (req, res) => {
  try {
    const msgResult = db.exec("SELECT COUNT(*) as count FROM conversations");
    const custResult = db.exec(
      "SELECT COUNT(DISTINCT customer_phone) as count FROM conversations",
    );
    const prodResult = db.exec("SELECT COUNT(*) as count FROM inventory");

    const totalMessages = msgResult.length > 0 ? msgResult[0].values[0][0] : 0;
    const totalCustomers =
      custResult.length > 0 ? custResult[0].values[0][0] : 0;
    const totalProducts =
      prodResult.length > 0 ? prodResult[0].values[0][0] : 0;

    res.json({
      totalMessages,
      totalCustomers,
      totalProducts,
      databaseSize: "SQLite",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/admin/add-product", (req, res) => {
  try {
    const { product_name, brand, price } = req.body;

    if (!product_name || !brand || !price) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    db.run(
      `INSERT INTO inventory (product_name, brand, price, stock)
       VALUES (?, ?, ?, 1)`,
      [product_name, brand, price],
    );
    saveDatabase();

    res.json({
      success: true,
      message: `${brand} ${product_name} added at KES ${price}`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// ============================================================================
// START SERVER (async init first)
// ============================================================================

const PORT = Number.isInteger(parseInt(process.env.PORT, 10))
  ? parseInt(process.env.PORT, 10)
  : 3000;

initDatabase()
  .then(() => {
    seedInventory();

    const server = app.listen(PORT);

    server.on("listening", () => {
      console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║   🤖 FMCG WhatsApp Chatbot Running                         ║
╚═══════════════════════════════════════════════════════════════════════════╝

🌐 Server: http://localhost:${PORT}
📱 Webhook (POST): /webhook
🔐 Webhook (GET): /webhook (verification)
❤️  Health: /health

📊 ADMIN ENDPOINTS:
   GET  /admin/conversations           → All conversations
   GET  /admin/conversations/:phone    → Customer history
   GET  /admin/inventory              → All products
   GET  /admin/stats                  → Bot statistics
   POST /admin/add-product            → Add new product

⚙️  Environment:
   WHATSAPP_TOKEN: ${process.env.WHATSAPP_TOKEN ? "✅ Set" : "❌ Not set"}
   BUSINESS_PHONE: ${process.env.BUSINESS_PHONE ? "✅ Set" : "❌ Not set"}
   VERIFY_TOKEN: ${process.env.VERIFY_TOKEN ? "✅ Set" : "❌ Not set"}
      `);
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `❌ Port ${PORT} is already in use. Set PORT to a free port or stop the process using it.`,
        );
      } else {
        console.error("❌ Server error:", err);
      }
      process.exit(1);
    });

    process.on("SIGINT", () => {
      console.log("\n👋 Shutting down gracefully...");
      const stats = db.exec("SELECT COUNT(*) as count FROM conversations");
      const count = stats.length > 0 ? stats[0].values[0][0] : 0;
      console.log(`📊 Final stats: ${count} conversations saved`);
      saveDatabase();
      db.close();
      server.close(() => process.exit(0));
    });

    module.exports = app;
  })
  .catch((err) => {
    console.error("❌ Failed to initialize database:", err);
    process.exit(1);
  });
