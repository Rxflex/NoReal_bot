import * as path from "path";
import * as fs from "fs";

// Configuration
const DB_TYPE = process.env.DB_TYPE || "sqlite"; // 'mysql' or 'sqlite'

let db: any;

// --- SQL Dialect Helpers ---
const isMysql = DB_TYPE === "mysql";

async function initDB() {
    if (isMysql) {
        const mysql = require("mysql2/promise");
        console.log("[DB] Connecting to MySQL...");
        
        // Parse DB_HOST to handle port if strictly necessary, but standard format usually works.
        // Format: host, user, password, database
        db = mysql.createPool({
            host: process.env.DB_HOST || "localhost",
            user: process.env.DB_USER || "root",
            password: process.env.DB_PASSWORD || "",
            database: process.env.DB_NAME || "norel_bot",
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            charset: "utf8mb4" // Important for emojis
        });

        // Test connection
        try {
            const connection = await db.getConnection();
            console.log("[DB] MySQL connected successfully.");
            connection.release();
        } catch (e) {
            console.error("[DB] MySQL connection failed:", e);
            process.exit(1);
        }

        // Init Tables (MySQL Syntax)
        const tableOptions = "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci";
        
        await db.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id BIGINT PRIMARY KEY,
                username VARCHAR(255),
                first_name VARCHAR(255)
            ) ${tableOptions}
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS facts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id BIGINT,
                fact TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id)
            ) ${tableOptions}
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS history (
                id INT AUTO_INCREMENT PRIMARY KEY,
                chat_id BIGINT,
                role VARCHAR(50),
                content TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            ) ${tableOptions}
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS chat_settings (
                chat_id BIGINT PRIMARY KEY,
                temperature FLOAT DEFAULT 0.7,
                mood VARCHAR(50) DEFAULT 'neutral'
            ) ${tableOptions}
        `);

    } else {
        // SQLite Implementation
        // Dynamic import to avoid build errors if better-sqlite3 is missing
        let Database;
        try {
            Database = require("better-sqlite3");
        } catch (e) {
            console.error("[DB] Error: 'better-sqlite3' is not installed. Install it or set DB_TYPE=mysql.");
            process.exit(1);
        }

        const DB_PATH = process.env.DB_PATH || path.join("/tmp", "bot_memory.sqlite");
        console.log(`[DB] Using SQLite at: ${DB_PATH}`);
        
        const dir = path.dirname(DB_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        db = new Database(DB_PATH);

        // Init Tables (SQLite Syntax)
        db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                username TEXT,
                first_name TEXT
            );
            CREATE TABLE IF NOT EXISTS facts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                fact TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id INTEGER,
                role TEXT,
                content TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS chat_settings (
                chat_id INTEGER PRIMARY KEY,
                temperature REAL DEFAULT 0.7,
                mood TEXT DEFAULT 'neutral'
            );
        `);
    }
}

// Initialize immediately (Top-level await is supported in newer Node, but let's be safe inside functions)
// For this module structure, we'll wrap exports to await init or handle it. 
// Since we are migrating to CommonJS/Node, top-level await might be tricky depending on config.
// We will simply run initDB synchronously for SQLite, but MySQL is async.
// Solution: We'll make the export functions async or handle the promise.
// SIMPLER: Just start it. If it fails, it fails.
initDB();


// --- Helper for Query Execution ---
async function runQuery(sql: string, params: any[]) {
    if (isMysql) {
        const [rows] = await db.execute(sql, params);
        return rows;
    } else {
        const stmt = db.prepare(sql);
        // SQLite needs run() for inserts/updates, all() for selects.
        // We'll guess based on SQL command or just try.
        if (sql.trim().toUpperCase().startsWith("SELECT")) {
            return stmt.all(...params);
        } else {
            return stmt.run(...params);
        }
    }
}

async function getRow(sql: string, params: any[]) {
    if (isMysql) {
        const [rows] = await db.execute(sql, params);
        return (rows as any[])[0];
    } else {
        return db.prepare(sql).get(...params);
    }
}


// --- User Operations ---
export async function upsertUser(id: number, username: string | undefined, first_name: string) {
    if (isMysql) {
        const sql = `
            INSERT INTO users (id, username, first_name) VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE username = VALUES(username), first_name = VALUES(first_name)
        `;
        await runQuery(sql, [id, username || null, first_name]);
    } else {
        const sql = `
            INSERT INTO users (id, username, first_name) VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET username = ?, first_name = ?
        `;
        await runQuery(sql, [id, username || null, first_name, username || null, first_name]);
    }
}

// --- Chat Settings Operations ---
export async function upsertChatSettings(chatId: number, temperature: number, mood: string) {
    if (isMysql) {
        const sql = `
            INSERT INTO chat_settings (chat_id, temperature, mood) VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE temperature = VALUES(temperature), mood = VALUES(mood)
        `;
        await runQuery(sql, [chatId, temperature, mood]);
    } else {
        const sql = `
            INSERT INTO chat_settings (chat_id, temperature, mood) VALUES (?, ?, ?)
            ON CONFLICT(chat_id) DO UPDATE SET temperature = ?, mood = ?
        `;
        await runQuery(sql, [chatId, temperature, mood, temperature, mood]);
    }
}

export async function getChatSettings(chatId: number): Promise<{ temperature: number, mood: string }> {
    const sql = `SELECT temperature, mood FROM chat_settings WHERE chat_id = ?`;
    const result = await getRow(sql, [chatId]);
    return (result as { temperature: number, mood: string }) || { temperature: 0.7, mood: 'neutral' };
}

// --- Fact/Memory Operations (RAG) ---
export async function addFact(userId: number, fact: string) {
    const sql = `INSERT INTO facts (user_id, fact) VALUES (?, ?)`;
    await runQuery(sql, [userId, fact]);
}

export async function getFacts(userId: number): Promise<string[]> {
    const sql = `SELECT fact FROM facts WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`;
    // For MySQL, runQuery returns rows array. For SQLite runQuery (via all) returns rows array.
    const results = await runQuery(sql, [userId]) as { fact: string }[];
    return results.map(r => r.fact);
}

// --- History Operations ---
export async function addMessage(chatId: number, role: 'user' | 'assistant' | 'system', content: string) {
    const sql = `INSERT INTO history (chat_id, role, content) VALUES (?, ?, ?)`;
    await runQuery(sql, [chatId, role, content]);
}

export async function getHistory(chatId: number, limit: number = 10): Promise<{ role: string, content: string }[]> {
    if (isMysql) {
        // MySQL PREPARED statements do not support ? in LIMIT in some versions/configurations or driver wrappers.
        // Safe to inject number directly as it is strongly typed as number.
        const sql = `SELECT role, content FROM history WHERE chat_id = ? ORDER BY id DESC LIMIT ${Number(limit)}`;
        const results = await runQuery(sql, [chatId]) as { role: string, content: string }[];
        return results.reverse();
    } else {
        const sql = `SELECT role, content FROM history WHERE chat_id = ? ORDER BY id DESC LIMIT ?`;
        const results = await runQuery(sql, [chatId, limit]) as { role: string, content: string }[];
        return results.reverse(); 
    }
}