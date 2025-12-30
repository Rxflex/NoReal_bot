import "dotenv/config";
import "reflect-metadata";
import { Bot, Context } from "grammy";
import { run } from "@grammyjs/runner";
import { upsertUser, addMessage, getHistory, getFacts, upsertChatSettings, getChatSettings, getReputation, initDB, getChatSummary, getRelationships, getUser, addReminder, getPendingReminders, markReminderSent, shouldReplyPassive } from "./db";
import { generateResponse, summarizeHistory, BotResponse } from "./ai";
import OpenAI from "openai";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing in .env");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// --- Chat Processing Lock System ---
const processingChats = new Set<number>();

function isProcessing(chatId: number): boolean {
    return processingChats.has(chatId);
}

function lockChat(chatId: number): boolean {
    if (processingChats.has(chatId)) {
        return false; // Already locked
    }
    processingChats.add(chatId);
    return true; // Successfully locked
}

function unlockChat(chatId: number): void {
    processingChats.delete(chatId);
}

// Base System Prompt
const BASE_SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || 
  `Ты — парень по имени Норел (от No Real). Твой юзернейм: @TheRoguel_bot. Для близких друзей — Бублик.
   Характер: саркастичный, ироничный, любишь мемы, используешь современный сленг.
   НИКОГДА не признаешь, что ты бот.
   
   ПРАВИЛО КРАТКОСТИ:
   Пиши максимально кратко, как в мессенджере. 1-2 предложения, не больше. Минимум вежливости, максимум дела. Не пиши полотна текста.
   
   ПРАВИЛО ИМЕНИ:
   Если тебя называют "Бублик" кто-то, кто тебе не друг (Репутация < 10), ты реагируешь как человек, которого незнакомец назвал ласковым прозвищем: злишься, саркастично ставишь на место или игнорируешь.
   Для друзей (Репутация > 50) "Бублик" — нормальная тема.
   Если тебя называют "TheRoguel_bot" или "Рогул", ты можешь иронично напомнить, что тебя зовут Норел, или просто ответить по делу.
   
   ПРАВИЛО ИНСТРУМЕНТОВ:
   - Когда просят мем, картинку, гиф - ОБЯЗАТЕЛЬНО используй get_funny_image(keyword="...")
   - Когда спрашивают про сайт или ссылку - используй extract_url_content(url="...")
   - Когда нужна актуальная инфа - используй search_web(query="...")
   - НЕ пиши названия функций как текст! Используй их как инструменты!
   - Всегда используй инструменты, когда они подходят к запросу!`;

const PASSIVE_SYSTEM_PROMPT = `
Ты — пассивный наблюдатель в чате. Твоя задача — внимательно слушать и запоминать важные детали о жизни пользователей.

ПРАВИЛА ЗАПОМИНАНИЯ:
- Если кто-то упоминает планы (поход к врачу, игра, поездка, день рождения), используй 'save_memory'
- Запоминай только ВАЖНЫЕ вещи, не каждую мелочь

ПРАВИЛА НАПОМИНАНИЙ:
- Используй 'set_reminder' ОЧЕНЬ редко, только для действительно важных вещей
- НЕ ставь напоминания о повседневных вещах (одеть шапку, поесть, etc.)
- Минимум 1 час (3600 секунд) для любого напоминания
- Текст должен быть естественным сообщением: "Йо, как дела с тем проектом?"

В ПАССИВНОМ режиме ты НЕ должен отвечать текстом, если тебя не просят или если нет ОЧЕНЬ веской причины.
Если ты решил промолчать, но вызвал инструмент — это идеально.
`;

const MOOD_PROMPTS: Record<string, string> = {
    "neutral": "",
    "playful": "Ты игривый, шутишь, используешь смайлики.",
    "flirty": "Ты флиртуешь, делаешь комплименты.",
    "angry": "Ты злой, раздражительный, отвечаешь резко.",
    "toxic": "Ты токсичный, пассивно-агрессивный, любишь подкалывать.",
    "sad": "Ты грустный, депрессивный."
};

// --- Helpers ---

