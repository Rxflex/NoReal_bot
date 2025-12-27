import "reflect-metadata";
import { DataSource, Entity, PrimaryColumn, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, LessThanOrEqual } from "typeorm";
import * as path from "path";
import * as fs from "fs";

// --- Entities ---

@Entity("users")
export class User {
    @PrimaryColumn({ type: "bigint" })
    id!: string; // TypeORM maps BigInt to string to avoid JS precision loss

    @Column({ type: "varchar", nullable: true })
    username?: string;

    @Column({ type: "varchar", nullable: true })
    first_name?: string;

    @Column({ type: "int", default: 0 })
    reputation!: number;
}

@Entity("facts")
export class Fact {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: "bigint" })
    user_id!: string;

    @Column({ type: "text" })
    fact!: string;

    @CreateDateColumn()
    created_at!: Date;

    @ManyToOne(() => User)
    @JoinColumn({ name: "user_id" })
    user?: User;
}

@Entity("history")
export class History {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: "bigint" })
    chat_id!: string;

    @Column({ type: "bigint", nullable: true })
    user_id?: string;

    @Column({ type: "varchar", length: 50 })
    role!: string;

    @Column({ type: "varchar", nullable: true })
    name?: string;

    @Column({ type: "text" })
    content!: string;

    @CreateDateColumn()
    timestamp!: Date;
}

@Entity("relationships")
export class Relationship {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: "bigint" })
    chat_id!: string;

    @Column({ type: "bigint" })
    user_id_1!: string;

    @Column({ type: "bigint" })
    user_id_2!: string;

    @Column({ type: "int", default: 0 })
    affection!: number; // -100 to 100

    @Column({ type: "varchar", nullable: true })
    status?: string; // e.g., "enemies", "friends", "married", "it's complicated"
}

@Entity("chat_settings")
export class ChatSettings {
    @PrimaryColumn({ type: "bigint" })
    chat_id!: string;

    @Column({ type: "float", default: 0.7 })
    temperature!: number;

    @Column({ type: "varchar", length: 50, default: "neutral" })
    mood!: string;

    @Column({ type: "int", default: 10 })
    reply_chance!: number; // 0-100 percentage

    @Column({ type: "int", default: 0 })
    message_counter!: number;
}

@Entity("chat_summaries")
export class ChatSummary {
    @PrimaryColumn({ type: "bigint" })
    chat_id!: string;

    @Column({ type: "text" })
    content!: string;

    @UpdateDateColumn()
    updated_at!: Date;
}

@Entity("reminders")
export class Reminder {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: "bigint" })
    chat_id!: string;

    @Column({ type: "bigint" })
    user_id!: string;

    @Column({ type: "text" })
    text!: string;

    @Column({ type: "datetime" })
    due_at!: Date;

    @Column({ type: "boolean", default: false })
    is_sent!: boolean;

    @CreateDateColumn()
    created_at!: Date;
}

// --- DataSource Setup ---

const DB_TYPE = process.env.DB_TYPE || "sqlite";
const isMysql = DB_TYPE === "mysql";

let dataSourceConfig: any;

if (isMysql) {
    dataSourceConfig = {
        type: "mysql",
        host: process.env.DB_HOST || "localhost",
        port: Number(process.env.DB_PORT) || 3306,
        username: process.env.DB_USER || "root",
        password: process.env.DB_PASSWORD || "",
        database: process.env.DB_NAME || "norel_bot",
        charset: "utf8mb4_unicode_ci",
        synchronize: true, // Auto-create tables
        logging: false,
        entities: [User, Fact, History, ChatSettings, Relationship, ChatSummary, Reminder],
    };
} else {
    const DB_PATH = process.env.DB_PATH || path.join("/tmp", "bot_memory.sqlite");
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    console.log(`[DB] Using SQLite at: ${DB_PATH}`);
    dataSourceConfig = {
        type: "sqlite",
        database: DB_PATH,
        synchronize: true,
        logging: false,
        entities: [User, Fact, History, ChatSettings, Relationship, ChatSummary, Reminder],
    };
}

export const AppDataSource = new DataSource(dataSourceConfig);

// Initialize Function
export async function initDB() {
    if (!AppDataSource.isInitialized) {
        await AppDataSource.initialize();
        console.log(`[DB] Connected to ${DB_TYPE} database via TypeORM.`);
    }
}

