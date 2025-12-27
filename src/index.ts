import "reflect-metadata";
import { Bot, Context } from "grammy";
import { upsertUser, addMessage, getHistory, getFacts, upsertChatSettings, getChatSettings, getReputation, initDB, getChatSummary, getRelationships, getUser, addReminder, getPendingReminders, markReminderSent } from "./db";
import { generateResponse, summarizeHistory } from "./ai";
import OpenAI from "openai";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing in .env");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// Base System Prompt
const BASE_SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || 
  `Ты — парень по имени Норел (от No Real). Для близких друзей — Бублик.
   Характер: саркастичный, ироничный, любишь мемы, используешь современный сленг.
   НИКОГДА не признаешь, что ты бот.
   
   ПРАВИЛО КРАТКОСТИ:
   Пиши максимально кратко, как в мессенджере. 1-2 предложения, не больше. Минимум вежливости, максимум дела. Не пиши полотна текста.
   
   ПРАВИЛО ИМЕНИ:
   Если тебя называет "Бублик" кто-то, кто тебе не друг (Репутация < 10), ты реагируешь как человек, которого незнакомец назвал ласковым прозвищем: злишься, саркастично ставишь на место или игнорируешь.
   Для друзей (Репутация > 50) "Бублик" — нормальная тема.`;

