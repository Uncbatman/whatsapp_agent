const { GoogleGenAI } = require("@google/genai");
const { google } = require("googleapis");
require("dotenv").config();
const inventory = require("./inventory.js");
const fs = require("fs");
const express = require("express");
const axios = require("axios");
const Database = require("better-sqlite3");
const path = require("path");

// ============================================================================
// GEMINI API KEY ROTATION
// ============================================================================

const apiKeys = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
].filter(Boolean);

console.log(
  `🔑 System verified: Loaded [${apiKeys.length}] active Gemini keys into rotation pool.`,
);

let currentKeyIndex = 0;

// ============================================================================
// EXPRESS & MODULE-LEVEL STATE
// ============================================================================

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

// Global order counter for customer-friendly shortcodes
let orderIdCounter = 1;

function isValidPhoneNumber(phoneNumber) {
  return (
    typeof phoneNumber === "string" && /^\+?\d{7,15}$/.test(phoneNumber.trim())
  );
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
// DATABASE SETUP
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
      whatsapp_phone_id TEXT UNIQUE,
      shop_name TEXT,
      catalog_file TEXT,
      till_number TEXT,
      owner_phone TEXT,
      rider_phone TEXT,
      spreadsheet_id TEXT
    )
  `,
  ).run();

  // 2. Shop Catalogs — per-shop product inventory
  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS shop_catalogs (
      shop_id TEXT PRIMARY KEY,
      products_json TEXT,
      FOREIGN KEY (shop_id) REFERENCES tenants(shop_id)
    )
  `,
  ).run();

  // 3. Customer Session & State Memory Table
  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS conversation_state (
      customer_phone TEXT PRIMARY KEY,
      shop_id TEXT,
      current_step TEXT,
      metadata_json TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `,
  ).run();

  // 4. Core conversations log table
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

  // Seed default tenant with all operational fields
  const tenantExists = db
    .prepare("SELECT 1 FROM tenants WHERE shop_id = ?")
    .get("shop_1");
  if (!tenantExists) {
    db.prepare(
      `
      INSERT INTO tenants (shop_id, whatsapp_phone_id, shop_name, catalog_file, till_number, owner_phone, rider_phone, spreadsheet_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "shop_1",
      process.env.BUSINESS_PHONE || "default",
      "Karibu Fair Price",
      "fair_price_shop.txt",
      process.env.TILL_NUMBER || "5544321",
      process.env.OWNER_PHONE || "254792305846",
      process.env.RIDER_PHONE || "254792120237",
      process.env.SPREADSHEET_ID ||
        "1Q9Q-OWZc0aZa-BqVlNyg5aPutitoYs1suKabicQAw-k",
    );
  }

  // Seed default shop catalog
  const catalogExists = db
    .prepare("SELECT 1 FROM shop_catalogs WHERE shop_id = ?")
    .get("shop_1");
  if (!catalogExists) {
    const defaultProducts = {
      "pishori rice": { price: 240, unit: "kg" },
      "sindano rice": { price: 180, unit: "kg" },
      "cooking oil": { price: 320, unit: "litre" },
      sugar: { price: 210, unit: "kg" },
      beans: { price: 160, unit: "kg" },
    };
    db.prepare(
      "INSERT INTO shop_catalogs (shop_id, products_json) VALUES (?, ?)",
    ).run("shop_1", JSON.stringify(defaultProducts));
  }

  // Restore orderIdCounter from existing orders so IDs don't collide after restart
  try {
    const allStates = db
      .prepare("SELECT metadata_json FROM conversation_state")
      .all();
    for (const row of allStates) {
      const meta = JSON.parse(row.metadata_json || "{}");
      if (meta.shortCode) {
        const num = parseInt(meta.shortCode);
        if (!isNaN(num) && num >= orderIdCounter) {
          orderIdCounter = num + 1;
        }
      }
    }
  } catch (e) {
    /* ignore */
  }

  console.log(
    "✅ Multi-Tenant Database Architecture Initialized Successfully.",
  );

  try {
    db.prepare("DELETE FROM conversations").run();
    db.prepare("DELETE FROM conversation_state").run();
    console.log("🧹 Test database logs cleared out cleanly.");
  } catch (e) {
    console.error("Database clear warning:", e.message);
  }
}

