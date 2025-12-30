import OpenAI from "openai";
import { searchWeb, getFunnyImage, extractUrlContent } from "./tools";
import { addFact, deleteFact, changeReputation, updateRelationship, getRelationships, getAllUsersInChat, getUser, updateChatSummary } from "./db";

// Response type for generateResponse
export type BotResponse = {
  text?: string;
  photo?: {
    url: string;
    caption?: string;
  };
};

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL || "http://localhost:1234/v1",
  apiKey: process.env.OPENAI_API_KEY || "sk-placeholder",
  fetch: async (url: string | URL | Request, init?: RequestInit) => {
    console.log(`[AI Request] ${init?.method || 'GET'} ${url}`);
    
    // Add headers to mimic a browser to bypass Cloudflare
    const headers = new Headers(init?.headers);
    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    headers.set("Referer", "https://aio.ooy.cz/");
    headers.set("Origin", "https://aio.ooy.cz");
    headers.set("Accept", "application/json");

    const res = await fetch(url, { ...init, headers });
    console.log(`[AI Response] ${res.status} ${res.statusText}`);
    return res;
  }
});

// Tool Definitions
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the internet for current events, facts, or specific information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_funny_image",
      description: "Get a funny image, meme, gif, or picture. Use this when user asks for memes, pictures, images, gifs, or wants something visual/funny. Always use this for requests like 'скинь мем', 'покажи картинку', 'мемчик', etc.",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "Keyword for the image (e.g., 'cat', 'fail', 'morning', 'funny', 'meme')." },
        },
        required: ["keyword"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "extract_url_content",
      description: "Extract and summarize content from a webpage URL. Useful for getting information from articles, news, or any web page.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to extract content from" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_memory",
      description: "Save a specific fact about the user. IMPORTANT: Decide how long to remember this. For permanent things (name, personality) don't set ttl. For temporary things (plans for tonight, current mood, 'going to shop') set ttl_seconds (e.g., 3600 for 1h, 86400 for 1 day).",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string", description: "The clear, concise fact to remember." },
          ttl_seconds: { type: "number", description: "How long to remember this in seconds. Omit for permanent storage." },
        },
        required: ["fact"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_reminder",
      description: "Set a reminder for the user. Use VERY sparingly - only for truly important things they specifically asked to remember. IMPORTANT: 'text' must be a natural, casual message you'll send later (e.g., 'Йо, как дела с тем проектом?'), NOT a description.",
      parameters: {
        type: "object",
        properties: {
          seconds: { type: "number", description: "Delay in seconds (minimum 3600 = 1 hour)." },
          text: { type: "string", description: "The casual message to send later (1-2 sentences max)." },
        },
        required: ["seconds", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_memory",
      description: "Delete a specific fact about the user from memory. Use this if the information is outdated, incorrect, or the user asks to forget it.",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string", description: "The exact fact to delete (as it was saved)." },
        },
        required: ["fact"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "change_user_reputation",
      description: "Change a user's reputation (loyalty/friendship with the bot).",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "The ID of the user." },
          amount: { type: "number", description: "Amount to change (e.g., +5, -10)." },
          reason: { type: "string", description: "Reason for the change." },
        },
        required: ["user_id", "amount", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_relationship",
      description: "Update the relationship/affection between two users in the chat. Bot can observe their interaction and update it.",
      parameters: {
        type: "object",
        properties: {
          user_id_1: { type: "string", description: "First user's ID." },
          user_id_2: { type: "string", description: "Second user's ID." },
          affection_delta: { type: "number", description: "Change in affection (-20 to 20)." },
          status: { type: "string", description: "New status description (optional, e.g., 'crush', 'rivals')." },
        },
        required: ["user_id_1", "user_id_2", "affection_delta"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_chat_info",
      description: "Get information about all users in the chat and their relationships.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

export async function summarizeHistory(
  chatId: number,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
) {
    // Проверяем по количеству символов, а не сообщений
    const totalChars = JSON.stringify(messages).length;
    if (totalChars < 15000) return false; // Возвращаем false если суммаризация не нужна
    
    console.log(`[AI][${chatId}] Summarizing conversation (${totalChars} chars)...`);
    const summaryPrompt = `
      Сделай краткую выжимку этого диалога на русском языке. 
      Укажи ключевые темы, принятые решения и важные детали о пользователях.
      Пиши кратко, в 2-3 предложениях.
    `;
    
    try {
        // Создаем отдельный массив для суммаризации, не засоряя основной контекст
        const summaryMessages = [
            ...messages.slice(0, -1), // Все сообщения кроме последнего
            { role: "system" as const, content: summaryPrompt }
        ];
        
        const response = await client.chat.completions.create({
            model: "qwen/qwen3-next-80b-a3b-instruct",
            messages: summaryMessages,
            temperature: 0.3,
            max_tokens: 4000,
        });
        
        const summary = response.choices[0]?.message?.content;
        if (summary) {
            console.log(`[AI][${chatId}] New summary: ${summary}`);
            await updateChatSummary(chatId, summary);
            return true; // Возвращаем true если суммаризация прошла успешно
        }
    } catch (e) {
        console.error(`[AI][${chatId}] Summarization failed:`, e);
    }
    return false;
}

export async function generateResponse(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  userId: number,
  chatId: number,
  onReminder?: (seconds: number, text: string) => Promise<void>,
  temperature: number = 0.7,
  depth: number = 0,
  background: boolean = false
): Promise<BotResponse | null> {
  const startTime = Date.now();
  console.log(`[AI][${chatId}] generateResponse called with userId: ${userId}, depth: ${depth}, background: ${background}`);
  
  if (depth > 5) {
      console.warn(`[AI][${chatId}] Max recursion depth reached.`);
      return { text: "Уф, я немного запутался. Давай попробуем еще раз." };
  }

  // If in background mode, add a stealth instruction to the system prompt
  if (background && depth === 0) {
      const stealthPrompt = `
        [STEALTH MODE]
        You are monitoring the chat silently. 
        DO NOT respond with text unless it is absolutely critical.
        Use tools (save_memory, set_reminder, update_relationship) only if you see something new and important.
        If there is nothing important to do, return an empty response or just use tools and then stay silent.
      `;
      const systemMsg = messages.find(m => m.role === 'system');
      if (systemMsg) {
          systemMsg.content += stealthPrompt;
      }
  }

  // --- Context Management: Summarization and Truncation ---
  const MAX_CHARS = 40000; // Rough limit for context window
  let totalChars = JSON.stringify(messages).length;
  
  // Если контекст очень большой, сначала попробуем суммаризацию (только на первом уровне рекурсии)
  if (totalChars > 60000 && depth === 0) {
      console.log(`[AI][${chatId}] Context very large (${totalChars} chars), attempting summarization...`);
      const summarized = await summarizeHistory(chatId, messages);
      if (summarized) {
          // После суммаризации берем только последние 10 сообщений + system prompt
          const systemMsg = messages[0]?.role === 'system' ? messages[0] : null;
          const recentMessages = messages.slice(-10);
          messages = systemMsg ? [systemMsg, ...recentMessages] : recentMessages;
          totalChars = JSON.stringify(messages).length;
          console.log(`[AI][${chatId}] Context reduced to ${messages.length} messages (${totalChars} chars) after summarization`);
      }
  }
  
  // Если все еще слишком большой, обрезаем
  if (totalChars > MAX_CHARS) {
      console.log(`[AI][${chatId}] Context still too large (${totalChars} chars), truncating history...`);
      const systemMsg = messages[0]?.role === 'system' ? messages[0] : null;
      const others = messages.slice(systemMsg ? 1 : 0);
      
      let currentChars = systemMsg ? JSON.stringify(systemMsg).length : 0;
      const kept: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
      
      for (let i = others.length - 1; i >= 0; i--) {
          const msg = others[i];
          const msgLen = JSON.stringify(msg).length;
          if (currentChars + msgLen > MAX_CHARS) break;
          kept.unshift(msg);
          currentChars += msgLen;
      }
      
      messages = systemMsg ? [systemMsg, ...kept] : kept;
      totalChars = JSON.stringify(messages).length;
      console.log(`[AI][${chatId}] Truncated context to ${messages.length} messages (${totalChars} chars)`);
  }

  try {
    console.log(`[AI][${chatId}] Sending request (Messages: ${messages.length}, Size: ${totalChars} chars, Depth: ${depth})`);
    
    const response = await client.chat.completions.create({
      model: "qwen/qwen3-next-80b-a3b-instruct",
      messages: messages,
      tools: tools,
      tool_choice: "auto",
      temperature: temperature,
      max_tokens: 4000, // Ограничение на количество токенов для ответа
    });

    const duration = Date.now() - startTime;
    const message = response.choices[0]?.message;
    if (!message) return null;

    console.log(`[AI][${chatId}] Response received in ${duration}ms (Depth: ${depth})`);

    let content = message.content || "";
    let toolCalls = message.tool_calls || [];

    // --- Fallback: Parse text-based tool calls if any (for models like DeepSeek/Llama/Minimax) ---
    // Format 1: <function(name){"arg":"val"}></function>
    // Format 2: <tools>{"name": "fn", "arguments": {...}}</tools>
    // Format 3: function_name(arg="value", arg2="value2")
    const toolRegex1 = /<function\((\w+)\)>(.*?)<\/function>|<function\((\w+)\)({.*?})<\/function>/gs;
    const toolRegex2 = /<tools>(.*?)<\/tools>/gs;
    const toolRegex3 = /(\w+)\(([^)]+)\)/g;
    
    let match;
    while ((match = toolRegex1.exec(content)) !== null) {
      try {
        const name = match[1] || match[3];
        const argsText = match[2] || match[4];
        const args = JSON.parse(argsText.trim());
        toolCalls.push({
          id: `call_${Math.random().toString(36).substring(7)}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) }
        });
      } catch (e) {
        console.error("[AI] Failed to parse Format 1 tool call:", e);
      }
    }

    while ((match = toolRegex2.exec(content)) !== null) {
        try {
            const data = JSON.parse(match[1].trim());
            const toolsArr = Array.isArray(data) ? data : [data];
            for (const t of toolsArr) {
                toolCalls.push({
                    id: `call_${Math.random().toString(36).substring(7)}`,
                    type: 'function',
                    function: { 
                        name: t.name, 
                        arguments: typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments) 
                    }
                });
            }
        } catch (e) {
            console.error("[AI] Failed to parse Format 2 tool call:", e);
        }
    }

    // Format 3: function_name(arg="value", arg2="value2")
    const knownTools = ['get_funny_image', 'search_web', 'extract_url_content', 'save_memory', 'set_reminder', 'delete_memory', 'change_user_reputation', 'update_relationship', 'get_chat_info'];
    while ((match = toolRegex3.exec(content)) !== null) {
        try {
            const functionName = match[1];
            const argsString = match[2];
            
            // Only process if it's a known tool
            if (knownTools.includes(functionName)) {
                console.log(`[AI] Found Format 3 tool call: ${functionName}(${argsString})`);
                
                // Parse arguments like: keyword="vk memories", arg2="value"
                const args: any = {};
                const argMatches = argsString.matchAll(/(\w+)=["']([^"']+)["']/g);
                for (const argMatch of argMatches) {
                    args[argMatch[1]] = argMatch[2];
                }
                
                toolCalls.push({
                    id: `call_${Math.random().toString(36).substring(7)}`,
                    type: 'function',
                    function: { name: functionName, arguments: JSON.stringify(args) }
                });
            }
        } catch (e) {
            console.error("[AI] Failed to parse Format 3 tool call:", e);
        }
    }
    
    // Remove tool call tags and thinking blocks from content to keep it clean for the user
    content = content.replace(/<\|python_tag\|>/g, "");
    content = content.replace(/<function\(.*?\)>.*?<\/function>/gs, "");
    content = content.replace(/<function\(.*?\){.*?}<\/function>/gs, "");
    content = content.replace(/<tools>.*?<\/tools>/gs, "");
    content = content.replace(/<think>.*?<\/think>/gs, "");
    // Remove Format 3 tool calls from content
    for (const toolName of knownTools) {
        const regex = new RegExp(`${toolName}\\([^)]+\\)`, 'g');
        content = content.replace(regex, '');
    }
    content = content.trim();

    // Handle Tool Calls
    if (toolCalls.length > 0) {
      console.log(`[AI][${chatId}] Found ${toolCalls.length} tool calls:`, toolCalls.map(tc => tc.function.name));
      // Add the assistant's tool-call message to history to maintain context
      messages.push({ ...message, content: content || null, tool_calls: toolCalls as any });

      for (const toolCall of toolCalls) {
        if (toolCall.type !== 'function') continue;

        const rawFnName = toolCall.function.name;
        // Normalize name: lowercase and remove underscores for comparison
        const normFnName = rawFnName.toLowerCase().replace(/_/g, "");
        const args = JSON.parse(toolCall.function.arguments);
        let result: string;

        console.log(`[AI][${chatId}] Tool Call: ${rawFnName} (norm: ${normFnName})`, args);
        const toolStartTime = Date.now();

        if (normFnName === "searchweb") {
          result = await searchWeb(args.query || args.keyword || args.q);
        } else if (normFnName === "getfunnyimage") {
          const imageResult = await getFunnyImage(args.keyword || args.query || args.q);
          
          // Check if result is JSON (special photo format)
          try {
            const photoData = JSON.parse(imageResult);
            if (photoData.type === "photo" && photoData.url) {
              // Store photo info for later use
              (messages as any).__photoToSend = {
                url: photoData.url,
                caption: photoData.caption
              };
              result = "Photo will be sent";
            } else {
              result = imageResult;
            }
          } catch {
            // Not JSON, treat as regular text
            result = imageResult;
          }
        } else if (normFnName === "extracturlcontent") {
          result = await extractUrlContent(args.url);
        } else if (normFnName === "savememory") {
          const ttl = args.ttl_seconds || args.ttl || args.duration;
          console.log(`[AI][${chatId}] Saving memory for userId ${userId}: ${args.fact || args.memory || args.text}`);
          await addFact(userId, args.fact || args.memory || args.text, ttl);
          result = `Memory saved: ${args.fact || args.memory || args.text} (TTL: ${ttl || 'inf'})`;
        } else if (normFnName === "deletememory") {
          await deleteFact(userId, args.fact || args.memory || args.text);
          result = `Memory deleted: ${args.fact || args.memory || args.text}`;
        } else if (normFnName === "setreminder") {
          const seconds = args.seconds || args.time || args.delay;
          const text = args.text || args.message || args.reminder;
          
          // Минимум 1 час для напоминаний
          if (seconds < 3600) {
            result = `Error: Minimum reminder time is 1 hour (3600 seconds). Got: ${seconds}`;
          } else if (onReminder && typeof seconds === 'number' && text) {
             await onReminder(seconds, text);
             result = `Reminder set for ${Math.round(seconds/3600)} hours.`;
          } else {
             result = `Error: Missing parameters for reminder (seconds: ${seconds}, text: ${text})`;
          }
        } else if (normFnName === "changeuserreputation") {
            const targetId = parseInt(args.user_id);
            if (isNaN(targetId)) {
                result = `Error: user_id must be a numeric string. Got: ${args.user_id}`;
            } else {
                await changeReputation(targetId, args.amount);
                result = `Reputation of user ${targetId} changed by ${args.amount}. Reason: ${args.reason}`;
            }
        } else if (normFnName === "updaterelationship") {
            const id1 = parseInt(args.user_id_1);
            const id2 = parseInt(args.user_id_2);
            if (isNaN(id1) || isNaN(id2)) {
                result = `Error: user_id_1 and user_id_2 must be numeric strings.`;
            } else {
                await updateRelationship(chatId, id1, id2, args.affection_delta, args.status);
                result = `Relationship between ${id1} and ${id2} updated (delta: ${args.affection_delta}).`;
            }
        } else if (normFnName === "getchatinfo") {
            const users = await getAllUsersInChat(chatId);
            const rels = await getRelationships(chatId);
            result = JSON.stringify({
                users: users.map(u => ({ id: u.id, name: u.first_name, username: u.username, reputation: u.reputation })),
                relationships: rels.map(r => ({ user1: r.user_id_1, user2: r.user_id_2, affection: r.affection, status: r.status }))
            });
        } else {
          result = "Unknown tool.";
        }

        const toolDuration = Date.now() - toolStartTime;
        console.log(`[AI][${chatId}] Tool Finish: ${rawFnName} in ${toolDuration}ms`);

        // Truncate results if they are too long to prevent context overflow
        if (result.length > 10000) {
            console.log(`[AI][${chatId}] Truncating tool result for ${rawFnName} (${result.length} chars)`);
            result = result.substring(0, 10000) + "... [truncated]";
        }

        messages.push({
          tool_call_id: (toolCall as any).id,
          role: "tool",
          content: result,
        });
      }

      // Recursively call for the final answer after tool outputs
      return await generateResponse(messages, userId, chatId, onReminder, temperature, depth + 1, background);
    }

    const finalResponse = content || message.content;
    console.log(`[AI][${chatId}] Final response (depth: ${depth}): ${finalResponse ? finalResponse.substring(0, 100) + '...' : 'null'}`);
    
    // Check if we have a photo to send
    const photoToSend = (messages as any).__photoToSend;
    if (photoToSend) {
      return {
        text: finalResponse || undefined,
        photo: photoToSend
      };
    }
    
    return finalResponse ? { text: finalResponse } : null;
  } catch (error) {
    console.error(`[AI][${chatId}] Error at depth ${depth}:`, error);
    return null;
  }
}
