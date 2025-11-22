import fs from "fs";
import { createClient } from "graphql-ws";
import fetch from "node-fetch";
import Database from "better-sqlite3";
import WebSocket from "ws"; // <-- ВАЖНО: добавили WebSocket

// --- Конфигурация из окружения ---
const BITQUERY_KEY = process.env.BITQUERY_KEY;
const TG_TOKEN = process.env.TG_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const DB_PATH = process.env.DB_PATH || "./tokens.db";
const TEAMS_FILE = process.env.TEAMS_FILE || "./src/teams.txt";

if (!BITQUERY_KEY || !TG_TOKEN || !CHAT_ID) {
  console.error("ERROR: Set BITQUERY_KEY, TG_TOKEN and CHAT_ID in env");
  process.exit(1);
}

// --- Загрузка списка команд (необязательно) ---
let teams = [];
try {
  const tRaw = fs.readFileSync(TEAMS_FILE, "utf8");
  teams = tRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  console.log("Loaded teams:", teams.length);
} catch (e) {
  console.log("No teams file found or empty — continuing without team matches.");
}

// --- Список твоих суффиксов ---
const SUFFIXES = [
  "draft",
  "drafted",
  "soldraft",
  "soldrafted",
  "cs2draft",
  "cs2drafted",
  "draftcs2",
  "draftedcs2",
  "draftsol",
  "draftfun"
];

const DRAFT_SUFFIX_REGEX = new RegExp(
  `(?:${SUFFIXES.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`,
  "i"
);

// --- Инициализация SQLite ---
const db = new Database(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT,
  pool TEXT,
  signature TEXT,
  found_by TEXT,
  matched_team TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// --- Bitquery subscription ---
const QUERY = `
subscription {
  Solana {
    Instructions(
      where: {
        Instruction: {
          Program: { Address: { is: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN" } },
          Method: { is: "initialize_virtual_pool_with_spl_token" }
        },
        Transaction: { Result: { Success: true } }
      }
    ) {
      Block { Time }
      Instruction { Method Accounts { Address } }
      Transaction { Signature }
    }
  }
}
`;

const WS_URL = "wss://streaming.bitquery.io/graphql";

const client = createClient({
  url: WS_URL,
  webSocketImpl: WebSocket, // <-- КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ
  connectionParams: {
    headers: { "X-API-KEY": BITQUERY_KEY }
  }
});

// --- Отправка в Telegram ---
async function sendTelegram(text) {
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" })
    });
    return await res.json();
  } catch (e) {
    console.error("Telegram send error:", e);
    return null;
  }
}

// --- Обработчик инструкций ---
async function handleInstruction(obj) {
  try {
    const ins = obj.Instruction;
    const tx = obj.Transaction || {};
    const accounts = (ins?.Accounts || []).map(a => a.Address).filter(Boolean);

    const signature = tx.Signature || "";
    let triggeredBy = [];

    // проверяем каждый адрес
    for (const addr of accounts) {
      if (DRAFT_SUFFIX_REGEX.test(addr)) {
        triggeredBy.push(addr);
      }
    }

    if (triggeredBy.length > 0) {
      const mint = triggeredBy[0] || null;
      const pool = accounts[0] || null;

      db.prepare(
        `INSERT INTO events (mint,pool,signature,found_by,matched_team)
         VALUES (?,?,?,?,?)`
      ).run(mint, pool, signature, triggeredBy.join(","), "");

      const text = `🔥 <b>Новый DBC токен</b>\n\nMint: <code>${mint}</code>\nPool: <code>${pool}</code>\nTx: <code>${signature}</code>\nMatchedSuffixes: <code>${triggeredBy.join(",")}</code>`;

      await sendTelegram(text);
      console.log("Alert sent for", mint);
    } else {
      db.prepare(
        `INSERT INTO events (mint,pool,signature,found_by,matched_team)
         VALUES (?,?,?,?,?)`
      ).run(accounts[0] || null, accounts[1] || null, signature, "no-match", "");

      console.log("Event stored (no match)", signature);
    }
  } catch (e) {
    console.error("handleInstruction error:", e);
  }
}

// --- Запуск подписки ---
console.log("Starting subscription to Bitquery...");

client.subscribe(
  { query: QUERY },
  {
    next: msg => {
      const ins = msg?.data?.Solana?.Instructions;
      if (!ins) return;
      if (Array.isArray(ins)) ins.forEach(i => handleInstruction(i));
      else handleInstruction(ins);
    },
    error: err => console.error("Subscription error:", err),
    complete: () => console.log("Subscription complete")
  }
);

// Graceful shutdown
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