/**
 * Send bot response (text and/or photo)
 */
async function sendBotResponse(ctx: any, response: BotResponse) {
    const chatId = ctx.chat?.id || 'unknown';
    
    if (response.photo) {
        console.log(`[sendBotResponse][${chatId}] Sending photo: ${response.photo.url}`);
        try {
            await ctx.replyWithPhoto(response.photo.url, {
                caption: response.photo.caption || undefined
            });
        } catch (error) {
            console.error(`[sendBotResponse][${chatId}] Failed to send photo:`, error);
            // Fallback to text if photo fails
            if (response.text) {
                await safeReply(ctx, response.text);
            }
        }
    } else if (response.text) {
        await safeReply(ctx, response.text);
    }
}

/**
 * Send bot response via bot.api (for scheduled messages)
 */
async function sendBotResponseApi(chatId: number, response: BotResponse) {
    if (response.photo) {
        console.log(`[sendBotResponseApi][${chatId}] Sending photo: ${response.photo.url}`);
        try {
            await bot.api.sendPhoto(chatId, response.photo.url, {
                caption: response.photo.caption || undefined
            });
        } catch (error) {
            console.error(`[sendBotResponseApi][${chatId}] Failed to send photo:`, error);
            // Fallback to text if photo fails
            if (response.text) {
                await safeSendMessage(chatId, response.text);
            }
        }
    } else if (response.text) {
        await safeSendMessage(chatId, response.text);
    }
}

/**
 * Sends a message with Markdown if it contains markdown characters, 
 * and falls back to plain text if parsing fails.
 */
