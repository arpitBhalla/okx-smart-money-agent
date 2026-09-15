import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** The two Datadash MCP tools this agent needs. Table and field names come from the server's get_schema. */
export type Datadash = {
  queryTable(
    table: string,
    request: object,
  ): Promise<Record<string, unknown>[]>;
  queryLookup(
    table: string,
    field: string,
    request: object,
  ): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
};

export async function connectDatadash(
  url: string,
  apiKey: string,
): Promise<Datadash> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { "X-Api-Key": apiKey } },
  });
  const client = new Client({
    name: "okx-smart-money-agent",
    version: "0.1.0",
  });
  await client.connect(transport);

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = Array.isArray(result.content)
      ? result.content
          .filter(
            (part): part is { type: "text"; text: string } =>
              part?.type === "text",
          )
          .map((part) => part.text)
          .join("")
      : "";
    if (result.isError)
      throw new Error(`Datadash ${name} failed: ${text || "no message"}`);
    const payload = (result.structuredContent ?? JSON.parse(text)) as {
      rows?: Record<string, unknown>[];
    };
    return payload.rows ?? [];
  };

  return {
    queryTable: (table, request) => call("query_table", { table, request }),
    queryLookup: (table, field, request) =>
      call("query_lookup", { table, field, request }),
    close: () => client.close(),
  };
}