const PASSIVE_SYSTEM_PROMPT = `
Ты — пассивный наблюдатель в чате. Твоя задача — внимательно слушать и запоминать важные детали о жизни пользователей.
Если кто-то упоминает планы (поход к врачу, игра, поездка, день рождения), используй 'save_memory', чтобы это не забыть.
Если ты видишь, что кто-то договорился о чем-то в будущем, ты МОЖЕШЬ поставить себе напоминание через 'set_reminder', чтобы потом спросить, как все прошло.
В ПАССИВНОМ режиме ты НЕ должен отвечать текстом, если тебя не просят или если нет ОЧЕНЬ веской причины вклиниться (например, тебя напрямую спросили или происходит что-то супер-интересное).
Если ты решил промолчать, но вызвал инструмент — это идеально.
Твоя цель — быть полезным и внимательным другом, который все помнит.
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
 * Sends a message with Markdown if it contains markdown characters, 
 * and falls back to plain text if parsing fails.
 */
async function safeReply(ctx: any, text: string, extra: any = {}) {
    const hasMarkdown = /[*_`\[]/.test(text);
    
    if (!hasMarkdown) {
        return await ctx.reply(text, extra);
    }

    try {
        return await ctx.reply(text, { ...extra, parse_mode: "Markdown" });
    } catch (e) {
        console.error(`[Bot] Markdown parsing failed for message, falling back to plain text. Error:`, (e as any).message);
        return await ctx.reply(text, extra);
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
            const userName = user?.first_name || "друг";
            
            const text = `⏰ **Напоминалка для ${userName}**\n\n${rem.text}`;
            await safeSendMessage(rem.chat_id, text);
            await markReminderSent(rem.id);
            await addMessage(parseInt(rem.chat_id), "assistant", `[Напоминание]: ${rem.text}`);
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
        "/set_mood <mood> — Мое настроение (neutral, playful, flirty, angry, toxic, sad).\n\n" +
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
        `🎭 **Настроение:** ${settings.mood}\n\n` +
        "Изменить: /set_temp или /set_mood"
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
    await upsertChatSettings(ctx.chat.id, temp, settings.mood);
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
    await upsertChatSettings(ctx.chat.id, settings.temperature, mood);
    ctx.reply(`Настроение изменено на: ${mood}`);
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
            ...history.map((h) => ({ role: h.role as "user" | "assistant", content: h.content })),
        ];

        const responseText = await generateResponse(messages, 0, chatId, undefined, settings.temperature);

        if (responseText) {
            await bot.api.sendMessage(chatId, responseText as string);
            await addMessage(chatId, "assistant", responseText as string);
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

bot.on("message:text", async (ctx) => {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const text = ctx.message.text;
  const username = ctx.from.username || "Unknown";
  const firstName = ctx.from.first_name || "Anon";
  const chatTitle = ctx.chat.type === "private" ? "Private" : ctx.chat.title;

  console.log(`[Msg][${chatId}] From: ${firstName} (@${username}) in "${chatTitle}": ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`);

  // Reset the idle timer whenever there is activity
  resetIdleTimer(chatId);

  // 1. Save User & Message
  await upsertUser(userId, username, firstName);
  await addMessage(chatId, "user", text, firstName, userId);

  // Prevent bot from replying to itself (Infinite loop protection)
  if (ctx.from.id === ctx.me.id) {
      return;
  }

  // 2. Decide if we should reply
  const isPrivate = ctx.chat.type === "private";
  
  // Triggers: Mentions, Name calls, Reply to bot
  const lowerText = text.toLowerCase();
  const botUsername = ctx.me.username?.toLowerCase();
  const isMentioned = (botUsername && lowerText.includes(botUsername)) || 
                      lowerText.includes("норел") || 
                      lowerText.includes("norel") || 
                      lowerText.includes("бублик") || 
                      (ctx.message.reply_to_message?.from?.id === ctx.me.id);
  
  // Handle "what can you do" natural query
  if (lowerText.includes("бублик что ты умеешь") || lowerText.includes("бублик, что ты умеешь")) {
      console.log(`[Bot][${chatId}] Triggered help/capabilities info`);
      await safeReply(ctx, 
        "🍩 **Что я умею:**\n\n" +
        "Я — Норел (Бублик), твой AI-собеседник.\n" +
        "• Просто общайся со мной.\n" +
        "• Если назовешь меня 'Бублик', можем поссориться (если мы не друзья).\n" +
        "**Настройки (для этого чата):**\n" +
        "/set_temp <0.0-1.5> — Меняет градус безумия.\n" +
        "/set_mood <mood> — Меняет мое настроение.\n" +
        "**Отношения:**\n" +
        "• Я слежу за тем, кто как с кем общается.\n" +
        "• Могу шипперить пользователей.\n" +
        "• Твоя репутация влияет на мой тон."
      );
      return;
  }

  const randomChance = Math.random() < 0.08; // 8% chance to reply spontaneously in groups
  let reason = "";
  let isPassive = false;

  if (isPrivate) {
      reason = "Private chat";
  } else if (isMentioned) {
      reason = "Mentioned/Reply";
  } else {
      reason = "Passive monitoring";
      isPassive = true;
  }

  console.log(`[Bot][${chatId}] Processing message. Mode: ${isPassive ? 'Passive' : 'Active'} (${reason}). Chance to reply: ${isPassive ? (randomChance ? 'YES' : 'NO') : 'N/A'}`);

  // 3. Build Context (RAG + History)
  const history = await getHistory(chatId, 15); // Slightly more history for context
  const facts = await getFacts(userId); 
  const settings = await getChatSettings(chatId);
  const userReputation = await getReputation(userId);
  const chatSummary = await getChatSummary(chatId);

  const moodPrompt = MOOD_PROMPTS[settings.mood] || "";
  
  const systemMessageWithMemory = `
    ${isPassive ? PASSIVE_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT}
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
    - Ты следишь за взаимодействием людей. Используй 'update_relationship', если видишь химию или конфликты.
    
    [ИНСТРУКЦИИ]
    - Если пользователь сообщил новый факт о себе или своих планах (куда-то идет, что-то делает), сохрани это через 'save_memory'.
    - Если информация устарела, неверна или пользователь попросил что-то забыть, используй 'delete_memory'.
    - Если кто-то планирует что-то в будущем (врач, игра, встреча), ОБЯЗАТЕЛЬНО поставь себе напоминание 'set_reminder', чтобы спросить об этом позже. 
    - В АКТИВНОМ режиме отвечай кратко (1-2 предложения).
    - В ПАССИВНОМ режиме (когда тебя не звали) ты должен быть тихим. Используй инструменты молча. Отвечай текстом ТОЛЬКО если у тебя есть реально крутой комментарий или ты ХОЧЕШЬ вклиниться в беседу (шанс 5-10%). В остальное время — молчи.
  `;

  // Trigger background summarization if history is long (approx. every 10-15 messages)
  // We check the history from DB directly for total count or just use a random chance/threshold
  if (history.length >= 10 && Math.random() < 0.2) {
      const fullHistory = await getHistory(chatId, 20);
      summarizeHistory(chatId, fullHistory.map(h => ({ 
          role: h.role as any, 
          content: h.content, 
          name: h.name?.replace(/[^a-zA-Z0-9_-]/g, '_') 
      }))).catch(e => console.error("Background summary error:", e));
  }

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemMessageWithMemory },
    ...history.map((h) => ({ 
        role: h.role as "user" | "assistant", 
        content: h.content, 
        name: h.name ? h.name.replace(/[^a-zA-Z0-9_-]/g, '_') : undefined // OpenAI name validation
    }))
  ];

  // 4. Generate Response
  // Loop typing action to keep it active during long generations
  let typingInterval: NodeJS.Timeout | undefined;
  if (!isPassive) {
      typingInterval = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 4000);
      ctx.replyWithChatAction("typing").catch(() => {}); // Initial call
  }
  
  const scheduleReminder = async (seconds: number, reminderText: string) => {
      console.log(`[Bot][${chatId}] Saving reminder in ${seconds}s: ${reminderText}`);
      const dueAt = new Date(Date.now() + seconds * 1000);
      await addReminder(chatId, userId, reminderText, dueAt);
  };

  let responseText: string | null = null;
  const aiStartTime = Date.now();
  try {
      responseText = await generateResponse(messages, userId, chatId, scheduleReminder, settings.temperature);
  } finally {
      if (typingInterval) clearInterval(typingInterval);
  }

  // 5. Send Response & Save to History
  if (responseText) {
      if (isPassive && !randomChance) {
          console.log(`[Bot][${chatId}] Passive mode: AI generated response but suppressed by random chance.`);
          return;
      }

      const aiDuration = Date.now() - aiStartTime;
      console.log(`[Bot][${chatId}] Sending response (${aiDuration}ms): ${responseText.substring(0, 50)}...`);
      await safeReply(ctx, responseText);
      await addMessage(chatId, "assistant", responseText as string);
  } else {
      if (!isPassive) {
          console.error(`[Bot][${chatId}] AI failed to generate response in active mode`);
          await ctx.reply("System error: AI failed to respond. Try again later.");
      } else {
          console.log(`[Bot][${chatId}] Passive mode: AI chose to remain silent.`);
      }
  }
});

bot.catch((err) => {

  console.error("Bot error:", err);

});



console.log("Bot is starting...");

initDB().then(() => {

    bot.start();

    console.log("Bot is running!");

}).catch(err => {

    console.error("Failed to initialize database:", err);

});
