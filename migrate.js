/**
 * DOCUMENTATION:
 * This script migrates data from frontier.sqlite to the PostgreSQL database.
 * sessions.sqlite is excluded from this migration as the application
 * already uses PostgreSQL session storage.
 * Existing sessions in sessions.sqlite may expire and require reauthentication.
 */

const Database = require("better-sqlite3");
const { Pool } = require("pg");
const path = require("node:path");
require("dotenv").config();

async function migrate() {
  const sqliteDb = new Database(path.join(__dirname, "data", "frontier.sqlite"));
  const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const client = await pgPool.connect();
  console.log("Starting migration...");

  try {
    await client.query("BEGIN");

    // 1. Users
    const users = sqliteDb.prepare("SELECT * FROM users").all();
    console.log(`Migrating ${users.length} users...`);
    for (const user of users) {
      await client.query(
        "INSERT INTO users (id, phone, full_name, email, country, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING",
        [user.id, user.phone, user.full_name, user.email, user.country, user.created_at]
      );
    }
    if (users.length > 0) {
      await client.query("SELECT setval('users_id_seq', (SELECT MAX(id) FROM users))");
    }

    // 2. OTP Codes
    const otpCodes = sqliteDb.prepare("SELECT * FROM otp_codes").all();
    console.log(`Migrating ${otpCodes.length} OTP codes...`);
    for (const otp of otpCodes) {
      // NOTE: Do not log otp.code_plain
      await client.query(
        "INSERT INTO otp_codes (id, phone, code_hash, code_plain, expires_at, attempts, consumed, created_at, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING",
        [otp.id, otp.phone, otp.code_hash, otp.code_plain, otp.expires_at, otp.attempts, otp.consumed, otp.created_at, otp.status]
      );
    }
    if (otpCodes.length > 0) {
      await client.query("SELECT setval('otp_codes_id_seq', (SELECT MAX(id) FROM otp_codes))");
    }


    // 3. Applications
    const applications = sqliteDb.prepare("SELECT * FROM applications").all();
    console.log(`Migrating ${applications.length} applications...`);
    for (const app of applications) {
      await client.query(
        "INSERT INTO applications (id, user_id, amount_usd, repayment_period_months, country, employment_status, monthly_income_usd, purpose, status, admin_note, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (id) DO NOTHING",
        [app.id, app.user_id, app.amount_usd, app.repayment_period_months, app.country, app.employment_status, app.monthly_income_usd, app.purpose, app.status, app.admin_note, app.created_at, app.updated_at]
      );
    }
    if (applications.length > 0) {
      await client.query("SELECT setval('applications_id_seq', (SELECT MAX(id) FROM applications))");
    }

    // 4. Support Messages
    const supportMessages = sqliteDb.prepare("SELECT * FROM support_messages").all();
    console.log(`Migrating ${supportMessages.length} support messages...`);
    for (const msg of supportMessages) {
      await client.query(
        "INSERT INTO support_messages (id, user_id, name, contact, topic, message, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING",
        [msg.id, msg.user_id, msg.name, msg.contact, msg.topic, msg.message, msg.status, msg.created_at]
      );
    }
    if (supportMessages.length > 0) {
      await client.query("SELECT setval('support_messages_id_seq', (SELECT MAX(id) FROM support_messages))");
    }

    // 5. Audit Logs
    const auditLogs = sqliteDb.prepare("SELECT * FROM audit_logs").all();
    console.log(`Migrating ${auditLogs.length} audit logs...`);
    for (const log of auditLogs) {
      await client.query(
        "INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, details, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING",
        [log.id, log.actor_user_id, log.action, log.entity_type, log.entity_id, log.details, log.created_at]
      );
    }
    if (auditLogs.length > 0) {
      await client.query("SELECT setval('audit_logs_id_seq', (SELECT MAX(id) FROM audit_logs))");
    }

    // 6. Telegram Admins
    const telegramAdmins = sqliteDb.prepare("SELECT * FROM telegram_admins").all();
    console.log(`Migrating ${telegramAdmins.length} telegram admins...`);
    for (const admin of telegramAdmins) {
      await client.query(
        "INSERT INTO telegram_admins (id, telegram_user_id, telegram_username, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
        [admin.id, admin.telegram_user_id, admin.telegram_username, admin.created_at]
      );
    }
    if (telegramAdmins.length > 0) {
      await client.query("SELECT setval('telegram_admins_id_seq', (SELECT MAX(id) FROM telegram_admins))");
    }

    // 7. Telegram Notifications
    const telegramNotifications = sqliteDb.prepare("SELECT * FROM telegram_notifications").all();
    console.log(`Migrating ${telegramNotifications.length} telegram notifications...`);
    for (const n of telegramNotifications) {
      await client.query(
        "INSERT INTO telegram_notifications (id, event_key, entity_type, entity_id, chat_id, message_id, status, error, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING",
        [n.id, n.event_key, n.entity_type, n.entity_id, n.chat_id, n.message_id, n.status, n.error, n.created_at]
      );
    }
    if (telegramNotifications.length > 0) {
      await client.query("SELECT setval('telegram_notifications_id_seq', (SELECT MAX(id) FROM telegram_notifications))");
    }

    // 8. Support Tickets
    const supportTickets = sqliteDb.prepare("SELECT * FROM support_tickets").all();
    console.log(`Migrating ${supportTickets.length} support tickets...`);
    for (const t of supportTickets) {
      await client.query(
        "INSERT INTO support_tickets (id, user_id, name, contact, topic, message, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING",
        [t.id, t.user_id, t.name, t.contact, t.topic, t.message, t.status, t.created_at]
      );
    }
    if (supportTickets.length > 0) {
      await client.query("SELECT setval('support_tickets_id_seq', (SELECT MAX(id) FROM support_tickets))");
    }

    // 9. Appointments
    const appointments = sqliteDb.prepare("SELECT * FROM appointments").all();
    console.log(`Migrating ${appointments.length} appointments...`);
    for (const a of appointments) {
      await client.query(
        "INSERT INTO appointments (id, user_id, full_name, phone, email, preferred_date, preferred_time, timezone, purpose, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING",
        [a.id, a.user_id, a.full_name, a.phone, a.email, a.preferred_date, a.preferred_time, a.timezone, a.purpose, a.status, a.created_at]
      );
    }
    if (appointments.length > 0) {
      await client.query("SELECT setval('appointments_id_seq', (SELECT MAX(id) FROM appointments))");
    }

    await client.query("COMMIT");
    console.log("Migration completed successfully!");

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed, rolled back changes:", err);
  } finally {
    sqliteDb.close();
    client.release();
    await pgPool.end();
  }
}

migrate();