// --- Helper Functions (Facade) ---

export async function upsertUser(id: number, username: string | undefined, first_name: string) {
    const repo = AppDataSource.getRepository(User);
    const userIdStr = id.toString();
    
    // Check if user exists first to avoid resetting reputation
    const existingUser = await repo.findOneBy({ id: userIdStr });
    
    if (existingUser) {
        // Update only if changed
        if (existingUser.username !== username || existingUser.first_name !== first_name) {
            existingUser.username = username;
            existingUser.first_name = first_name;
            await repo.save(existingUser);
        }
    } else {
        // Create new user
        const newUser = repo.create({
            id: userIdStr,
            username: username,
            first_name: first_name,
            reputation: 0
        });
        await repo.save(newUser);
    }
}

export async function changeReputation(userId: number, amount: number) {
    const repo = AppDataSource.getRepository(User);
    // Increment implementation
    await repo.increment({ id: userId.toString() }, "reputation", amount);
}

export async function getReputation(userId: number): Promise<number> {
    const repo = AppDataSource.getRepository(User);
    const userIdStr = userId.toString();
    const user = await repo.findOneBy({ id: userIdStr });
    const rep = user ? user.reputation : 0;
    console.log(`[DB] Reputation for user ${userIdStr}: ${rep}`);
    return rep;
}

export async function upsertChatSettings(chatId: number, temperature: number, mood: string, replyChance: number) {
    const repo = AppDataSource.getRepository(ChatSettings);
    await repo.upsert(
        { chat_id: chatId.toString(), temperature, mood, reply_chance: replyChance },
        ["chat_id"]
    );
}

export async function getChatSettings(chatId: number): Promise<{ temperature: number, mood: string, reply_chance: number, message_counter: number }> {
    const repo = AppDataSource.getRepository(ChatSettings);
    const settings = await repo.findOneBy({ chat_id: chatId.toString() });
    return settings || { temperature: 0.7, mood: 'neutral', reply_chance: 10, message_counter: 0 };
}

/**
 * Increments the message counter for a chat.
 * Returns true if the bot should reply based on the accumulated "tension".
 */
export async function shouldReplyPassive(chatId: number, increment: number = 1): Promise<boolean> {
    const repo = AppDataSource.getRepository(ChatSettings);
    const chatIdStr = chatId.toString();
    let settings = await repo.findOneBy({ chat_id: chatIdStr });
    
    if (!settings) {
        settings = repo.create({ chat_id: chatIdStr, reply_chance: 10, message_counter: 0 });
    }

    settings.message_counter += increment;
    
    const threshold = 100 / (settings.reply_chance || 1);
    console.log(`[Chat][${chatIdStr}] Counter: ${settings.message_counter}/${threshold.toFixed(1)} (Chance: ${settings.reply_chance}%)`);
    
    if (settings.message_counter >= threshold) {
        // Reset counter but keep the overflow if any
        settings.message_counter = Math.max(0, settings.message_counter - threshold);
        await repo.save(settings);
        return true;
    }

    await repo.save(settings);
    return false;
}

export async function addFact(userId: number, fact: string) {
    const repo = AppDataSource.getRepository(Fact);
    const userIdStr = userId.toString();
    
    // Check for duplicates (within the last 50 facts or similar)
    const existing = await repo.findOneBy({
        user_id: userIdStr,
        fact: fact
    });

    if (existing) {
        console.log(`[DB] Fact already exists for user ${userIdStr}: ${fact.substring(0, 30)}...`);
        return;
    }

    console.log(`[DB] Adding fact for user ${userIdStr}: ${fact.substring(0, 50)}...`);
    await repo.save({
        user_id: userIdStr,
        fact: fact
    });
}

export async function getFacts(userId: number): Promise<string[]> {
    const repo = AppDataSource.getRepository(Fact);
    const userIdStr = userId.toString();
    
    const facts = await repo.find({
        where: { user_id: userIdStr },
        order: { created_at: "DESC" },
        take: 15
    });
    
    console.log(`[DB] Retrieved ${facts.length} facts for user ${userIdStr}`);
    return facts.map(f => f.fact);
}

export async function deleteFact(userId: number, factText: string) {
    const repo = AppDataSource.getRepository(Fact);
    // Find exact match or similar
    await repo.delete({
        user_id: userId.toString(),
        fact: factText
    });
}

