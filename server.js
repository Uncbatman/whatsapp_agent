const { GoogleGenAI } = require("@google/genai");
const { GoogleAuth } = require("google-auth-library");
require("dotenv").config();
const inventory = require("./inventory.js");
// 1. Properly initialize your array from the environment variables
const apiKeys = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
].filter(Boolean); // This automatically strips out any undefined or empty slots

// 🔍 Diagnostic Boot Log
console.log(
  `🔑 System verified: Loaded [${apiKeys.length}] active Gemini keys into rotation pool.`,
);

let currentKeyIndex = 0;

// 🔑 Google Sheets Direct Authentication Setup
const googleAuth = new GoogleAuth({
  keyFile: "./google-credentials.json", // Your credentials file path
  // ───► Full spreadsheets access
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

function calculateDeliveryFee(address) {
  if (!address || address === "Not Specified" || address === "Self-Pickup")
    return 0;

  const cleanAddress = address.toLowerCase();
  if (cleanAddress.includes("gichagi")) return 20;

  // Default fee for unconfigured estates/locations
  return 50;
}

async function processWhatsAppOrder(incomingMessage, phone) {
  let retries = apiKeys.length;

  while (retries > 0) {
    try {
      const currentKey = apiKeys[currentKeyIndex];
      const ai = new GoogleGenAI({ apiKey: currentKey });

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: incomingMessage,
        config: {
          responseMimeType: "application/json",
          systemInstruction: `You are an order manager for Karibu Fair Price.
          Available stock keys: ${Object.keys(inventory.products).join(", ")}.
          
          Your task:
          1. Evaluate what items the user is asking for.
          2. If an item matches or closely relates to an available stock key, put it in the "items" array.
          3. CRITICAL: If the customer asks for items that are NOT in the available stock list (e.g., salt, sunlight), add their original names to the "unavailable_items" array. Do not ignore them.
          4. Check the location context to set "order_status" ("processing", "pickup", or "needs_location").

          Extract data strictly into this structure:
          {
            "items": [
              { "name": "matched item name", "quantity": 1 }
            ],
            "unavailable_items": ["item name 1", "item name 2"],
            "extracted_address": "address text or leave empty",
            "order_status": "processing" | "pickup" | "needs_location"
          }`,
        },
      });

      const parsedOrder = JSON.parse(response.text);

      // 📦 1. Parse Available Items & Prices (Your existing calculation logic)
      let itemsTotalPrice = 0;
      let totalQty = 0;
      const parsedItems = parsedOrder.items || [];
      const itemStrings = parsedItems
        .map((item) => {
          const name = item.name ? item.name.toLowerCase() : "unknown";
          const qty = parseInt(item.quantity) || 1;
          const productInfo = inventory.products[name];
          if (productInfo) itemsTotalPrice += productInfo.price * qty;
          totalQty += qty;
          return `${qty}x ${name}`;
        })
        .join(", ");

      // 🛑 2. NEW: BUILD THE UNAVAILABLE ITEMS STRING IF THEY EXIST
      let unavailableNotice = "";
      const unavailableList = parsedOrder.unavailable_items || [];
      if (unavailableList.length > 0) {
        unavailableNotice = `⚠️ Note: We currently don't have [${unavailableList.join(", ")}] in stock today, so we left them out.\n\n`;
      }

      // 📦 1. GLOBAL SCOPE CONFIGURATION (Put this BEFORE your "if" routers)
      const spreadsheetId = "1vifZdUbTvNnpyJ4bJZKAtxcQnLErY9WjevAAIc691dc";
      const range = "Sheet1!A:I";
      const targetUrl = `https://sheets.googleapis.com/v1/spreadsheets/${spreadsheetId}/values/Sheet1!A:I:append?valueInputOption=USER_ENTERED`;

      // 🗺️ 3. DYNAMIC LOCATION ROUTER
      let replyMessage = "";
      let deliveryFee = 0;
      const address = parsedOrder.extracted_address || "Not Specified";

      if (parsedOrder.order_status === "needs_location") {
        replyMessage = `${unavailableNotice}I've got your order down for ${itemStrings || "the remaining items"} (Subtotal: Ksh ${itemsTotalPrice}). \n\nWould you like this delivered, or will you pick it up at the shop? If delivery, please reply with your specific location or estate name!`;
      } else if (parsedOrder.order_status === "pickup") {
        deliveryFee = 0;
        const totalAmount = itemsTotalPrice + deliveryFee;
        replyMessage = `${unavailableNotice}Awesome! We're packing your order (${itemStrings}) for collection. Total to pay at the shop is Ksh ${totalAmount}. See you soon!`;
      } else {
        deliveryFee = calculateDeliveryFee(address);
        const totalAmount = itemsTotalPrice + deliveryFee;
        replyMessage = `${unavailableNotice}Thank you for your order! Your available items come to Ksh ${itemsTotalPrice}, and delivery to ${address} is Ksh ${deliveryFee}, making your total Ksh ${totalAmount}. We are preparing your order for dispatch now!`;
      }

      // 🛡️ 3. ISOLATED GOOGLE SHEETS APPEND
      if (parsedOrder.order_status !== "needs_location") {
        try {
          const rowValues = [
            String(phone),
            new Date().toISOString(),
            String(itemStrings || "None"),
            String(totalQty),
            String(address),
            `Ksh ${itemsTotalPrice}`,
            `Ksh ${deliveryFee}`,
            `Ksh ${itemsTotalPrice + deliveryFee}`,
            "karibu_fair_price",
          ];

          const tokenHeaders = await googleAuth.getRequestHeaders();
          console.log("📊 Appending order data directly to Google Sheets...");

          // This will now find targetUrl perfectly!
          await axios.post(
            targetUrl,
            { majorDimension: "ROWS", values: [rowValues] },
            { headers: tokenHeaders },
          );
          console.log("✅ Row added successfully to Sheets!");
        } catch (sheetError) {
          console.error("❌ Google Sheets Logging Failed:", sheetError.message);
        }
      }

      // 3. 📱 SEND WHATSAPP MESSAGE
      await sendWhatsAppMessage(phone, replyMessage);
      return replyMessage;
    } catch (error) {
      console.error("⚠️ Error in engine step:", error.message);
      currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
      retries--;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("All keys exhausted.");
}

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

const DB_PATH = path.join(__dirname, "chatbot.db");
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 10;
const rateLimits = new Map();

function isValidPhoneNumber(phoneNumber) {
  return (
    typeof phoneNumber === "string" && /^\+?\d{7,15}$/.test(phoneNumber.trim())
  );
}

function verifyWhatsAppSignature(req) {
  const signature = req.get("x-hub-signature-256");
  const secret = process.env.WHATSAPP_APP_SECRET;

  if (!secret) {
    console.warn(
      "⚠️  WHATSAPP_APP_SECRET not set. Skipping signature verification.",
    );
    return true;
  }

  if (!signature || !req.rawBody) {
    return false;
  }

  const hash = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("hex");

  return signature === `sha256=${hash}`;
}

function enforceRateLimit(key) {
  const now = Date.now();
  const entry = rateLimits.get(key) || { count: 0, windowStart: now };

  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry.count = 1;
    entry.windowStart = now;
  } else {
    entry.count += 1;
  }

  rateLimits.set(key, entry);

  if (entry.count > MAX_REQUESTS_PER_WINDOW) {
    return `Too many requests from ${key}. Please wait a moment.`;
  }

  return null;
}

// ============================================================================
// DATABASE SETUP (async)
// ============================================================================

let db;

async function initDatabase() {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  // 1. Multi-Tenant Shop Registry Table
  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS tenants (
      shop_id TEXT PRIMARY KEY,
      whatsapp_phone_id TEXT,
      shop_name TEXT,
      catalog_file TEXT
    )
  `,
  ).run();

  // 2. Upgraded Customer Session & State Memory Table
  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS conversation_state (
      customer_phone TEXT PRIMARY KEY,
      shop_id TEXT,
      current_step TEXT,
      metadata_json TEXT, -- Holds temporary cart items securely as a JSON string
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `,
  ).run();

  // 3. Keep your core conversations log table intact
  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_phone TEXT,
      customer_message TEXT,
      bot_response TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `,
  ).run();

  // Insert a default profile for your pilot shop so the system has a running tenant
  const tenantExists = db
    .prepare("SELECT 1 FROM tenants WHERE shop_id = ?")
    .get("shop_1");
  if (!tenantExists) {
    db.prepare(
      `
      INSERT INTO tenants (shop_id, whatsapp_phone_id, shop_name, catalog_file)
      VALUES (?, ?, ?, ?)
    `,
    ).run(
      "shop_1",
      process.env.BUSINESS_PHONE || "default",
      "Karibu Fair Price",
      "fair_price_shop.txt",
    );
  }

  console.log(
    "✅ Multi-Tenant Database Architecture Initialized Successfully.",
  );

  // Add this temporarily right before the closing curly brace of initDatabase()
  try {
    db.prepare("DELETE FROM conversations").run();
    db.prepare("DELETE FROM conversation_state").run();
    console.log("🧹 Test database logs cleared out cleanly.");
  } catch (e) {
    console.error("Database clear warning:", e.message);
  }
}

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

/**
 * Extract product name from customer message
 * Handles: "do you have unga ugali", "show me rice", "what prices for sugar" etc
 */
async function extractProductName(message) {
  const lowerMessage = message.toLowerCase();

  try {
    const rows = db
      .prepare(`SELECT DISTINCT product_name FROM inventory`)
      .all();

    for (const { product_name } of rows) {
      const productLower = String(product_name).toLowerCase();
      if (productLower && lowerMessage.includes(productLower)) {
        return productLower;
      }
    }
  } catch (error) {
    console.warn(
      "⚠️  Failed to load product names from inventory",
      error.message,
    );
  }

  const fallbackProducts = [
    "unga ugali",
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

  for (const product of fallbackProducts) {
    if (lowerMessage.includes(product)) {
      return product;
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
     WHERE LOWER(product_name) LIKE '%' || LOWER(?) || '%'
       AND stock > 0
     ORDER BY price ASC`,
  );

  return stmt.all(productName);
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
    db.prepare(
      `INSERT INTO conversations (customer_phone, customer_message, bot_response)
       VALUES (?, ?, ?)`,
    ).run(phoneNumber, customerMessage, botResponse);

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
  // 1. Instantly acknowledge Meta's message to prevent retry storms
  res.sendStatus(200);

  let phoneNumber = "";
  let customerMessage = "";

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const messageObject = changes?.value?.messages?.[0];

    if (!messageObject || !messageObject.text?.body) return;

    phoneNumber = messageObject.from;
    customerMessage = messageObject.text.body.trim();

    console.log(`\n📨 Live Message from ${phoneNumber}: "${customerMessage}"`);

    // Memory Context Pulling
    let chatHistoryContext = "";
    try {
      const historyRows = db
        .prepare(
          `
        SELECT customer_message, bot_response 
        FROM conversations 
        WHERE customer_phone = ? 
        ORDER BY timestamp DESC 
        LIMIT 4
      `,
        )
        .all(phoneNumber);

      if (historyRows && historyRows.length > 0) {
        chatHistoryContext = "RECENT CONVERSATION HISTORY:\n";
        historyRows.reverse().forEach((row) => {
          chatHistoryContext += `Customer: ${row.customer_message}\nAssistant: ${row.bot_response}\n`;
        });
        chatHistoryContext += "\n";
        console.log(
          `📜 Loaded ${historyRows.length} recent messages for memory context.`,
        );
      }
    } catch (dbError) {
      console.error("⚠️ Error pulling chat history:", dbError.message);
    }

    // Load Multi-tenant shop catalog
    const catalogPath = path.resolve(__dirname, "catalogs", "shop_1.txt");
    let shopRules = "You are a polite shop assistant for Karibu Fair Price.";
    if (fs.existsSync(catalogPath)) {
      shopRules = fs.readFileSync(catalogPath, "utf8");
      console.log("📑 Loaded shop_1.txt catalog.");
    }

    // 2. Querying Gemini with automatic API key rotation on 429 (quota) errors
    console.log(`🧠 Querying Production Gemini Endpoint...`);

    const fullSystemPrompt = `INSTRUCTIONS:\n${shopRules}\n\n${chatHistoryContext}NEW CUSTOMER MESSAGE: "${customerMessage}"`;

    const result = await processWhatsAppOrder(fullSystemPrompt, phoneNumber);

    console.log(`🤖 Gemini responded beautifully!`);

    // Save conversation
    if (typeof saveConversation === "function") {
      saveConversation(phoneNumber, customerMessage, result);
    }
  } catch (error) {
    console.error("⚠️ Primary AI Engine Route Failed.");
    if (error.response?.data) {
      console.error(
        "🔴 Raw Error from Google Server:",
        JSON.stringify(error.response.data, null, 2),
      );
    } else {
      console.error("🔴 Connection Message:", error.message);
    }

    console.log("🔄 Launching contextual local backup keyword matcher...");

    if (!customerMessage || !phoneNumber) return;

    let fallbackResponse = "";
    const lowerMsg = customerMessage.toLowerCase();
    let activeProduct = "";

    if (
      lowerMsg.includes("rice") ||
      lowerMsg.includes("mchele") ||
      lowerMsg.includes("pishori")
    )
      activeProduct = "rice";
    else if (lowerMsg.includes("sugar") || lowerMsg.includes("sukari"))
      activeProduct = "sugar";
    else if (lowerMsg.includes("oil") || lowerMsg.includes("mafuta"))
      activeProduct = "oil";

    if (!activeProduct) {
      try {
        const lastRow = db
          .prepare(
            "SELECT customer_message, bot_response FROM conversations WHERE customer_phone = ? ORDER BY timestamp DESC LIMIT 1",
          )
          .get(phoneNumber);
        if (lastRow) {
          const combined = (
            lastRow.customer_message +
            " " +
            lastRow.bot_response
          ).toLowerCase();
          if (combined.includes("rice") || combined.includes("pishori"))
            activeProduct = "rice";
          else if (combined.includes("sugar") || combined.includes("sukari"))
            activeProduct = "sugar";
          else if (combined.includes("oil") || combined.includes("mafuta"))
            activeProduct = "oil";
        }
      } catch (dbe) {}
    }

    if (activeProduct === "rice") {
      fallbackResponse =
        "🌾 *Karibu Fair Price Rice*:\n• Pishori 1kg: KES 240 | 1/2kg: KES 120\n• Sindano 1kg: KES 180\nReply with your exact quantity and estate street name to complete your order!";
    } else if (activeProduct === "sugar") {
      fallbackResponse =
        "🍬 *Kabras Sugar Prices*:\n• 1kg: KES 210 | 2kg: KES 410\nReply with your exact quantity and estate street name to log your order!";
    } else if (activeProduct === "oil") {
      fallbackResponse =
        "🛢️ *Cooking Oil Prices*:\n• Fresh Fri 1L: KES 320 | 2L: KES 620\nReply with your street name to order!";
    } else {
      fallbackResponse =
        "👋 Karibu Fair Price! We sell fresh Rice, Sugar, Cooking Oil, and Beans. What can I help you find today?";
    }

    try {
      if (typeof saveConversation === "function")
        saveConversation(phoneNumber, customerMessage, fallbackResponse);
      await sendWhatsAppMessage(phoneNumber, fallbackResponse);
      console.log(
        `✅ Handled customer via fallback context [Context: ${activeProduct || "None"}]`,
      );
    } catch (sendError) {
      console.error(
        "❌ Deep System Error sending fallback:",
        sendError.message,
      );
    }
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
    const conversations = db
      .prepare(
        `SELECT customer_phone, customer_message, bot_response, timestamp
         FROM conversations
         ORDER BY timestamp DESC
         LIMIT 100`,
      )
      .all();

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

    const conversations = db
      .prepare(
        `SELECT customer_message, bot_response, timestamp
         FROM conversations
         WHERE customer_phone = ?
         ORDER BY timestamp DESC`,
      )
      .all(phone);

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
    const inventory = db
      .prepare(
        `SELECT product_name, brand, price, stock
         FROM inventory
         ORDER BY product_name, price ASC`,
      )
      .all();

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
    const msgResult = db
      .prepare("SELECT COUNT(*) as count FROM conversations")
      .get();
    const custResult = db
      .prepare(
        "SELECT COUNT(DISTINCT customer_phone) as count FROM conversations",
      )
      .get();
    const prodResult = db
      .prepare("SELECT COUNT(*) as count FROM inventory")
      .get();

    const totalMessages = msgResult?.count || 0;
    const totalCustomers = custResult?.count || 0;
    const totalProducts = prodResult?.count || 0;

    res.json({
      totalMessages,
      totalCustomers,
      totalProducts,
      databaseSize: "better-sqlite3 with WAL",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/admin/add-product", (req, res) => {
  try {
    const product_name = String(req.body.product_name || "").trim();
    const brand = String(req.body.brand || "").trim();
    const price = Number(req.body.price);

    if (!product_name || !brand || Number.isNaN(price) || price <= 0) {
      return res.status(400).json({
        error:
          "Invalid product data. Provide product_name, brand, and a positive numeric price.",
      });
    }

    db.prepare(
      `INSERT INTO inventory (product_name, brand, price, stock)
       VALUES (?, ?, ?, 1)`,
    ).run(product_name, brand, price);

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
      const stats = db
        .prepare("SELECT COUNT(*) as count FROM conversations")
        .get();
      const count = stats?.count || 0;
      console.log(`📊 Final stats: ${count} conversations saved`);
      db.close();
      server.close(() => process.exit(0));
    });

    module.exports = app;
  })
  .catch((err) => {
    console.error("❌ Failed to initialize database:", err);
    process.exit(1);
  });