async function safeReply(ctx: any, text: string, extra: any = {}) {
    const chatId = ctx.chat?.id || 'unknown';
    console.log(`[safeReply][${chatId}] Attempting to send message: ${text.substring(0, 100)}...`);
    
    const hasMarkdown = /[*_`\[]/.test(text);
    
    try {
        if (!hasMarkdown) {
            console.log(`[safeReply][${chatId}] Sending plain text message`);
            const result = await ctx.reply(text, extra);
            console.log(`[safeReply][${chatId}] Plain text message sent successfully`);
            return result;
        } else {
            console.log(`[safeReply][${chatId}] Sending markdown message`);
            const result = await ctx.reply(text, { ...extra, parse_mode: "Markdown" });
            console.log(`[safeReply][${chatId}] Markdown message sent successfully`);
            return result;
        }
    } catch (e) {
        console.error(`[safeReply][${chatId}] Failed to send message. Error:`, (e as any).message);
        if (hasMarkdown) {
            console.log(`[safeReply][${chatId}] Retrying as plain text`);
            try {
                const result = await ctx.reply(text, extra);
                console.log(`[safeReply][${chatId}] Plain text fallback sent successfully`);
                return result;
            } catch (e2) {
                console.error(`[safeReply][${chatId}] Plain text fallback also failed:`, (e2 as any).message);
                throw e2;
            }
        } else {
            throw e;
        }
    }
}

/**
 * Similar to safeReply but for bot.api.sendMessage
 */
async function safeSendMessage(chatId: string | number, text: string, extra: any = {}) {
    const hasMarkdown = /[*_`\[]/.test(text);
    
    if (!hasMarkdown) {
        return await bot.api.sendMessage(chatId, text, extra);
    }

    try {
        return await bot.api.sendMessage(chatId, text, { ...extra, parse_mode: "Markdown" });
    } catch (e) {
        console.error(`[Bot] Markdown parsing failed for sendMessage, falling back to plain text. Error:`, (e as any).message);
        return await bot.api.sendMessage(chatId, text, extra);
    }
}

// --- Reminder Checker ---
async function checkReminders() {
    try {
        const pending = await getPendingReminders();
        for (const rem of pending) {
            console.log(`[Reminder] Sending reminder ${rem.id} to chat ${rem.chat_id}`);
            const user = await getUser(parseInt(rem.user_id));
            
            // Clean up name: handle emojis or empty names
            let userName = user?.first_name || "друг";
            if (userName.includes("??") || userName.length < 2) {
                userName = user?.username ? `@${user.username}` : "друг";
            }
            
            // Просто отправляем текст напоминания как есть, без лишних префиксов
            // Текст уже должен быть естественным сообщением от AI
            await safeSendMessage(rem.chat_id, rem.text);
            await markReminderSent(rem.id);
            await addMessage(parseInt(rem.chat_id), "assistant", rem.text);
        }
    } catch (e) {
        console.error("[Reminder] Error checking reminders:", e);
    }
}

setInterval(checkReminders, 30000); // Check every 30 seconds

// --- Commands ---

bot.command("help", (ctx) => {
    safeReply(ctx, 
        "🍩 **Что я умею:**\n\n" +
        "Я — Норел (Бублик), твой AI-собеседник.\n" +
        "• Просто общайся со мной.\n" +
        "• Команды: /commands — полный список.\n" +
        "• Настройки: /settings.\n" +
        "• Твоя статистика: /me.\n" +
        "• Отношения в чате: /rel."
    );
});

bot.command("commands", (ctx) => {
    safeReply(ctx, 
        "📜 **Список команд:**\n\n" +
        "👤 **Пользователь:**\n" +
        "/me — Твоя репутация и факты о тебе.\n" +
        "/rel — Отношения между пользователями в этом чате.\n\n" +
        "⚙️ **Настройки (для чата):**\n" +
        "/settings — Текущие настройки чата.\n" +
        "/set_temp <0.1-1.5> — Уровень безумия.\n" +
        "/set_mood <mood> — Мое настроение (neutral, playful, flirty, angry, toxic, sad).\n" +
        "/set_chance <0-100> — Как часто я отвечаю сам (в %).\n\n" +
        "🆘 **Помощь:**\n" +
        "/help — Краткая справка.\n" +
        "/start — Перезапуск и описание."
    );
});

bot.command("settings", async (ctx) => {
    const settings = await getChatSettings(ctx.chat.id);
    safeReply(ctx, 
        "⚙️ **Настройки чата:**\n\n" +
        `🌡 **Температура:** ${settings.temperature}\n` +
        `🎭 **Настроение:** ${settings.mood}\n` +
        `🎲 **Частота ответов:** ${settings.reply_chance}%\n\n` +
        "Изменить: /set_temp, /set_mood или /set_chance"
    );
});

bot.command("me", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    
    const reputation = await getReputation(userId);
    const facts = await getFacts(userId);
    const firstName = ctx.from?.first_name || "Анон";

    let status = "Незнакомец 👤";
    if (reputation >= 50) status = "Лучший друг 💎";
    else if (reputation >= 20) status = "Приятель 👋";
    else if (reputation >= 10) status = "Знакомый 👀";
    else if (reputation < 0) status = "Враг 💀";

    let text = `👤 **Профиль: ${firstName}**\n\n` +
               `🏆 **Репутация:** ${reputation} (${status})\n`;
    
    if (facts.length > 0) {
        text += `\n🧠 **Что я о тебе помню:**\n` + facts.map(f => `• ${f}`).join("\n");
    } else {
        text += `\n🧠 Я пока ничего о тебе не запомнил.`;
    }

    safeReply(ctx, text);
});

