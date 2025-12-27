import "reflect-metadata";
import { DataSource, Entity, PrimaryColumn, Column, PrimaryGeneratedColumn, CreateDateColumn, ManyToOne, JoinColumn } from "typeorm";
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
        entities: [User, Fact, History, ChatSettings, Relationship],
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
        entities: [User, Fact, History, ChatSettings, Relationship],
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
    const user = new User();
    user.id = id.toString();
    user.username = username || undefined; // undefined makes TypeORM skip/set null depending on config, but here manual assign is safer
    user.first_name = first_name;
    
    // TypeORM upsert is handy
    // We want to preserve reputation if it exists, so we just save.
    // However, save() might overwrite reputation to default if we pass a new object without it?
    // Let's use upsert with conflict paths.
    
    await repo.upsert(
        { id: id.toString(), username: username, first_name: first_name },
        ["id"]
    );
}

export async function changeReputation(userId: number, amount: number) {
    const repo = AppDataSource.getRepository(User);
    // Increment implementation
    await repo.increment({ id: userId.toString() }, "reputation", amount);
}

export async function getReputation(userId: number): Promise<number> {
    const repo = AppDataSource.getRepository(User);
    const user = await repo.findOneBy({ id: userId.toString() });
    return user ? user.reputation : 0;
}

export async function upsertChatSettings(chatId: number, temperature: number, mood: string) {
    const repo = AppDataSource.getRepository(ChatSettings);
    await repo.upsert(
        { chat_id: chatId.toString(), temperature, mood },
        ["chat_id"]
    );
}

export async function getChatSettings(chatId: number): Promise<{ temperature: number, mood: string }> {
    const repo = AppDataSource.getRepository(ChatSettings);
    const settings = await repo.findOneBy({ chat_id: chatId.toString() });
    return settings || { temperature: 0.7, mood: 'neutral' };
}

export async function addFact(userId: number, fact: string) {
    const repo = AppDataSource.getRepository(Fact);
    await repo.save({
        user_id: userId.toString(),
        fact: fact
    });
}

export async function getFacts(userId: number): Promise<string[]> {
    const repo = AppDataSource.getRepository(Fact);
    const facts = await repo.find({
        where: { user_id: userId.toString() },
        order: { created_at: "DESC" },
        take: 10
    });
    return facts.map(f => f.fact);
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
