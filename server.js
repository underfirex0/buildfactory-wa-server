require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const qrcodeTerminal = require("qrcode-terminal");

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || "buildfactory-secret-key";

app.use(cors());
app.use(express.json());

// ─── STATE ───────────────────────────────────────────────────────
let qrCodeData = null;
let qrCodeImage = null; // base64 PNG
let isReady = false;
let isInitializing = false;
let waClient = null;
let messageLog = [];

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.key;
  if (key !== API_KEY) {
    return res.status(401).json({ error: "Invalid API key" });
  }
  next();
}

// ─── WHATSAPP CLIENT ──────────────────────────────────────────────
function initWhatsApp() {
  if (isInitializing || isReady) return;
  isInitializing = true;
  console.log("🟡 Initializing WhatsApp client...");

  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: "./wa-session" }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
      ],
    },
  });

  waClient.on("qr", async (qr) => {
    console.log("📱 QR Code received — scan with your phone!");
    qrCodeData = qr;
    qrcodeTerminal.generate(qr, { small: true });
    try {
      qrCodeImage = await qrcode.toDataURL(qr);
    } catch (e) {
      console.error("QR image error:", e);
    }
  });

  waClient.on("ready", () => {
    console.log("✅ WhatsApp is ready!");
    isReady = true;
    isInitializing = false;
    qrCodeData = null;
    qrCodeImage = null;
  });

  waClient.on("authenticated", () => {
    console.log("🔐 WhatsApp authenticated!");
  });

  waClient.on("auth_failure", (msg) => {
    console.error("❌ Auth failure:", msg);
    isReady = false;
    isInitializing = false;
  });

  waClient.on("disconnected", (reason) => {
    console.log("🔴 WhatsApp disconnected:", reason);
    isReady = false;
    isInitializing = false;
    waClient = null;
    // Auto-reconnect after 5 seconds
    setTimeout(initWhatsApp, 5000);
  });

  waClient.on("message", (msg) => {
    // Log incoming messages
    messageLog.unshift({
      id: msg.id._serialized,
      from: msg.from,
      body: msg.body,
      timestamp: new Date(msg.timestamp * 1000).toISOString(),
      type: "incoming",
    });
    if (messageLog.length > 100) messageLog = messageLog.slice(0, 100);
  });

  waClient.initialize();
}

// ─── ROUTES ───────────────────────────────────────────────────────

// Health check — no auth required
app.get("/", (req, res) => {
  res.json({
    service: "BuildFactory WhatsApp Server",
    status: isReady ? "connected" : isInitializing ? "initializing" : "disconnected",
    ready: isReady,
    version: "1.0.0",
  });
});

// Status
app.get("/status", requireApiKey, (req, res) => {
  res.json({
    ready: isReady,
    initializing: isInitializing,
    hasQr: !!qrCodeData,
    messagesSent: messageLog.filter(m => m.type === "outgoing").length,
  });
});

// Get QR code as base64 image
app.get("/qr", requireApiKey, (req, res) => {
  if (isReady) {
    return res.json({ status: "already_connected", message: "WhatsApp is already connected!" });
  }
  if (!qrCodeImage) {
    if (!isInitializing) initWhatsApp();
    return res.json({ status: "loading", message: "Generating QR code, try again in 5 seconds..." });
  }
  res.json({ status: "pending", qr: qrCodeImage });
});

// Initialize / reconnect
app.post("/init", requireApiKey, (req, res) => {
  if (isReady) return res.json({ status: "already_connected" });
  initWhatsApp();
  res.json({ status: "initializing", message: "WhatsApp client starting..." });
});

// Send single message
app.post("/send", requireApiKey, async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ error: "phone and message are required" });
  }
  if (!isReady || !waClient) {
    return res.status(503).json({ error: "WhatsApp not connected. Please scan QR code first." });
  }

  try {
    // Format phone number
    const cleaned = phone.replace(/[^0-9]/g, "");
    const chatId = cleaned.includes("@") ? cleaned : `${cleaned}@c.us`;

    await waClient.sendMessage(chatId, message);

    // Log outgoing message
    messageLog.unshift({
      id: Date.now().toString(),
      to: phone,
      body: message,
      timestamp: new Date().toISOString(),
      type: "outgoing",
    });

    console.log(`✅ Message sent to ${phone}`);
    res.json({ success: true, to: phone });
  } catch (err) {
    console.error("Send error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Send bulk messages
app.post("/send-bulk", requireApiKey, async (req, res) => {
  const { messages, delay = 2000 } = req.body;
  // messages = [{ phone, message }, ...]

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array is required" });
  }
  if (!isReady || !waClient) {
    return res.status(503).json({ error: "WhatsApp not connected. Please scan QR code first." });
  }
  if (messages.length > 50) {
    return res.status(400).json({ error: "Maximum 50 messages per bulk send" });
  }

  const results = [];

  for (let i = 0; i < messages.length; i++) {
    const { phone, message } = messages[i];
    try {
      const cleaned = phone.replace(/[^0-9]/g, "");
      const chatId = `${cleaned}@c.us`;
      await waClient.sendMessage(chatId, message);

      messageLog.unshift({
        id: Date.now().toString() + i,
        to: phone,
        body: message,
        timestamp: new Date().toISOString(),
        type: "outgoing",
      });

      results.push({ phone, status: "sent" });
      console.log(`✅ [${i + 1}/${messages.length}] Sent to ${phone}`);

      // Delay between messages to avoid spam detection
      if (i < messages.length - 1) {
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (err) {
      results.push({ phone, status: "failed", error: err.message });
      console.error(`❌ Failed to send to ${phone}:`, err.message);
    }
  }

  const sent = results.filter(r => r.status === "sent").length;
  const failed = results.filter(r => r.status === "failed").length;

  res.json({ success: true, summary: { total: messages.length, sent, failed }, results });
});

// Get message log
app.get("/messages", requireApiKey, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ messages: messageLog.slice(0, limit) });
});

// Disconnect
app.post("/disconnect", requireApiKey, async (req, res) => {
  if (waClient) {
    await waClient.destroy();
    waClient = null;
    isReady = false;
    isInitializing = false;
  }
  res.json({ success: true, message: "WhatsApp disconnected" });
});

// ─── START ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 BuildFactory WhatsApp Server running on port ${PORT}`);
  console.log(`📡 API Key: ${API_KEY}`);
  // Auto-init on start
  initWhatsApp();
});