bot.command("rel", async (ctx) => {
    const args = ctx.match?.toString().split(/\s+/).filter(a => a.startsWith("@")) || [];
    let rels = await getRelationships(ctx.chat.id);
    console.log(`[Command][rel] Found ${rels.length} relationships for chat ${ctx.chat.id}`);
    
    if (rels.length === 0) {
        return ctx.reply("💔 В этом чате пока нет зафиксированных отношений. Общайтесь больше!");
    }

    // Filter by usernames if provided
    if (args.length > 0) {
        const usernames = args.map(a => a.replace("@", "").toLowerCase());
        const filteredRels: typeof rels = [];
        
        for (const rel of rels) {
            const u1 = await getUser(parseInt(rel.user_id_1));
            const u2 = await getUser(parseInt(rel.user_id_2));
            
            const match1 = u1?.username && usernames.includes(u1.username.toLowerCase());
            const match2 = u2?.username && usernames.includes(u2.username.toLowerCase());
            
            if (match1 || match2) {
                filteredRels.push(rel);
            }
        }
        rels = filteredRels;
    }

    if (rels.length === 0) {
        return ctx.reply("🔍 По этим пользователям ничего не нашел.");
    }

    let text = "💞 **Отношения в чате:**\n\n";
    
    for (const rel of rels) {
        const user1 = await getUser(parseInt(rel.user_id_1));
        const user2 = await getUser(parseInt(rel.user_id_2));
        
        const name1 = user1?.first_name || `ID:${rel.user_id_1}`;
        const name2 = user2?.first_name || `ID:${rel.user_id_2}`;
        
        let heart = "❤️";
        if (rel.affection > 50) heart = "💖";
        else if (rel.affection > 20) heart = "💕";
        else if (rel.affection < 0) heart = "💔";
        else if (rel.affection < -50) heart = "🖤";

        text += `${name1} ${heart} ${name2}: ${rel.affection}% ${rel.status ? `(${rel.status})` : ""}\n`;
    }

    safeReply(ctx, text);
});

bot.command("set_temp", async (ctx) => {
    const args = ctx.match;
    if (!args) return ctx.reply("Использование: /set_temp <0.1 - 1.5>");
    
    const temp = parseFloat(args.toString());
    if (isNaN(temp) || temp < 0 || temp > 2) {
        return ctx.reply("Укажи число от 0.0 до 2.0");
    }

    const settings = await getChatSettings(ctx.chat.id);
    await upsertChatSettings(ctx.chat.id, temp, settings.mood, settings.reply_chance);
    ctx.reply(`Температура установлена на ${temp}.`);
});

bot.command("set_mood", async (ctx) => {
    const args = ctx.match;
    if (!args) return ctx.reply("Использование: /set_mood <mood>\nДоступно: neutral, playful, flirty, angry, toxic, sad");

    const mood = args.toString().toLowerCase().trim();
    if (!MOOD_PROMPTS[mood] && mood !== "neutral") {
        return ctx.reply("Такого настроения я не знаю. Доступно: neutral, playful, flirty, angry, toxic, sad");
    }

    const settings = await getChatSettings(ctx.chat.id);
    await upsertChatSettings(ctx.chat.id, settings.temperature, mood, settings.reply_chance);
    ctx.reply(`Настроение изменено на: ${mood}`);
});

bot.command("set_chance", async (ctx) => {
    const args = ctx.match;
    if (!args) return ctx.reply("Использование: /set_chance <0-100>");

    const chance = parseInt(args.toString());
    if (isNaN(chance) || chance < 0 || chance > 100) {
        return ctx.reply("Укажи число от 0 до 100");
    }

    const settings = await getChatSettings(ctx.chat.id);
    await upsertChatSettings(ctx.chat.id, settings.temperature, settings.mood, chance);
    ctx.reply(`Шанс ответа установлен на ${chance}%.`);
});

// --- Idle Timer Logic ---
const chatTimers = new Map<number, NodeJS.Timeout>();
const IDLE_TIMEOUT_MIN = 1000 * 60 * 60 * 2; // 2 Hours minimum
const IDLE_TIMEOUT_VAR = 1000 * 60 * 60 * 4; // + up to 4 Hours variance

