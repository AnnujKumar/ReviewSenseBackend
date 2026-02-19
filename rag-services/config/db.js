import { drizzle } from "drizzle-orm/node-postgres"; // Or 'neon-http' if using serverless
import { Pool } from "pg";
import * as schema from "../lib/db/schema.js"; // 👈 IMPORT YOUR SCHEMA HERE

// Check if we have the connection string
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing in .env");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Required for Neon
});

// 🚀 CRITICAL: Pass { schema } here!
// If you leave this empty, db.query.users will be undefined.
export const db = drizzle(pool, { schema });