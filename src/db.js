const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// Helper to adapt SQLite queries to PostgreSQL
function adaptSql(sql) {
  let counter = 1;
  let pgSql = sql.replace(/\?/g, () => `$${counter++}`);
  
  // Convert SQLite specific functions/syntax if needed
  // e.g., CURRENT_TIMESTAMP is fine in both.
  
  // Handle lastInsertRowid simulation by adding RETURNING id to INSERT statements
  const trimmedSql = pgSql.trim();
  if (trimmedSql.toUpperCase().startsWith('INSERT') && !trimmedSql.toUpperCase().includes('RETURNING')) {
      pgSql += ' RETURNING id';
  }
  
  return pgSql;
}

const db = {
  pool,
  prepare: (sql) => {
    const pgSql = adaptSql(sql);
    return {
      run: async (...params) => {
        try {
          const result = await pool.query(pgSql, params);
          return {
            lastInsertRowid: result.rows[0]?.id || null,
            changes: result.rowCount
          };
        } catch (err) {
          console.error("Database error (run):", err.message, "SQL:", pgSql);
          throw err;
        }
      },
      get: async (...params) => {
        try {
          const result = await pool.query(pgSql, params);
          return result.rows[0];
        } catch (err) {
          console.error("Database error (get):", err.message, "SQL:", pgSql);
          throw err;
        }
      },
      all: async (...params) => {
        try {
          const result = await pool.query(pgSql, params);
          return result.rows;
        } catch (err) {
          console.error("Database error (all):", err.message, "SQL:", pgSql);
          throw err;
        }
      }
    };
  },
  exec: async (sql) => {
    try {
      return await pool.query(sql);
    } catch (err) {
      console.error("Database error (exec):", err.message, "SQL:", sql);
      throw err;
    }
  }
};

module.exports = db;