export async function addMessage(chatId: number, role: 'user' | 'assistant' | 'system', content: string, name?: string, userId?: number) {
    const repo = AppDataSource.getRepository(History);
    await repo.save({
        chat_id: chatId.toString(),
        user_id: userId ? userId.toString() : undefined,
        role: role,
        name: name,
        content: content
    });
}

export async function getHistory(chatId: number, limit: number = 10): Promise<{ role: string, content: string, name?: string, userId?: string }[]> {
    const repo = AppDataSource.getRepository(History);
    const history = await repo.find({
        where: { chat_id: chatId.toString() },
        order: { id: "DESC" }, // Use ID for strict insertion order
        take: limit
    });
    return history.reverse().map(h => ({
        role: h.role,
        content: h.content,
        name: h.name,
        userId: h.user_id
    }));
}

export async function updateRelationship(chatId: number, userId1: number, userId2: number, affectionDelta: number, status?: string) {
    const repo = AppDataSource.getRepository(Relationship);
    // Sort IDs to ensure consistent pairs using string comparison
    const [id1, id2] = [userId1.toString(), userId2.toString()].sort();
    
    let rel = await repo.findOneBy({
        chat_id: chatId.toString(),
        user_id_1: id1,
        user_id_2: id2
    });

    if (!rel) {
        rel = repo.create({
            chat_id: chatId.toString(),
            user_id_1: id1,
            user_id_2: id2,
            affection: 0
        });
    }

    rel.affection += affectionDelta;
    if (status) rel.status = status;
    
    await repo.save(rel);
}

export async function getRelationships(chatId: number): Promise<Relationship[]> {
    const repo = AppDataSource.getRepository(Relationship);
    return await repo.find({
        where: { chat_id: chatId.toString() }
    });
}

export async function updateChatSummary(chatId: number, content: string) {
    const repo = AppDataSource.getRepository(ChatSummary);
    await repo.upsert(
        { chat_id: chatId.toString(), content },
        ["chat_id"]
    );
}

export async function getChatSummary(chatId: number): Promise<string | null> {
    const repo = AppDataSource.getRepository(ChatSummary);
    const summary = await repo.findOneBy({ chat_id: chatId.toString() });
    return summary ? summary.content : null;
}

export async function getAllUsersInChat(chatId: number): Promise<User[]> {
    const historyRepo = AppDataSource.getRepository(History);
    const userRepo = AppDataSource.getRepository(User);
    
    const userIdsRaw = await historyRepo
        .createQueryBuilder("h")
        .select("DISTINCT h.user_id", "userId")
        .where("h.chat_id = :chatId", { chatId: chatId.toString() })
        .andWhere("h.user_id IS NOT NULL")
        .getRawMany();
    
    const ids = userIdsRaw.map(r => r.userId);
    if (ids.length === 0) return [];

    return await userRepo.createQueryBuilder("u")
        .where("u.id IN (:...ids)", { ids })
        .getMany();
}

export async function getUser(userId: number): Promise<User | null> {
    const repo = AppDataSource.getRepository(User);
    return await repo.findOneBy({ id: userId.toString() });
}

export async function addReminder(chatId: number, userId: number, text: string, dueAt: Date) {
    const repo = AppDataSource.getRepository(Reminder);
    const chatIdStr = chatId.toString();
    const userIdStr = userId.toString();

    // Check if ANY unsent reminder already exists for this user in this chat
    // to prevent spamming reminders for the same person.
    const activeReminder = await repo.findOne({
        where: {
            chat_id: chatIdStr,
            user_id: userIdStr,
            is_sent: false
        }
    });

    if (activeReminder) {
        console.log(`[DB] Active reminder already exists for user ${userIdStr} in chat ${chatIdStr}. Skipping.`);
        return;
    }

    await repo.save({
        chat_id: chatIdStr,
        user_id: userIdStr,
        text: text,
        due_at: dueAt,
        is_sent: false
    });
}

export async function getPendingReminders(): Promise<Reminder[]> {
    const repo = AppDataSource.getRepository(Reminder);
    return await repo.find({
        where: {
            is_sent: false,
            due_at: LessThanOrEqual(new Date())
        }
    });
}

export async function markReminderSent(id: number) {
    const repo = AppDataSource.getRepository(Reminder);
    await repo.update(id, { is_sent: true });
}
