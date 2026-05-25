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
          systemInstruction: `${FMCG_SYSTEM_PROMPT}\n\nAvailable stock keys: ${Object.keys(inventory.products).join(", ")}.\n\nAdditionally, if a customer asks for items NOT in available stock (e.g., salt, sunlight), add their original names to an "unavailable_items" array. Check location context and set "order_status" ("processing", "pickup", or "needs_location"). Extract "extracted_address" if present. Use this extended structure:\n{\n  "items": [{ "name": "matched item name", "quantity": 1 }],\n  "unavailable_items": ["item name 1"],\n  "extracted_address": "address text",\n  "order_status": "processing" | "pickup" | "needs_location"\n}`,
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
      const spreadsheetId = "1Q9Q-OWZc0aZa-BqVlNyg5aPutitoYs1suKabicQAw-k";
      const range = "Sheet1!A:I";
      const targetUrl = `https://sheets.googleapis.com/v1/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`;

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
            {
              range: range,
              majorDimension: "ROWS",
              values: [rowValues],
            },
            {
              headers: {
                ...tokenHeaders,
                "Content-Type": "application/json",
              },
            },
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
// STATEFUL ORDER MANAGEMENT HELPERS
// ============================================================================

/**
 * Calculate total price for a list of order items
 * @param {Array} items - Array of {name, quantity} objects
 * @returns {number} Total subtotal in Ksh
 */
function calculateItemsPrice(items) {
  let total = 0;
  for (const item of items) {
    const name = item.name ? item.name.toLowerCase() : "unknown";
    const qty = parseInt(item.quantity) || 1;
    const productInfo = inventory.products[name];
    if (productInfo) {
      total += productInfo.price * qty;
    }
  }
  return total;
}

/**
 * Parse a customer's order message using Gemini AI
 * Returns structured order data (items, unavailable items, address, status)
 * @param {string} incomingMessage - Raw customer message text
 * @returns {Promise<Object>} Parsed order JSON object
 */
async function queryGeminiEndpoint(incomingMessage) {
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
          systemInstruction: `${FMCG_SYSTEM_PROMPT}\n\nAvailable stock keys: ${Object.keys(inventory.products).join(", ")}.\n\nAdditionally, if a customer asks for items NOT in available stock (e.g., salt, sunlight), add their original names to an "unavailable_items" array. Check location context and set "order_status" ("processing", "pickup", or "needs_location"). Extract "extracted_address" if present. Use this extended structure:\n{\n  "items": [{ "name": "matched item name", "quantity": 1 }],\n  "unavailable_items": ["item name 1"],\n  "extracted_address": "address text",\n  "order_status": "processing" | "pickup" | "needs_location"\n}`,
        },
      });

      const parsedOrder = JSON.parse(response.text);
      return parsedOrder;
    } catch (error) {
      console.error("⚠️ Gemini parsing error:", error.message);
      currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
      retries--;
      if (retries > 0)
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("All Gemini keys exhausted for order parsing.");
}

/**
 * Append order data to the tenant's Google Sheet
 * @param {string} spreadsheetId - The tenant's specific spreadsheet ID
 * @param {Object} orderData - { date, store, customer, total, mpesa }
 */
async function appendOrderToGoogleSheets(spreadsheetId, orderData) {
  try {
    const range = "Sheet1!A:E";
    const targetUrl = `https://sheets.googleapis.com/v1/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`;

    const tokenHeaders = await googleAuth.getRequestHeaders();

    await axios.post(
      targetUrl,
      {
        range: range,
        majorDimension: "ROWS",
        values: [
          [
            orderData.date,
            orderData.store,
            orderData.customer,
            `Ksh ${orderData.total}`,
            orderData.mpesa,
          ],
        ],
      },
      {
        headers: {
          ...tokenHeaders,
          "Content-Type": "application/json",
        },
      },
    );
    console.log(`✅ Order logged to sheet [${orderData.store}]`);
  } catch (sheetError) {
    console.error("❌ Google Sheets append failed:", sheetError.message);
  }
}

// 📱 1. STAKEHOLDER REGISTRY
const shopTenants = {
  karibu_fair_price: {
    name: "Karibu Fair Price",
    tillNumber: "5544321",
    ownerPhone: "254792305846",
    riderPhone: "254792120237",
    // 📊 Share this specific sheet link ONLY with the Karibu owner
    spreadsheetId: "1pX_KaribuFairPriceSpreadsheetIdHere",
  },
  mama_mboga_shop: {
    name: "Mama Mboga",
    tillNumber: "6677889",
    ownerPhone: "254700000000",
    riderPhone: "254792120237",
    // 📊 Share this specific sheet link ONLY with Mama Mboga
    spreadsheetId: "1zY_MamaMbogaSpreadsheetIdHere",
  },
};

