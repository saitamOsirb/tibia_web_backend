"use strict";

const { Pool } = require("pg");

let pool = null;

function initDatabase() {

  if (pool) {
    return pool;
  }

  pool = new Pool({
    host: process.env.PGHOST     || "localhost",
    port: process.env.PGPORT     || 5432,
    user: process.env.PGUSER     || "postgres",
    password: process.env.PGPASSWORD || "k7t7st5a",
    database: process.env.PGDATABASE || "tibia_web",
  });

  const createAccountsSQL = `
    CREATE TABLE IF NOT EXISTS accounts (
      id          SERIAL PRIMARY KEY,
      account     TEXT UNIQUE NOT NULL,
      hash        TEXT NOT NULL,
      definition  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;

  const createPlayersSQL = `
    CREATE TABLE IF NOT EXISTS players (
      id          SERIAL PRIMARY KEY,
      account     TEXT NOT NULL REFERENCES accounts(account) ON DELETE CASCADE,
      name        TEXT UNIQUE NOT NULL,
      data        JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;

  pool.query(createAccountsSQL, (err) => {
    if (err) {
      console.error("[PG] Error creando tabla accounts:", err);
    } else {
      console.log("[PG] Tabla accounts lista");
    }
  });

  pool.query(createPlayersSQL, (err) => {
    if (err) {
      console.error("[PG] Error creando tabla players:", err);
    } else {
      console.log("[PG] Tabla players lista");
    }
  });

  return pool;
}

function findAccount(account, callback) {
  const db = initDatabase();
  db.query(
    "SELECT account, hash, definition FROM accounts WHERE account = $1 LIMIT 1",
    [account],
    (err, res) => {
      if (err) return callback(err);
      callback(null, res.rows[0]);
    }
  );
}

function insertAccount(account, hash, definition, callback) {
  const db = initDatabase();
  db.query(
    "INSERT INTO accounts (account, hash, definition) VALUES ($1, $2, $3)",
    [account, hash, definition],
    (err, res) => {
      if (err) return callback(err);
      callback(null);
    }
  );
}

/**
 * Guarda el JSON completo del personaje.
 * name   → nombre del char (definition)
 * account→ número de cuenta
 * data   → objeto JS con el JSON que mostraste
 */
function savePlayerData(name, account, data, callback) {
  const db = initDatabase();

  db.query(
    `
      INSERT INTO players (account, name, data)
      VALUES ($1, $2, $3)
      ON CONFLICT (name)
      DO UPDATE SET data = EXCLUDED.data, updated_at = now()
    `,
    [account, name, data], // pg soporta JSONB desde objeto JS
    (err, res) => {
      if (err) return callback(err);
      callback(null);
    }
  );
}

/**
 * Carga el JSON completo del personaje por nombre.
 * callback(err, data) → data es el objeto JS con el formato que mostraste.
 */
function loadPlayerData(name, callback) {
  const db = initDatabase();

  db.query(
    "SELECT data FROM players WHERE name = $1 LIMIT 1",
    [name],
    (err, res) => {
      if (err) return callback(err);
      if (!res.rows[0]) return callback(null, null);
      const row = res.rows[0];
      // row.data ya viene como objeto JS cuando es JSONB
      callback(null, row.data);
    }
  );
}
function updatePlayerData(name, data, callback) {
  const db = initDatabase();

  db.query(
    `
      UPDATE players
      SET data = $2,
          updated_at = now()
      WHERE name = $1
    `,
    [name, data],
    (err, res) => {
      if (err) return callback(err);
      callback(null);
    }
  );
}
module.exports = {
  initDatabase,
  findAccount,
  insertAccount,
  savePlayerData,
  loadPlayerData,
  updatePlayerData
};