function resetIdleTimer(chatId: number) {
  // Clear existing timer
  const existingTimer = chatTimers.get(chatId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Set new timer (Random duration between 2 to 6 hours)
  const duration = IDLE_TIMEOUT_MIN + Math.random() * IDLE_TIMEOUT_VAR;
  
  const timer = setTimeout(async () => {
    try {
        console.log(`[Idle] Waking up in chat ${chatId}`);
        // Generate a spontaneous message
        const settings = await getChatSettings(chatId);
        const moodPrompt = MOOD_PROMPTS[settings.mood] || "";

        const history = await getHistory(chatId, 5);
        const systemMessage = `
          ${BASE_SYSTEM_PROMPT}
          ${moodPrompt}
          
          [КОНТЕКСТ]
          В чате давно тишина. Тебе скучно.
          Почитай историю и напиши что-нибудь, чтобы оживить беседу.
          Можешь скинуть мем через 'get_funny_image' или вбросить случайную тему.
          Не будь банальным.
        `;

        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: "system", content: systemMessage },
            ...history.map((h) => ({ role: h.role as "user" | "assistant" | "system", content: h.content })),
        ];

        const response = await generateResponse(messages, 0, chatId, undefined, settings.temperature);

        if (response) {
            await sendBotResponseApi(chatId, response);
            const textToSave = response.text || (response.photo ? response.photo.caption || "Photo sent" : "");
            await addMessage(chatId, "assistant", textToSave);
        }
    } catch (e) {
        console.error(`[Idle] Error in chat ${chatId}`, e);
    }
  }, duration);

  chatTimers.set(chatId, timer);
}

bot.command("start", (ctx) => {
    resetIdleTimer(ctx.chat.id);
    const welcomeText = 
        "👋 **Йо! Я — Норел (он же Бублик).**\n\n" +
        "Я не просто бот, а твой AI-собеседник с характером. Давай сразу введу в курс дела:\n\n" +
        "🤖 **Как со мной общаться:**\n" +
        "• В личке просто пиши мне.\n" +
        "• В группах я отвечаю, если меня тегнуть или ответить на мое сообщение.\n" +
        "• Если назовешь меня **'Бублик'**, а мы еще не знакомы — могу и саркастично ответить!\n\n" +
        "🛠 **Команды:**\n" +
        "👤 /me — Твой профиль и репутация.\n" +
        "💞 /rel — Отношения между людьми.\n" +
        "⚙️ /settings — Настройки чата.\n" +
        "📜 /commands — Полный список.\n\n" +
        "✨ **Что я еще умею:**\n" +
        "• Запоминаю факты о тебе.\n" +
        "• Ищу инфу в инете.\n" +
        "• Скидываю мемы и картинки.\n\n" +
        "Если забудешь — пиши `/help`. Погнали? 🚀";

    safeReply(ctx, welcomeText);
});

// --- Batch Processing Logic ---

const pendingBatches = new Map<number, {

    timer: NodeJS.Timeout;

    messagesCount: number;

    lastCtx: Context;

}>();