// ============================================================================
// TENANT & CATALOG HELPERS
// ============================================================================

function getTenantByPhoneId(phoneNumberId) {
  try {
    return db
      .prepare("SELECT * FROM tenants WHERE whatsapp_phone_id = ?")
      .get(phoneNumberId);
  } catch (error) {
    console.error(
      `❌ Tenant lookup error for phone ID ${phoneNumberId}:`,
      error.message,
    );
    return null;
  }
}

function getShopCatalog(shopId) {
  try {
    const catalog = db
      .prepare("SELECT products_json FROM shop_catalogs WHERE shop_id = ?")
      .get(shopId);
    return catalog ? JSON.parse(catalog.products_json) : {};
  } catch (error) {
    console.error(`❌ Failed to load catalog for ${shopId}:`, error.message);
    return {};
  }
}

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

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

function getCustomerState(customerPhone) {
  try {
    const row = db
      .prepare(
        "SELECT current_step, metadata_json FROM conversation_state WHERE customer_phone = ?",
      )
      .get(customerPhone);

    if (!row) return null;

    return {
      status: row.current_step,
      ...JSON.parse(row.metadata_json || "{}"),
    };
  } catch (error) {
    console.error(
      `❌ Database read error for ${customerPhone}:`,
      error.message,
    );
    return null;
  }
}

function saveCustomerState(customerPhone, shopId, status, metadata = {}) {
  try {
    const metadataStr = JSON.stringify(metadata);
    const result = db
      .prepare(
        `
      INSERT INTO conversation_state (customer_phone, shop_id, current_step, metadata_json, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(customer_phone) DO UPDATE SET
        shop_id = excluded.shop_id,
        current_step = excluded.current_step,
        metadata_json = excluded.metadata_json,
        updated_at = CURRENT_TIMESTAMP
    `,
      )
      .run(customerPhone, shopId, status, metadataStr);

    if (result.changes === 0) {
      throw new Error("Upsert failed - no rows affected");
    }

    console.log(`💾 State persisted | ${customerPhone} -> [${status}]`);
    return true;
  } catch (error) {
    console.error(`❌ CRITICAL DB ERROR for ${customerPhone}:`, error.message);
    return false;
  }
}

function clearCustomerState(customerPhone) {
  try {
    db.prepare("DELETE FROM conversation_state WHERE customer_phone = ?").run(
      customerPhone,
    );
    console.log(`🧹 Cleared active state memory for ${customerPhone}`);
  } catch (error) {
    console.error(
      `❌ Database clear error for ${customerPhone}:`,
      error.message,
    );
  }
}

