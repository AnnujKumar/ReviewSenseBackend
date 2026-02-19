import 'dotenv/config';

/** @type { import("drizzle-kit").Config } */
export default {
  schema: "./lib/db/schema.js",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
};