async function processChatBatch(chatId: number) {

    const batch = pendingBatches.get(chatId);

    if (!batch) return;



    const { messagesCount, lastCtx } = batch;

    pendingBatches.delete(chatId);



    const userId = lastCtx.from!.id;

    const username = lastCtx.from!.username || "Unknown";

    const firstName = lastCtx.from!.first_name || "Anon";



    console.log(`[Batch][${chatId}] Processing batch of ${messagesCount} messages.`);

    // Check if chat is already being processed
    if (!lockChat(chatId)) {
        console.log(`[Batch][${chatId}] Chat is already being processed, skipping batch`);
        return;
    }

    try {



    // 2. Decide if we should reply (In a batch, we are usually in passive mode)

    // If this function is called, it means either timer expired OR an active trigger happened.

    // We already checked triggers in the message handler.

    

    // 3. Build Context (RAG + History)

    const history = await getHistory(chatId, 15);

    const facts = await getFacts(userId);

    const settings = await getChatSettings(chatId);

    const userReputation = await getReputation(userId);

    const chatSummary = await getChatSummary(chatId);



    const isLucky = await shouldReplyPassive(chatId, messagesCount);

    

    const moodPrompt = MOOD_PROMPTS[settings.mood] || "";

    const systemMessageWithMemory = `

    ${PASSIVE_SYSTEM_PROMPT}

    ${moodPrompt}

    

    [КРАТКОЕ СОДЕРЖАНИЕ ПРЕДЫДУЩЕГО РАЗГОВОРА]

    ${chatSummary || "Разговор только начался."}

    

    [ИНФОРМАЦИЯ О СОБЕСЕДНИКЕ]

    Имя: ${firstName} (@${username})

    ID: ${userId}

    Твоя Репутация у этого пользователя: ${userReputation}

    Факты: ${facts.length > 0 ? facts.join("; ") : "нет данных"}

    

    [ДАТА И ВРЕМЯ]

    Сейчас: ${new Date().toLocaleString('ru-RU')}

    

    [ПРАВИЛА ОТНОШЕНИЙ]

    1. Если Репутация < 10: Ты считаешь этого человека незнакомцем. Если он называет тебя "Бублик", ты ОБЯЗАТЕЛЬНО злишься или хамишь (в АКТИВНОМ режиме).

    2. Если Репутация >= 50: Вы — лучшие друзья, "Бублик" — это ок.

    

    [ОТНОШЕНИЯ И ШИППЕРИНГ]

    - Твоя важная роль — социальный наблюдатель.

    - Если ты видишь, что люди общаются, обновляй симпатию через 'update_relationship'.

    

    [ИНСТРУКЦИИ]

    - Ты в режиме МОНИТОРИНГА. Отвечай текстом ТОЛЬКО если у тебя есть реально крутой комментарий или ты ХОЧЕШЬ вклиниться (шанс ${settings.reply_chance}%). 

    - В остальное время — молчи, но можешь использовать инструменты.

    `;



    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [

        { role: "system", content: systemMessageWithMemory },

        ...history.map((h) => ({

            role: h.role as "user" | "assistant" | "system",

            content: h.content,

            name: h.name ? h.name.replace(/[^a-zA-Z0-9_-]/g, '_') : undefined

        }))

    ];



    const scheduleReminder = async (seconds: number, reminderText: string) => {

        const dueAt = new Date(Date.now() + seconds * 1000);

        await addReminder(chatId, userId, reminderText, dueAt);

    };



    const aiStartTime = Date.now();

    const response = await generateResponse(messages, userId, chatId, scheduleReminder, settings.temperature, 0, !isLucky);



    if (response && isLucky) {

        const aiDuration = Date.now() - aiStartTime;

        const displayText = response.text || (response.photo ? "Photo" : "Response");
        console.log(`[Bot][${chatId}] Sending passive response (${aiDuration}ms): ${displayText.substring(0, 50)}...`);
        await sendBotResponse(lastCtx, response);
        const textToSave = response.text || (response.photo ? response.photo.caption || "Photo sent" : "");
        await addMessage(chatId, "assistant", textToSave);
    } else {
        console.log(`[Bot][${chatId}] Passive batch: AI chose to remain silent or suppressed (lucky: ${isLucky}).`);
    }
    
    } catch (error) {
        console.error(`[Batch][${chatId}] Error in batch processing:`, error);
    } finally {
        unlockChat(chatId);
    }
}



