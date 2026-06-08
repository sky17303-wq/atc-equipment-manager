const fs = require("node:fs/promises");
const path = require("node:path");

require("../server").loadEnv?.();

async function main() {
  const { Pool } = require("pg");
  const pool = new Pool(buildPgConfig());
  try {
    const sql = await fs.readFile(path.join(__dirname, "..", "database", "app-postgres.sql"), "utf8");
    await pool.query(sql);
    console.log("PostgreSQL migration completed.");
  } finally {
    await pool.end();
  }
}

function buildPgConfig() {
  const ssl = String(process.env.PGSSL || "").toLowerCase();
  return {
    connectionString: process.env.DATABASE_URL || undefined,
    host: process.env.PGHOST || undefined,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    database: process.env.PGDATABASE || undefined,
    user: process.env.PGUSER || undefined,
    password: process.env.PGPASSWORD || undefined,
    ssl: ssl === "true" || ssl === "1" ? { rejectUnauthorized: false } : undefined
  };
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
