"use strict";

const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { Client } = require("pg");

async function main() {
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) require("dotenv").config();
  if (!process.env.DATABASE_URL) throw new Error("Configure DATABASE_URL.");
  const host = new URL(process.env.DATABASE_URL).hostname;
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST && !["127.0.0.1", "localhost", "[::1]"].includes(host)) {
    throw new Error("O ambiente com emulador exige banco local.");
  }
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "true"
      ? { rejectUnauthorized: true, ca: process.env.DATABASE_CA || undefined }
      : false
  });
  await client.connect();
  try {
    await client.query(await readFile(join(__dirname, "001_schema.sql"), "utf8"));
    console.log("Migração 001 aplicada.");
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