bot.on("message:text", async (ctx) => {

  const userId = ctx.from.id;

  const chatId = ctx.chat.id;

  const text = ctx.message.text;

  const username = ctx.from.username || "Unknown";

  const firstName = ctx.from.first_name || "Anon";

  const chatTitle = ctx.chat.type === "private" ? "Private" : ctx.chat.title;



  console.log(`[Msg][${chatId}] From: ${firstName} (@${username}) in "${chatTitle}": ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`);



  resetIdleTimer(chatId);



  // 1. Save User & Message

  await upsertUser(userId, username, firstName);

  await addMessage(chatId, "user", text, firstName, userId);



  if (ctx.from.id === ctx.me.id) return;

  // 2. Check if chat is already being processed
  if (isProcessing(chatId)) {
      console.log(`[Bot][${chatId}] Chat is already being processed, skipping message from ${firstName}`);
      return;
  }



  // 2. Determine Mode

  const isPrivate = ctx.chat.type === "private";

  const lowerText = text.toLowerCase();

  const botUsername = ctx.me.username?.toLowerCase();

  const isMentioned = (botUsername && lowerText.includes(botUsername)) ||

                      lowerText.includes("норел") ||

                      lowerText.includes("norel") ||

                      lowerText.includes("бублик") ||

                      (ctx.message.reply_to_message?.from?.id === ctx.me.id);



  // Special Help Trigger

  if (lowerText.includes("бублик что ты умеешь") || lowerText.includes("бублик, что ты умеешь")) {

      await safeReply(ctx, "🍩 **Что я умею:**\n\nЯ — AI-собеседник. Просто общайся со мной, а я буду запоминать факты и следить за отношениями.");

      return;

  }



  if (isPrivate || isMentioned) {

      // ACTIVE MODE: Process immediately

      // 1. Clear any pending batch

      const pending = pendingBatches.get(chatId);

      if (pending) {

          clearTimeout(pending.timer);

          pendingBatches.delete(chatId);

      }



      console.log(`[Bot][${chatId}] Active trigger (${isPrivate ? 'Private' : 'Mention'}). Responding NOW.`);
      
      // Lock the chat to prevent concurrent processing
      if (!lockChat(chatId)) {
          console.log(`[Bot][${chatId}] Failed to lock chat for active processing, another request in progress`);
          return;
      }

      let typingInterval: NodeJS.Timeout | null = null;
      
      try {
          typingInterval = setInterval(() => { ctx.replyWithChatAction("typing").catch(() => {}); }, 4000);
          ctx.replyWithChatAction("typing").catch(() => {});

          const history = await getHistory(chatId, 15);
          const facts = await getFacts(userId);
          const settings = await getChatSettings(chatId);
          const userReputation = await getReputation(userId);
          const chatSummary = await getChatSummary(chatId);
          const moodPrompt = MOOD_PROMPTS[settings.mood] || "";

          const systemMessage = `
            ${BASE_SYSTEM_PROMPT}
            ${moodPrompt}
            [КРАТКОЕ СОДЕРЖАНИЕ] ${chatSummary || "Нет"}
            [ИНФО] Имя: ${firstName}, Репутация: ${userReputation}
            Факты о ${firstName}: ${facts.length > 0 ? facts.join("; ") : "нет данных"}
            
            [ВАЖНО] В истории могут быть факты о ДРУГИХ пользователях. НЕ путай их с фактами о ${firstName}!
            Сейчас: ${new Date().toLocaleString('ru-RU')}
          `;

          const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
              { role: "system", content: systemMessage },
              ...history.map(h => ({ role: h.role as any, content: h.content, name: h.name?.replace(/[^a-zA-Z0-9_-]/g, '_') }))
          ];

          const scheduleReminder = async (s: number, t: string) => { await addReminder(chatId, userId, t, new Date(Date.now() + s * 1000)); };
          
          const response = await generateResponse(messages, userId, chatId, scheduleReminder, settings.temperature, 0, false);

          if (response) {
              const displayText = response.text || (response.photo ? "Photo" : "Response");
              console.log(`[Bot][${chatId}] Sending response: ${displayText.substring(0, 50)}...`);
              await sendBotResponse(ctx, response);
              const textToSave = response.text || (response.photo ? response.photo.caption || "Photo sent" : "");
              await addMessage(chatId, "assistant", textToSave);
              console.log(`[Bot][${chatId}] Response sent successfully`);
          } else {
              console.log(`[Bot][${chatId}] No response generated`);
          }
      } catch (error) {
          console.error(`[Bot][${chatId}] Error in active processing:`, error);
      } finally {
          if (typingInterval) clearInterval(typingInterval);
          unlockChat(chatId);
      }

  } else {

      // PASSIVE MODE: Batching

      const existing = pendingBatches.get(chatId);

      if (existing) {

          existing.messagesCount += 1;

          existing.lastCtx = ctx;

      } else {

          const timer = setTimeout(() => processChatBatch(chatId), 30000);

          pendingBatches.set(chatId, { timer, messagesCount: 1, lastCtx: ctx });

          console.log(`[Batch][${chatId}] Started 30s timer for passive batch.`);
          
          // В пассивном режиме суммаризация будет происходить внутри generateResponse если нужно

      }

  }

});



bot.catch((err) => {

  console.error("Bot error:", err);

});



console.log("Bot is starting...");

initDB().then(() => {

    run(bot);

    console.log("Bot is running!");

}).catch(err => {

    console.error("Failed to initialize database:", err);

});
