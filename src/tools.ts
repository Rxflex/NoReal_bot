// tools.ts
// Real implementation of tools (no mocks)

type DuckDuckGoResponse = {
  AbstractText?: string;
  RelatedTopics?: Array<{
    Text?: string;
    FirstURL?: string;
    Topics?: Array<{
      Text?: string;
      FirstURL?: string;
    }>;
  }>;
};

type GiphyResponse = {
  data: Array<{
    images: {
      original: {
        url: string;
      };
    };
  }>;
};

/**
 * Web search using DuckDuckGo Instant Answer API
 * No API key required
 */
export async function searchWeb(query: string): Promise<string> {
  console.log(`[Tool] Searching web for: ${query}`);

  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Search failed with status ${response.status}`);
  }

  const data = (await response.json()) as DuckDuckGoResponse;

  const results: string[] = [];

  if (data.AbstractText) {
    results.push(`Summary: ${data.AbstractText}`);
  }

  if (data.RelatedTopics?.length) {
    for (const topic of data.RelatedTopics) {
      if (topic.Text && topic.FirstURL) {
        results.push(`• ${topic.Text} — ${topic.FirstURL}`);
      }

      if (topic.Topics) {
        for (const sub of topic.Topics) {
          if (sub.Text && sub.FirstURL) {
            results.push(`• ${sub.Text} — ${sub.FirstURL}`);
          }
        }
      }
    }
  }

  if (!results.length) {
    return `No meaningful results found for "${query}".`;
  }

  return results.slice(0, 5).join("\n");
}

/**
 * Get a funny image or gif using Giphy search
 * Requires GIPHY_API_KEY
 */
export async function getFunnyImage(query: string = "funny"): Promise<string> {
  console.log(`[Tool] Getting funny image for: ${query}`);

  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) {
    throw new Error("GIPHY_API_KEY is not set");
  }

  const url = new URL("https://api.giphy.com/v1/gifs/search");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "25");
  url.searchParams.set("rating", "pg");

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Giphy API error: ${response.status}`);
  }

  const data = (await response.json()) as GiphyResponse;

  if (!data.data.length) {
    throw new Error(`No funny images found for "${query}"`);
  }

  const randomIndex = Math.floor(Math.random() * data.data.length);
  return data.data[randomIndex].images.original.url;
}
