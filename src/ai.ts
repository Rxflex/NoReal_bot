import OpenAI from "openai";
import { searchWeb, getFunnyImage } from "./tools";
import { addFact, changeReputation, updateRelationship, getRelationships, getAllUsersInChat, getUser } from "./db";

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

    return fetch(url, { ...init, headers });
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
      description: "Get a funny image, meme, or specific picture based on a keyword.",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "Keyword for the image (e.g., 'cat', 'fail', 'morning')." },
        },
        required: ["keyword"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_memory",
      description: "Save a specific fact about the user to long-term memory. Use this when the user tells you their name, preferences, job, location, etc.",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string", description: "The clear, concise fact to remember (e.g., 'User loves pizza', 'User is named Alex')." },
        },
        required: ["fact"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_reminder",
      description: "Set a reminder for the user. Calculate the delay in seconds based on their request (e.g. 'in 1 hour' = 3600).",
      parameters: {
        type: "object",
        properties: {
          seconds: { type: "number", description: "Delay in seconds." },
          text: { type: "string", description: "The reminder message to send." },
        },
        required: ["seconds", "text"],
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

export async function generateResponse(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  userId: number,
  chatId: number,
  onReminder?: (seconds: number, text: string) => void,
  temperature: number = 0.7,
  depth: number = 0
) {
  const startTime = Date.now();
  if (depth > 5) {
      console.warn(`[AI][${chatId}] Max recursion depth reached.`);
      return "Уф, я немного запутался. Давай попробуем еще раз.";
  }

  try {
    const response = await client.chat.completions.create({
      model: "minimaxai/minimax-m2",
      messages: messages,
      tools: tools,
      tool_choice: "auto",
      temperature: temperature,
    });

    const duration = Date.now() - startTime;
    const message = response.choices[0]?.message;
    if (!message) return null;

    console.log(`[AI][${chatId}] Response received in ${duration}ms (Depth: ${depth})`);

    let content = message.content || "";
    let toolCalls = message.tool_calls || [];

    // --- Fallback: Parse text-based tool calls if any (for models like DeepSeek/Llama) ---
    // Matches: <function(name){"arg":"val"}></function> or <function(name)>{"arg":"val"}</function>
    const toolRegex = /<function\((\w+)\)>(.*?)<\/function>|<function\((\w+)\)({.*?})<\/function>/gs;
    
    let match;
    while ((match = toolRegex.exec(content)) !== null) {
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
        console.error("[AI] Failed to parse text-based tool call:", e);
      }
    }
    
    // Remove tool call tags and thinking blocks from content to keep it clean for the user
    content = content.replace(/<\|python_tag\|>/g, "");
    content = content.replace(/<function\(.*?\)>.*?<\/function>/gs, "");
    content = content.replace(/<function\(.*?\){.*?}<\/function>/gs, "");
    content = content.replace(/<think>.*?<\/think>/gs, "");
    content = content.trim();

    // Handle Tool Calls
    if (toolCalls.length > 0) {
      // Add the assistant's tool-call message to history to maintain context
      messages.push({ ...message, content: content || null, tool_calls: toolCalls as any });

      for (const toolCall of toolCalls) {
        if (toolCall.type !== 'function') continue;

        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        let result: string;

        console.log(`[AI][${chatId}] Tool Call: ${fnName}`, args);
        const toolStartTime = Date.now();

        if (fnName === "search_web") {
          result = await searchWeb(args.query || args.keyword || args.q);
        } else if (fnName === "get_funny_image") {
          result = await getFunnyImage(args.keyword || args.query || args.q);
        } else if (fnName === "save_memory") {
          addFact(userId, args.fact || args.memory || args.text);
          result = `Memory saved: ${args.fact || args.memory || args.text}`;
        } else if (fnName === "set_reminder") {
          const seconds = args.seconds || args.time || args.delay;
          const text = args.text || args.message || args.reminder;
          if (onReminder && typeof seconds === 'number' && text) {
             onReminder(seconds, text);
             result = `Timer set for ${seconds} seconds.`;
          } else {
             result = `Error: Missing parameters for reminder (seconds: ${seconds}, text: ${text})`;
          }
        } else if (fnName === "change_user_reputation") {
            const targetId = parseInt(args.user_id);
            await changeReputation(targetId, args.amount);
            result = `Reputation of user ${targetId} changed by ${args.amount}. Reason: ${args.reason}`;
        } else if (fnName === "update_relationship") {
            const id1 = parseInt(args.user_id_1);
            const id2 = parseInt(args.user_id_2);
            await updateRelationship(chatId, id1, id2, args.affection_delta, args.status);
            result = `Relationship between ${id1} and ${id2} updated (delta: ${args.affection_delta}).`;
        } else if (fnName === "get_chat_info") {
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
        console.log(`[AI][${chatId}] Tool Finish: ${fnName} in ${toolDuration}ms`);

        messages.push({
          tool_call_id: (toolCall as any).id,
          role: "tool",
          content: result,
        });
      }

      // Recursively call for the final answer after tool outputs
      return await generateResponse(messages, userId, chatId, onReminder, temperature, depth + 1);
    }

    return content || message.content;
  } catch (error) {
    console.error("AI Error:", error);
    return null;
  }
}