async function sendWhatsAppMessage(phoneNumber, messageText, senderPhoneId) {
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
  const phoneId = senderPhoneId || process.env.BUSINESS_PHONE;

  if (!WHATSAPP_TOKEN || !phoneId) {
    console.log("⚠️  WhatsApp credentials not configured. Message NOT sent.");
    console.log(`Would send to ${phoneNumber}: "${messageText}"`);
    return;
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${phoneId}/messages`,
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
  }
}

// ============================================================================
// STATEFUL ORDER MANAGEMENT HELPERS
// ============================================================================

function calculateItemsPrice(items, shopId) {
  const shopCatalog = shopId ? getShopCatalog(shopId) : {};
  let total = 0;
  for (const item of items) {
    const name = item.name ? item.name.toLowerCase() : "unknown";
    const qty = parseInt(item.quantity) || 1;
    const productInfo =
      shopCatalog[name] || (inventory.products && inventory.products[name]);
    if (productInfo) {
      total += productInfo.price * qty;
    }
  }
  return total;
}

async function queryGeminiEndpoint(incomingMessage, shopId) {
  const shopCatalog = shopId ? getShopCatalog(shopId) : {};
  const availableItems =
    Object.keys(shopCatalog).length > 0
      ? Object.keys(shopCatalog).join(", ")
      : Object.keys(inventory.products || {}).join(", ");

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
          systemInstruction: `${FMCG_SYSTEM_PROMPT}\n\nAvailable stock keys: ${availableItems}.\n\nAdditionally, if a customer asks for items NOT in available stock, add their original names to an "unavailable_items" array. Extract location context if present. Structure:\n{\n  "items": [{ "name": "matched item name", "quantity": 1 }],\n  "unavailable_items": ["item name 1"],\n  "extracted_address": "address text"\n}`,
        },
      });

      return JSON.parse(response.text);
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

async function appendOrderToGoogleSheets(spreadsheetId, orderData) {
  try {
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
      console.log(
        "⚠️ Google Sheets credentials not configured. Skipping sheets logging.",
      );
      return;
    }

    const googleCredentials = JSON.parse(
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
    );

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: googleCredentials.client_email,
        private_key: googleCredentials.private_key,
      },
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    const rowValues = [
      [
        orderData.date,
        orderData.shortCode,
        orderData.store,
        orderData.customer,
        orderData.items,
        `Ksh ${orderData.subtotal}`,
        `Ksh ${orderData.delivery}`,
        `Ksh ${orderData.total}`,
        orderData.mpesa,
        orderData.type,
        "PENDING_RIDER",
      ],
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheetId,
      range: "Sheet1!A:K",
      valueInputOption: "USER_ENTERED",
      resource: { values: rowValues },
    });

    console.log(
      `📊 Successfully logged transaction to Sheet ID: ${spreadsheetId}`,
    );
  } catch (error) {
    console.error("❌ Google Sheets Logging Error:", error.message);
  }
}

const FMCG_SYSTEM_PROMPT = `
You are an expert FMCG inventory parsing agent for Kenyan retail kiosks. 
Your job is to read unstructured customer text messages and extract items into a clean JSON array.

CRITICAL: Map local terms (English/Swahili/Sheng) to standard catalog options:
- "Unga", "Jogoo", "Pembe" -> Maize flour 
- "Maziwa", "Milk" -> cooking oil
- "Sukari", "Sugar" -> sugar
- "Wali", "Rice", "mchele" -> pishori rice / sindano rice
- "Beans", "Maharagwe" -> beans
- "Ngano", "Ajab", "Unga ngano" -> Wheat flour
`;

// ============================================================================
// WEBHOOK: Main Message Handler (State Machine)
// ============================================================================

app.post("/webhook", async (req, res) => {
  try {
    console.log("📥 RAW INCOMING PAYLOAD:", JSON.stringify(req.body, null, 2));

    const messageData = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const incomingMessage = (messageData?.text?.body || "").trim();
    const senderPhone = messageData?.from;

    if (!incomingMessage || !senderPhone) {
      return res.sendStatus(200);
    }

    const recipientPhoneId =
      req.body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

    const tenant = getTenantByPhoneId(recipientPhoneId);

    if (!tenant) {
      console.error(
        `❌ No tenant found for phone_number_id: ${recipientPhoneId}`,
      );
      return res.sendStatus(404);
    }

    console.log(`🏪 Tenant resolved: ${tenant.shop_name} (${tenant.shop_id})`);
    const upperMsg = incomingMessage.toUpperCase();

    // ─── STEP 1: Process Stateful Checkout Flows ───
    const customerState = getCustomerState(senderPhone);

    if (customerState) {
      const currentStep = customerState.status;
      console.log(`🔄 Resuming state for ${senderPhone}: [${currentStep}]`);

      if (currentStep === "PENDING_OWNER_APPROVAL") {
        await sendWhatsAppMessage(
          senderPhone,
          "⏳ Your order is still being reviewed by the shop manager. Please wait for confirmation.",
          tenant.whatsapp_phone_id,
        );
        return res.sendStatus(200);
      }

      if (currentStep === "AWAITING_CUSTOMER_FINALIZATION") {
        try {
          if (upperMsg.startsWith("PICKUP")) {
            const mpesaCode = incomingMessage
              .replace(/PICKUP/i, "")
              .trim()
              .toUpperCase();

            await sendWhatsAppMessage(
              senderPhone,
              `🛍️ Payment received! Your order is being packed for pickup.`,
              tenant.whatsapp_phone_id,
            );
            await sendWhatsAppMessage(
              tenant.owner_phone,
              `📦 *READY FOR PICKUP*\nCustomer: ${senderPhone}\nCode: ${mpesaCode}`,
              tenant.whatsapp_phone_id,
            );

            await appendOrderToGoogleSheets(tenant.spreadsheet_id, {
              date: new Date().toLocaleDateString("en-KE", {
                timeZone: "Africa/Nairobi",
              }),
              shortCode: customerState.shortCode,
              store: tenant.shop_name,
              customer: senderPhone,
              items: customerState.items,
              subtotal: customerState.subtotal,
              delivery: 0,
              total: customerState.subtotal,
              mpesa: mpesaCode,
              type: "PICKUP",
            });

            clearCustomerState(senderPhone);
          } else if (upperMsg.startsWith("DELIVERY")) {
            const rawDetails = incomingMessage.replace(/DELIVERY/i, "").trim();
            const detailsArray = rawDetails.split(" ");
            const mpesaCode = detailsArray.pop().toUpperCase();
            const location = detailsArray.join(" ") || "Specified Address";

            const deliveryFee = 20;
            const totalToPay = customerState.subtotal + deliveryFee;

            await sendWhatsAppMessage(
              senderPhone,
              `🏍️ Confirmed! Total paid: Ksh ${totalToPay} (incl. Ksh 20 delivery). Our rider is arriving shortly at ${location}!`,
              tenant.whatsapp_phone_id,
            );

            const riderTicket = `**DISPATCH TICKET**\n🏪 Store: ${tenant.shop_name}\n📦 Items: ${customerState.items}\n📍 Dropoff: ${location}\n📱 Tel: ${senderPhone}\n🔑 M-Pesa: ${mpesaCode}`;
            await sendWhatsAppMessage(
              tenant.rider_phone,
              riderTicket,
              tenant.whatsapp_phone_id,
            );

            await appendOrderToGoogleSheets(tenant.spreadsheet_id, {
              date: new Date().toLocaleDateString("en-KE", {
                timeZone: "Africa/Nairobi",
              }),
              shortCode: customerState.shortCode,
              store: tenant.shop_name,
              customer: senderPhone,
              items: customerState.items,
              subtotal: customerState.subtotal,
              delivery: deliveryFee,
              total: totalToPay,
              mpesa: mpesaCode,
              type: "DELIVERY",
            });

            clearCustomerState(senderPhone);
          } else {
            await sendWhatsAppMessage(
              senderPhone,
              "Please reply with *PICKUP [MpesaCode]* or *DELIVERY [Location] [MpesaCode]*",
              tenant.whatsapp_phone_id,
            );
          }
          return res.sendStatus(200);
        } catch (error) {
          console.error(
            "❌ Error processing customer checkout:",
            error.message,
          );
          return res.sendStatus(200);
        }
      }
    }

    // ─── STEP 2: Shop Owner Approval Gateway ───
    if (
      senderPhone === tenant.owner_phone &&
      (upperMsg.startsWith("ACCEPT") || upperMsg.startsWith("REJECT"))
    ) {
      try {
        const parts = incomingMessage.split(" ");
        const action = parts[0].toUpperCase();
        const targetShortCode = parts[1];

        if (!targetShortCode) {
          await sendWhatsAppMessage(
            tenant.owner_phone,
            "⚠️ Please specify the order number. Example: *ACCEPT 1*",
            tenant.whatsapp_phone_id,
          );
          return res.sendStatus(200);
        }

        let targetCustomerPhone = null;
        let targetMeta = null;

        const allPending = db
          .prepare(
            "SELECT customer_phone, metadata_json FROM conversation_state WHERE current_step = 'PENDING_OWNER_APPROVAL' AND shop_id = ?",
          )
          .all(tenant.shop_id);

        for (const row of allPending) {
          const meta = JSON.parse(row.metadata_json || "{}");
          if (meta.shortCode === targetShortCode) {
            targetCustomerPhone = row.customer_phone;
            targetMeta = meta;
            break;
          }
        }

        if (!targetCustomerPhone) {
          await sendWhatsAppMessage(
            tenant.owner_phone,
            `⚠️ Order #${targetShortCode} not found or already processed.`,
            tenant.whatsapp_phone_id,
          );
          return res.sendStatus(200);
        }

        if (action === "ACCEPT") {
          const saved = saveCustomerState(
            targetCustomerPhone,
            tenant.shop_id,
            "AWAITING_CUSTOMER_FINALIZATION",
            {
              shortCode: targetMeta.shortCode,
              items: targetMeta.items,
              subtotal: targetMeta.subtotal,
            },
          );

          if (!saved) return res.sendStatus(500);

          const tillMsg =
            `✅ Order #${targetShortCode} CONFIRMED!\n\n` +
            `💳 Pay Ksh ${targetMeta.subtotal} to Till: ${tenant.till_number}\n\n` +
            `Then reply:\n` +
            `*PICKUP [MpesaCode]*\n` +
            `or\n` +
            `*DELIVERY [Location] [MpesaCode]*`;

          await sendWhatsAppMessage(
            targetCustomerPhone,
            tillMsg,
            tenant.whatsapp_phone_id,
          );
          await sendWhatsAppMessage(
            tenant.owner_phone,
            `✅ Order #${targetShortCode} accepted.`,
            tenant.whatsapp_phone_id,
          );
        } else {
          clearCustomerState(targetCustomerPhone);
          await sendWhatsAppMessage(
            targetCustomerPhone,
            `❌ Sorry, your order #${targetShortCode} was declined.`,
            tenant.whatsapp_phone_id,
          );
          await sendWhatsAppMessage(
            tenant.owner_phone,
            `❌ Order #${targetShortCode} rejected.`,
            tenant.whatsapp_phone_id,
          );
        }

        return res.sendStatus(200);
      } catch (error) {
        console.error("❌ Owner approval error:", error.message);
        return res.sendStatus(200);
      }
    }

    // ─── STEP 3: Handle New Inbound Order ───
    try {
      const parsedOrder = await queryGeminiEndpoint(
        incomingMessage,
        tenant.shop_id,
      );
      const subtotal = calculateItemsPrice(parsedOrder.items, tenant.shop_id);
      const formattedItemString = parsedOrder.items
        .map((i) => `${i.quantity}x ${i.name}`)
        .join(", ");

      const assignedId = orderIdCounter.toString();
      orderIdCounter++;

      const saved = saveCustomerState(
        senderPhone,
        tenant.shop_id,
        "PENDING_OWNER_APPROVAL",
        {
          shortCode: assignedId,
          items: formattedItemString,
          subtotal: subtotal,
        },
      );

      if (!saved) return res.sendStatus(500);

      const ownerAlert =
        `🔔 *NEW ORDER #${assignedId} RECEIVED*\n` +
        `👤 Customer: ${senderPhone}\n` +
        `📦 Items: ${formattedItemString}\n` +
        `💵 Est. Subtotal: Ksh ${subtotal}\n\n` +
        `👉 Reply *ACCEPT ${assignedId}* to approve.\n` +
        `👉 Reply *REJECT ${assignedId}* to decline.`;

      await sendWhatsAppMessage(
        tenant.owner_phone,
        ownerAlert,
        tenant.whatsapp_phone_id,
      );
      await sendWhatsAppMessage(
        senderPhone,
        "⏳ Checking availability with the shop manager now. We'll text you once confirmed!",
        tenant.whatsapp_phone_id,
      );

      saveConversation(senderPhone, incomingMessage, ownerAlert);
    } catch (geminiError) {
      console.error("❌ Order parsing failed:", geminiError.message);
      await sendWhatsAppMessage(
        senderPhone,
        "Sorry, I had trouble reading your order text. Please list items clearly!",
        tenant.whatsapp_phone_id,
      );
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("❌ CRITICAL WEBHOOK ERROR:", error.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// WEBHOOK VERIFICATION
// ============================================================================

app.get("/webhook", (req, res) => {
  const verifyToken = process.env.VERIFY_TOKEN;
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (token === verifyToken) {
    res.status(200).send(challenge);
  } else {
    res.status(403).send("Forbidden");
  }
});

// ============================================================================
// ADMIN ENDPOINTS & HEALTH
// ============================================================================

app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// ============================================================================
// START SERVER WITH PORT BACKOFF RECOVERY
// ============================================================================

async function startServer() {
  await initDatabase();
  const PORT = process.env.PORT || 3001;

  const server = app
    .listen(PORT, () => {
      console.log(`🚀 Multi-Tenant Server running on port ${PORT}`);
      console.log(`✅ Ready to receive WhatsApp messages`);
    })
    .on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        console.error(
          `⚠️ Port ${PORT} already in use. Retrying in 5 seconds...`,
        );
        setTimeout(() => startServer(), 5000);
      } else {
        console.error("❌ FATAL server error:", error.message);
      }
    });
}

startServer();
