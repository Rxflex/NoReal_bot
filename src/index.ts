import { Bot, Context } from "grammy";
import { upsertUser, addMessage, getHistory, getFacts, upsertChatSettings, getChatSettings } from "./db";
import { generateResponse } from "./ai";
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
   Ты ведешь себя как человек, никогда не признаешь, что ты бот. 
   Твой характер: саркастичный, смешной, любишь мемы, используешь сленг.
   Ты общаешься на русском языке.
   
   ВАЖНОЕ ПРАВИЛО:
   Если тебя называет "Бублик" кто-то, кого ты не считаешь другом (в твоей памяти нет информации, что это друг), ты должен смешно разозлиться или обидеться. Фразы вроде: "Э, мы еще не пили на брудершафт!", "Какой я тебе Бублик? Я Норел!", "За Бублика ответишь".
   Если пишет друг, реагируй тепло.
   
   Проявляй интерес к собеседнику, запоминай детали.`;

const MOOD_PROMPTS: Record<string, string> = {
    "neutral": "",
    "playful": "Ты очень игривый, постоянно шутишь, используешь смайлики и флиртуешь (в меру).",
    "flirty": "Ты откровенно флиртуешь, делаешь комплименты, ведешь себя как ловелас.",
    "angry": "Ты злой, раздражительный, отвечаешь резко. Тебя все бесит.",
    "toxic": "Ты токсичный, пассивно-агрессивный, любишь подкалывать и унижать (в шутку, но обидно).",
    "sad": "Ты грустный, депрессивный, ноешь о жизни."
};

// --- Commands ---

bot.command("help", (ctx) => {
    ctx.reply(
        "🍩 **Что я умею:**\n\n" +
        "Я — Норел (Бублик), твой AI-собеседник.\n" +
        "• Просто общайся со мной.\n" +
        "• Если назовешь меня 'Бублик', можем поссориться (если мы не друзья).\n\n" +
        "**Настройки (для этого чата):**\n" +
        "/set_temp <0.0-1.5> — Меняет градус безумия (температуру). Чем выше, тем более я непредсказуемый.\n" +
        "/set_mood <mood> — Меняет мое настроение.\n" +
        "Доступные настроения: neutral, playful, flirty, angry, toxic, sad."
    , { parse_mode: "Markdown" });
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
const chatTimers = new Map<number, Timer>();
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

        const responseText = await generateResponse(messages, 0, undefined, settings.temperature);

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
        "• В группах я отвечаю, если меня тегнуть, ответить на мое сообщение или просто с шансом 10%.\n" +
        "• Если назовешь меня **'Бублик'**, а мы еще не знакомы — могу и саркастично ответить!\n\n" +
        "🛠 **Настройки этого чата:**\n" +
        "Каждый чат настраивается отдельно (команды ниже):\n" +
        "🌡 `/set_temp <0.1-1.5>` — Настройка 'безумия'. 0.1 — я сама серьезность, 1.5 — я несу полную дичь.\n" +
        "🎭 `/set_mood <настроение>` — Мой вайб. Доступно: `neutral`, `playful` (игривый), `flirty` (флирт), `angry` (злой), `toxic` (токсик), `sad` (нытик).\n\n" +
        "✨ **Что я еще умею:**\n" +
        "• Запоминаю факты о тебе (просто рассказывай что-нибудь).\n" +
        "• Ищу инфу в инете.\n" +
        "• Скидываю мемы и картинки.\n" +
        "• Ставлю напоминалки.\n\n" +
        "Если забудешь — пиши `/help` или спрашивай **'Бублик, что ты умеешь?'**. Погнали? 🚀";

    ctx.reply(welcomeText, { parse_mode: "Markdown" });
});

bot.on("message:text", async (ctx) => {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const text = ctx.message.text;
  const username = ctx.from.username || "Unknown";
  const firstName = ctx.from.first_name || "Anon";

  // Reset the idle timer whenever there is activity
  resetIdleTimer(chatId);

  // 1. Save User & Message
  await upsertUser(userId, username, firstName);
  await addMessage(chatId, "user", text);

  // Prevent bot from replying to itself (Infinite loop protection)
  if (ctx.from.id === ctx.me.id) {
      return;
  }

  // 2. Decide if we should reply
  const isPrivate = ctx.chat.type === "private";
  
  // Triggers: Mentions, Name calls, Reply to bot
  const lowerText = text.toLowerCase();
  const isMentioned = lowerText.includes("theroguel_bot") || 
                      lowerText.includes("норел") || 
                      lowerText.includes("norel") || 
                      lowerText.includes("бублик") || 
                      (ctx.message.reply_to_message?.from?.id === bot.botInfo.id);
  
  // Handle "what can you do" natural query
  if (lowerText.includes("бублик что ты умеешь") || lowerText.includes("бублик, что ты умеешь")) {
      await ctx.reply(
        "🍩 **Что я умею:**\n\n" +
        "Я — Норел (Бублик), твой AI-собеседник.\n" +
        "• Просто общайся со мной.\n" +
        "• Если назовешь меня 'Бублик', можем поссориться (если мы не друзья).\n\n" +
        "**Настройки (для этого чата):**\n" +
        "/set_temp <0.0-1.5> — Меняет градус безумия (температуру). Чем выше, тем более я непредсказуемый.\n" +
        "/set_mood <mood> — Меняет мое настроение.\n" +
        "Доступные настроения: neutral, playful, flirty, angry, toxic, sad."
      , { parse_mode: "Markdown" });
      return;
  }

  const randomChance = Math.random() < 0.10; // 10% chance to reply spontaneously in groups

  if (!isPrivate && !isMentioned && !randomChance) {
    return;
  }

  // 3. Build Context (RAG + History)
  const history = await getHistory(chatId, 10); // Last 10 messages
  const facts = await getFacts(userId); // Retrieved memories
  const settings = await getChatSettings(chatId);
  const moodPrompt = MOOD_PROMPTS[settings.mood] || "";
  
  const systemMessageWithMemory = `
    ${BASE_SYSTEM_PROMPT}
    ${moodPrompt}
    
    [ИНФОРМАЦИЯ О СОБЕСЕДНИКЕ (${firstName} @${username})]
    ${facts.length > 0 ? facts.join("\n") : "Пока ничего конкретного не знаешь."} 
    
    [ИНСТРУКЦИИ]
    - Если пользователь сообщил новый факт о себе (имя, город, хобби), сохрани это через 'save_memory'.
    - Если просят напомнить о чем-то, используй 'set_reminder'.
    - Если просят картинку/мем, используй 'get_funny_image'.
    - Отвечай кратко, в стиле переписки в чате.
  `;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemMessageWithMemory },
    ...history.map((h) => ({ role: h.role as "user" | "assistant", content: h.content })),
    { role: "user", content: text } // Ensure current message is at the end
  ];

  // 4. Generate Response
  await ctx.replyWithChatAction("typing");
  
  const scheduleReminder = (seconds: number, reminderText: string) => {
      console.log(`[Reminder] Scheduled in ${seconds}s: ${reminderText}`);
      setTimeout(() => {
          bot.api.sendMessage(chatId, `⏰ Эй, ${firstName}, напоминаю: ${reminderText}`)
             .catch(e => console.error("Failed to send reminder:", e));
      }, seconds * 1000);
  };

  const responseText = await generateResponse(messages, userId, scheduleReminder, settings.temperature);

  // 5. Send Response & Save to History
  if (responseText) {
      try {
        await ctx.reply(responseText, { parse_mode: "Markdown" });
      } catch (e) {
        console.error("Failed to send markdown, falling back to text:", e);
        await ctx.reply(responseText); // Fallback if markdown is broken
      }
      await addMessage(chatId, "assistant", responseText as string);
  } else {
      await ctx.reply("System error: 502 Bad Gateway (AI Server is down or rejecting requests). Try again later.");
  }
});

bot.catch((err) => {
  console.error("Bot error:", err);
});

console.log("Bot is running...");
bot.start();