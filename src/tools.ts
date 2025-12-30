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
  const imageUrl = data.data[randomIndex].images.original.url;
  
  // Return special format that will be processed by the bot
  return JSON.stringify({
    type: "photo",
    url: imageUrl,
    caption: "Вот. Кот пишет код. Ты — не первый, кто плачет от этого...."
  });
}

/**
 * Extract content from a URL - scrapes webpage and extracts useful information
 * Uses got-scraping for better success with protected sites
 */
export async function extractUrlContent(url: string): Promise<string> {
  console.log(`[Tool] Extracting content from URL: ${url}`);

  try {
    // Dynamic import for ES module
    const { gotScraping } = await import('got-scraping');
    
    const response = await gotScraping({
      url: url,
      timeout: {
        request: 10000, // 10 second timeout
      },
      retry: {
        limit: 2,
      },
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });

    const html = response.body;
    
    // Extract useful content using simple regex patterns
    const extractedData: any = {};

    // Title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      extractedData.title = titleMatch[1].trim().replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ');
    }

    // Meta description
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i);
    if (descMatch) {
      extractedData.description = descMatch[1].trim().replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ');
    }

    // Open Graph data
    const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i);
    if (ogTitleMatch) {
      extractedData.ogTitle = ogTitleMatch[1].trim().replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ');
    }

    const ogDescMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i);
    if (ogDescMatch) {
      extractedData.ogDescription = ogDescMatch[1].trim().replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ');
    }

    const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i);
    if (ogImageMatch) {
      extractedData.ogImage = ogImageMatch[1].trim();
    }

    // Extract main content (simplified approach)
    // Remove script and style tags
    let cleanHtml = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    cleanHtml = cleanHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    cleanHtml = cleanHtml.replace(/<!--[\s\S]*?-->/gi, '');
    
    // Extract text from common content containers
    const contentPatterns = [
      /<article[^>]*>([\s\S]*?)<\/article>/gi,
      /<main[^>]*>([\s\S]*?)<\/main>/gi,
      /<div[^>]*class=["'][^"']*content[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
      /<div[^>]*class=["'][^"']*post[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
      /<div[^>]*class=["'][^"']*description[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
      /<section[^>]*>([\s\S]*?)<\/section>/gi,
    ];

    let mainContent = '';
    for (const pattern of contentPatterns) {
      const matches = cleanHtml.match(pattern);
      if (matches && matches.length > 0) {
        mainContent = matches[0];
        break;
      }
    }

    // If no structured content found, try to extract from body
    if (!mainContent) {
      const bodyMatch = cleanHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/gi);
      if (bodyMatch && bodyMatch.length > 0) {
        mainContent = bodyMatch[0];
      }
    }

    if (mainContent) {
      // Strip HTML tags and clean up
      mainContent = mainContent.replace(/<[^>]+>/g, ' ');
      mainContent = mainContent.replace(/&[^;]+;/g, ' '); // Remove HTML entities
      mainContent = mainContent.replace(/\s+/g, ' ').trim();
      // Limit to first 1500 characters
      if (mainContent.length > 1500) {
        mainContent = mainContent.substring(0, 1500) + '...';
      }
      extractedData.content = mainContent;
    }

    // Format the result
    const result = [];
    
    if (extractedData.title || extractedData.ogTitle) {
      result.push(`**Заголовок:** ${extractedData.ogTitle || extractedData.title}`);
    }
    
    if (extractedData.description || extractedData.ogDescription) {
      result.push(`**Описание:** ${extractedData.ogDescription || extractedData.description}`);
    }
    
    if (extractedData.ogImage) {
      result.push(`**Изображение:** ${extractedData.ogImage}`);
    }
    
    if (extractedData.content && extractedData.content.length > 50) {
      result.push(`**Содержимое:** ${extractedData.content}`);
    }

    if (result.length === 0) {
      return `Не удалось извлечь полезную информацию с ${url}`;
    }

    return result.join('\n\n');

  } catch (error) {
    console.error(`[Tool] Error extracting content from ${url}:`, error);
    
    // Fallback to regular fetch if got-scraping fails
    try {
      console.log(`[Tool] Trying fallback fetch for ${url}`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const html = await response.text();
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim().replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ') : null;
        
        if (title) {
          return `**Заголовок:** ${title}\n\n*Получено через резервный метод*`;
        }
      }
    } catch (fallbackError) {
      console.error(`[Tool] Fallback also failed for ${url}:`, fallbackError);
    }
    
    // More specific error messages
    if (error instanceof Error) {
      if (error.message.includes('403')) {
        return `Сайт ${url} заблокировал доступ (403 Forbidden). Возможно, нужна авторизация или сайт защищен от ботов.`;
      } else if (error.message.includes('404')) {
        return `Страница ${url} не найдена (404).`;
      } else if (error.message.includes('timeout')) {
        return `Превышено время ожидания при загрузке ${url}.`;
      } else {
        return `Ошибка при загрузке ${url}: ${error.message}`;
      }
    }
    
    return `Неизвестная ошибка при обработке ${url}`;
  }
}
