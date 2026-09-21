import createClient from "openapi-fetch";
import type { components, paths } from "./generated/datadash.ts";

/**
 * Datadash's REST API (docs.datadash.xyz), typed from its OpenAPI spec. `openapi/datadash.json` is a pinned copy
 * of https://docs.datadash.xyz/openapi.json; `pnpm gen:api` regenerates `src/generated/datadash.ts` from it, so an
 * API change shows up as a spec diff and a type error rather than a failure at runtime.
 *
 * Every list endpoint is a POST whose body takes filter / orderBy / page and whose answer is an array of rows,
 * with linked entities (`user`, `token`, `market`, `event`) filled in on each row.
 */
export type Schemas = components["schemas"];

/** The list endpoints: every POST path that answers with an array of rows. */
export type ListPath = {
  [P in keyof paths]: paths[P] extends {
    post: { responses: { 200: { content: { "application/json": unknown[] } } } };
  }
    ? P
    : never;
}[keyof paths];

type Post<P extends ListPath> = NonNullable<paths[P]["post"]>;
export type ListBody<P extends ListPath> = NonNullable<Post<P>["requestBody"]>["content"]["application/json"];
export type ListRow<P extends ListPath> = Post<P>["responses"][200]["content"]["application/json"][number];

export type Datadash = {
  list<P extends ListPath>(path: P, body: ListBody<P>): Promise<ListRow<P>[]>;
};

/**
 * The read endpoints are public; the key is sent when there is one (`X-Api-Key`), so the agent keeps working if
 * Datadash starts to require it or applies per-key limits.
 */
export type ClientOptions = {
  /** Per attempt. A 1000-row activity page can take most of a minute when the API is busy. */
  timeoutMs?: number;
  /** Retries after the first attempt, for timeouts, network errors, 429 and 5xx. Other 4xx never retry. */
  retries?: number;
  /** Wait before retry n (0-based); `retries` entries are used. */
  backoffMs?: number[];
};

class RetryableError extends Error {}

export function createDatadash(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  { timeoutMs = 90_000, retries = 2, backoffMs = [2_000, 10_000] }: ClientOptions = {},
): Datadash {
  const client = createClient<paths>({
    baseUrl: baseUrl.replace(/\/+$/, ""),
    headers: apiKey ? { "X-Api-Key": apiKey } : {},
    fetch: fetchImpl,
  });
  // openapi-fetch cannot narrow a generic path; `list`'s own signature carries the types for callers.
  const post = client.POST as (
    path: string,
    init: { body: unknown; signal: AbortSignal },
  ) => Promise<{ data?: unknown; error?: unknown; response: Response }>;

  const attempt = async (path: string, body: unknown) => {
    let result: Awaited<ReturnType<typeof post>>;
    try {
      result = await post(path, { body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      // fetch only says "fetch failed"; the cause (DNS, refused, timeout) is what explains it.
      const cause = (error as { cause?: unknown }).cause;
      throw new RetryableError(
        `Datadash ${path} request failed: ${(error as Error).message}${cause ? ` (${String((cause as Error).message ?? cause)})` : ""}`,
        { cause: error },
      );
    }
    const { data, error, response } = result;
    if (error !== undefined || !response.ok) {
      const message = `Datadash ${path} returned ${response.status}: ${JSON.stringify(error).slice(0, 300)}`;
      throw response.status === 429 || response.status >= 500 ? new RetryableError(message) : new Error(message);
    }
    if (!Array.isArray(data)) throw new Error(`Datadash ${path} did not return a list`);
    return data;
  };

  return {
    async list(path, body) {
      for (let n = 0; ; n++) {
        try {
          return (await attempt(path, body)) as ListRow<typeof path>[];
        } catch (error) {
          if (!(error instanceof RetryableError) || n >= retries) throw error;
          await new Promise((resolve) => setTimeout(resolve, backoffMs[n] ?? backoffMs.at(-1) ?? 0));
        }
      }
    },
  };
}

/**
 * A token the API filled in on a row, with its optional fields settled in one place. Null when the row has no
 * token or the token has no position id, so callers decide whether that is an error or a row to skip.
 */
export type Token = {
  positionId: number;
  marketId: number | null;
  eventId: number | null;
  marketQuestion: string;
  marketSlug: string;
  eventSlug: string;
  tokenName: string;
  tokenId: string;
  tokenPrice: number;
  marketClosed: boolean;
  marketClosedTime: string | null;
  marketEndDate: string | null;
  /** The spec says numbers; the API sends strings. Kept as sent. */
  tagIds: (string | number)[];
};

export function readToken(token: Schemas["TokenLookup"] | undefined): Token | null {
  if (token?.positionId === undefined) return null;
  return {
    positionId: token.positionId,
    marketId: token.marketId ?? null,
    eventId: token.eventId ?? null,
    marketQuestion: token.marketQuestion ?? "",
    marketSlug: token.marketSlug ?? "",
    eventSlug: token.eventSlug ?? "",
    tokenName: token.tokenName ?? "",
    tokenId: token.tokenId ?? "",
    tokenPrice: Number(token.tokenPrice),
    marketClosed: token.marketClosed === true,
    marketClosedTime: token.marketClosedTime ?? null,
    marketEndDate: token.marketEndDate ?? null,
    tagIds: token.tagIds ?? [],
  };
}
