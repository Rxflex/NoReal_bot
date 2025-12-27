import { Database } from "bun:sqlite";

const db = new Database("bot_memory.sqlite");

// Initialize tables
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    fact TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER,
    role TEXT,
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS chat_settings (
    chat_id INTEGER PRIMARY KEY,
    temperature REAL DEFAULT 0.7,
    mood TEXT DEFAULT 'neutral'
  )
`);

// --- User Operations ---
export function upsertUser(id: number, username: string | undefined, first_name: string) {
  const query = db.query(`
    INSERT INTO users (id, username, first_name) VALUES ($id, $username, $first_name)
    ON CONFLICT(id) DO UPDATE SET username = $username, first_name = $first_name
  `);
  query.run({ $id: id, $username: username || null, $first_name: first_name });
}

// --- Chat Settings Operations ---
export function upsertChatSettings(chatId: number, temperature: number, mood: string) {
  const query = db.query(`
    INSERT INTO chat_settings (chat_id, temperature, mood) VALUES ($chatId, $temperature, $mood)
    ON CONFLICT(chat_id) DO UPDATE SET temperature = $temperature, mood = $mood
  `);
  query.run({ $chatId: chatId, $temperature: temperature, $mood: mood });
}

export function getChatSettings(chatId: number): { temperature: number, mood: string } {
  const query = db.query(`SELECT temperature, mood FROM chat_settings WHERE chat_id = $chatId`);
  const result = query.get({ $chatId: chatId }) as { temperature: number, mood: string } | null;
  return result || { temperature: 0.7, mood: 'neutral' };
}

// --- Fact/Memory Operations (RAG) ---
export function addFact(userId: number, fact: string) {
  const query = db.query(`INSERT INTO facts (user_id, fact) VALUES ($userId, $fact)`);
  query.run({ $userId: userId, $fact: fact });
}

export function getFacts(userId: number): string[] {
  const query = db.query(`SELECT fact FROM facts WHERE user_id = $userId ORDER BY created_at DESC LIMIT 10`);
  const results = query.all({ $userId: userId }) as { fact: string }[];
  return results.map(r => r.fact);
}

// --- History Operations ---
export function addMessage(chatId: number, role: 'user' | 'assistant' | 'system', content: string) {
  const query = db.query(`INSERT INTO history (chat_id, role, content) VALUES ($chatId, $role, $content)`);
  query.run({ $chatId: chatId, $role: role, $content: content });
}

export function getHistory(chatId: number, limit: number = 10): { role: string, content: string }[] {
  const query = db.query(`SELECT role, content FROM history WHERE chat_id = $chatId ORDER BY id DESC LIMIT $limit`);
  const results = query.all({ $chatId: chatId, $limit: limit }) as { role: string, content: string }[];
  return results.reverse(); // Return in chronological order
}

export default db;