// 🌍 GLOBAL TRANSLATION & PARSING DICTIONARY
const FMCG_SYSTEM_PROMPT = `
You are an expert FMCG inventory parsing agent for Kenyan retail kiosks. 
Your job is to read unstructured customer text messages and extract items into a clean JSON array.

CRITICAL: Customers will frequently mix English, Swahili, and Sheng. You must interpret and map local terms to their standard product groups:
- "Unga", "Unga ya ugali", "Jogoo", "Maize flour" -> Maize Flour
- "Unga ya ngano", "Exe", "Wheat flour" -> Wheat Flour
- "Maziwa", "Packet maziwa", "Milk" -> Milk
- "Mkate", "Bread" -> Bread
- "Mayai", "Eggs" -> Eggs
- "Sukari", "Sugar" -> Sugar

Return ONLY a valid JSON array matching this exact structure:
{
  "items": [
    { "name": "Maize Flour", "quantity": 1 },
    { "name": "Milk", "quantity": 1 }
  ]
}
`;

// 🧠 In-memory tracking for active customer checkout sessions
const activeOrders = {};
let orderIdCounter = 1; // Simple counter for shortcodes

// ============================================================================
// WEBHOOK: Main Message Handler (State Machine)
// ============================================================================

app.post("/webhook", async (req, res) => {
  // 🔍 THE DIAGNOSTIC SPY: Log raw payload before any processing
  console.log("📥 RAW INCOMING PAYLOAD:", JSON.stringify(req.body, null, 2));

  const messageData = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const incomingMessage = (messageData?.text?.body || "").trim();
  const senderPhone = messageData?.from;

  if (!incomingMessage || !senderPhone) return res.sendStatus(200);

  const tenantKey = "karibu_fair_price";
  const tenant = shopTenants[tenantKey];
  const upperMsg = incomingMessage.toUpperCase();

  // ────────────────────────────────────────────────────────
  // ACTION A: THE SHOP OWNER APPROVAL GATEWAY (Short-Code Version)
  // ────────────────────────────────────────────────────────
  if (
    senderPhone === tenant.ownerPhone &&
    (upperMsg.startsWith("ACCEPT") || upperMsg.startsWith("REJECT"))
  ) {
    const parts = incomingMessage.split(" ");
    const action = parts[0].toUpperCase();
    const targetShortCode = parts[1]; // This will be "1", "2", "3", etc.

    if (!targetShortCode) {
      await sendWhatsAppMessage(
        tenant.ownerPhone,
        "⚠️ Please specify the order number. Example: *ACCEPT 1*",
      );
      return res.sendStatus(200);
    }

    // Find the customer phone number linked to that specific short-code ID
    let customerPhone = null;
    for (const [phone, order] of Object.entries(activeOrders)) {
      if (
        order.shortCode === targetShortCode &&
        order.status === "PENDING_OWNER_APPROVAL"
      ) {
        customerPhone = phone;
        break;
      }
    }

    const order = activeOrders[customerPhone];

    if (!order) {
      await sendWhatsAppMessage(
        tenant.ownerPhone,
        `❌ Error: Order #${targetShortCode} not found or already processed.`,
      );
      return res.sendStatus(200);
    }

    if (action === "ACCEPT") {
      order.status = "AWAITING_CUSTOMER_FINALIZATION";

      const promptMessage =
        `Your order is approved! Please pay Ksh ${order.subtotal} to Till *${tenant.tillNumber}*.\n` +
        `Reply *PICKUP [MpesaCode]* or *DELIVERY [Location] [MpesaCode]* to finalize.`;

      await sendWhatsAppMessage(customerPhone, promptMessage);
      await sendWhatsAppMessage(
        tenant.ownerPhone,
        `✅ Approved order #${targetShortCode}. Prompt sent to customer.`,
      );
    } else {
      delete activeOrders[customerPhone];
      await sendWhatsAppMessage(
        customerPhone,
        "😔 We are sorry, the shop is currently unable to fulfill your order. It has been cancelled.",
      );
      await sendWhatsAppMessage(
        tenant.ownerPhone,
        `❌ Order #${targetShortCode} has been rejected.`,
      );
    }
    return res.sendStatus(200);
  }

  // ────────────────────────────────────────────────────────
  // ACTION B: THE CUSTOMER CHECKOUT LOOP
  // ────────────────────────────────────────────────────────
  const currentOrder = activeOrders[senderPhone];

  if (
    currentOrder &&
    currentOrder.status === "AWAITING_CUSTOMER_FINALIZATION"
  ) {
    if (upperMsg.startsWith("PICKUP")) {
      const mpesaCode = incomingMessage
        .replace(/PICKUP/i, "")
        .trim()
        .toUpperCase();
      await sendWhatsAppMessage(
        senderPhone,
        `🛍️ Payment received! Your order is being packed for pickup.`,
      );
      await sendWhatsAppMessage(
        tenant.ownerPhone,
        `📦 *READY FOR PICKUP*\nCustomer: ${senderPhone}\nCode: ${mpesaCode}`,
      );
      delete activeOrders[senderPhone];
    } else if (upperMsg.startsWith("DELIVERY")) {
      const rawDetails = incomingMessage.replace(/DELIVERY/i, "").trim();
      const detailsArray = rawDetails.split(" ");
      const mpesaCode = detailsArray.pop().toUpperCase();
      const location = detailsArray.join(" ") || "Specified Address";

      // 💵 Flat delivery fee update
      const deliveryFee = 20;
      const totalToPay = currentOrder.subtotal + deliveryFee;

      // 🏍️ Sentence 1: Confirmed amount | Sentence 2: Arriving shortly reassurance
      const customerReceipt = `🏍️ Confirmed! Total paid: Ksh ${totalToPay} (incl. Ksh 20 delivery). Our rider is arriving shortly at ${location}!`;
      await sendWhatsAppMessage(senderPhone, customerReceipt);

      // Keep the rider ticket structured so they have everything they need on the road
      const riderTicket = `🏍️ *DISPATCH TICKET*\n🏪 Store: ${tenant.name}\n📦 Items: ${currentOrder.items}\n📍 Dropoff: ${location}\n📱 Tel: ${senderPhone}\n🔑 M-Pesa: ${mpesaCode}`;
      await sendWhatsAppMessage(tenant.riderPhone, riderTicket);

      // 📊 Log to the tenant's Google Sheet
      await appendOrderToGoogleSheets(tenant.spreadsheetId, {
        date: new Date().toLocaleDateString("en-KE", {
          timeZone: "Africa/Nairobi",
        }),
        store: tenant.name,
        customer: senderPhone,
        total: totalToPay,
        mpesa: mpesaCode,
      });

      // Free up memory space for the next round of customers
      delete activeOrders[senderPhone];
    }
    return res.sendStatus(200);
  }

  // ────────────────────────────────────────────────────────
  // ACTION C: PRIMARY INITIAL CUSTOMER INBOUND ORDER
  // ────────────────────────────────────────────────────────
  try {
    const parsedOrder = await queryGeminiEndpoint(incomingMessage);
    const subtotal = calculateItemsPrice(parsedOrder.items);
    const formattedItemString = parsedOrder.items
      .map((i) => `${i.quantity}x ${i.name}`)
      .join(", ");

    // Assign a unique short-code number to this temporary memory block
    const assignedId = orderIdCounter.toString();
    orderIdCounter++; // Increment for the next customer

    activeOrders[senderPhone] = {
      shortCode: assignedId,
      status: "PENDING_OWNER_APPROVAL",
      items: formattedItemString,
      subtotal: subtotal,
    };

    // 🔔 Send the owner the alert featuring the tiny ID code
    const ownerAlert =
      `🔔 *NEW ORDER #${assignedId} RECEIVED*\n` +
      `👤 Customer: ${senderPhone}\n` +
      `📦 Items: ${formattedItemString}\n` +
      `💵 Est. Subtotal: Ksh ${subtotal}\n\n` +
      `👉 Reply *ACCEPT ${assignedId}* to approve.\n` +
      `👉 Reply *REJECT ${assignedId}* to decline.`;

    await sendWhatsAppMessage(tenant.ownerPhone, ownerAlert);
    await sendWhatsAppMessage(
      senderPhone,
      "⏳ Thank you! We are checking shelf availability with the shop manager right now. We'll text you the moment it's confirmed.",
    );
  } catch (geminiError) {
    console.error("❌ Order parsing failed:", geminiError.message);
    await sendWhatsAppMessage(
      senderPhone,
      "Sorry, I had trouble reading your order text. Please list the items clearly!",
    );
  }

  return res.sendStatus(200);
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Multi-Tenant Server running on port ${PORT}`);
});
