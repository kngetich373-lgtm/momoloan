require("dotenv").config();
const { Pool } = require("pg");

async function test() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  });

  try {
    const resUsers = await pool.query("SELECT COUNT(*) FROM users");
    console.log("Users count:", resUsers.rows[0].count);
    const resApps = await pool.query("SELECT COUNT(*) FROM applications");
    console.log("Applications count:", resApps.rows[0].count);
  } catch (err) {
    console.error("Connection failed:", err);
  } finally {
    await pool.end();
  }
}
test();