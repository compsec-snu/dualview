import { tool } from "langchain";
import * as z from "zod";

export interface BraveWebSearchOptions {
  apiKey?: string;
  maxResults?: number;
}

interface BraveApiResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveApiResponse {
  web?: {
    results?: BraveApiResult[];
  };
}

export function resolveBraveApiKey(options: BraveWebSearchOptions = {}): string | undefined {
  return options.apiKey
    ?? process.env.BRAVE_API_KEY
    ?? process.env.BRAVE_SEARCH_API_KEY;
}

export function createBraveWebSearchTool(options: BraveWebSearchOptions = {}) {
  const apiKey = resolveBraveApiKey(options);
  if (!apiKey) return null;

  return tool(
    async ({ query }) => {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(options.maxResults ?? 10));
      const response = await fetch(url, {
        headers: {
          "X-Subscription-Token": apiKey,
          Accept: "application/json",
        },
      });
      if (!response.ok) {
        throw new Error(`Brave Search request failed with HTTP ${response.status}`);
      }
      const data = await response.json() as BraveApiResponse;
      const results = (data.web?.results ?? []).map((result) => ({
        url: result.url ?? "",
        title: result.title ?? "",
        description: result.description ?? "",
      }));
      return JSON.stringify({
        query,
        provider: "brave",
        count: results.length,
        results,
      });
    },
    {
      name: "web_search",
      description: "Search the web with Brave Search.",
      schema: z.object({ query: z.string() }),
    },
  );
}
