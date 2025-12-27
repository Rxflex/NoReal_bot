import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

// Determine DB Path: Use env var or default to /tmp/ for ReadOnly systems
const DB_PATH = process.env.DB_PATH || path.join("/tmp", "bot_memory.sqlite");

console.log(`[DB] Using database at: ${DB_PATH}`);

// Ensure directory exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(DB_PATH);

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    fact TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER,
    role TEXT,
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_settings (
    chat_id INTEGER PRIMARY KEY,
    temperature REAL DEFAULT 0.7,
    mood TEXT DEFAULT 'neutral'
  )
`);

// --- User Operations ---
export function upsertUser(id: number, username: string | undefined, first_name: string) {
  const stmt = db.prepare(`
    INSERT INTO users (id, username, first_name) VALUES ($id, $username, $first_name)
    ON CONFLICT(id) DO UPDATE SET username = $username, first_name = $first_name
  `);
  stmt.run({ id: id, username: username || null, first_name: first_name });
}

// --- Chat Settings Operations ---
export function upsertChatSettings(chatId: number, temperature: number, mood: string) {
  const stmt = db.prepare(`
    INSERT INTO chat_settings (chat_id, temperature, mood) VALUES ($chatId, $temperature, $mood)
    ON CONFLICT(chat_id) DO UPDATE SET temperature = $temperature, mood = $mood
  `);
  stmt.run({ chatId: chatId, temperature: temperature, mood: mood });
}

export function getChatSettings(chatId: number): { temperature: number, mood: string } {
  const stmt = db.prepare(`SELECT temperature, mood FROM chat_settings WHERE chat_id = $chatId`);
  const result = stmt.get({ chatId: chatId }) as { temperature: number, mood: string } | undefined;
  return result || { temperature: 0.7, mood: 'neutral' };
}

// --- Fact/Memory Operations (RAG) ---
export function addFact(userId: number, fact: string) {
  const stmt = db.prepare(`INSERT INTO facts (user_id, fact) VALUES ($userId, $fact)`);
  stmt.run({ userId: userId, fact: fact });
}

export function getFacts(userId: number): string[] {
  const stmt = db.prepare(`SELECT fact FROM facts WHERE user_id = $userId ORDER BY created_at DESC LIMIT 10`);
  const results = stmt.all({ userId: userId }) as { fact: string }[];
  return results.map(r => r.fact);
}

// --- History Operations ---
export function addMessage(chatId: number, role: 'user' | 'assistant' | 'system', content: string) {
  const stmt = db.prepare(`INSERT INTO history (chat_id, role, content) VALUES ($chatId, $role, $content)`);
  stmt.run({ chatId: chatId, role: role, content: content });
}

export function getHistory(chatId: number, limit: number = 10): { role: string, content: string }[] {
  const stmt = db.prepare(`SELECT role, content FROM history WHERE chat_id = $chatId ORDER BY id DESC LIMIT $limit`);
  const results = stmt.all({ chatId: chatId, limit: limit }) as { role: string, content: string }[];
  return results.reverse(); // Return in chronological order
}

export default db;
