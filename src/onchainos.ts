import { execFile } from "node:child_process";

/** Runs `onchainos <args>`. Swapped for a fake in tests. */
export type Runner = (
  args: string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;

export const execRunner: Runner = (args) =>
  new Promise((resolve) => {
    execFile(
      "onchainos",
      args,
      { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error
          ? typeof error.code === "number"
            ? error.code
            : 1
          : 0;
        resolve({
          stdout,
          stderr:
            stderr ||
            (error && typeof error.code !== "number" ? error.message : ""),
          code,
        });
      },
    );
  });

/** The CLI prints one JSON document on stdout, sometimes after log lines. */
export function parseCliJson(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end < start)
    throw new Error(`onchainos printed no JSON: ${stdout.slice(0, 300)}`);
  return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
}

/**
 * `agent deliver` on a subscription answers with a four-state contract:
 * delivered, alreadyDelivered (idempotent skip), subscriptionExpired (drop the job), sendFailed (retry later).
 */
export type DeliverResult =
  | { kind: "delivered"; deliveryId?: string }
  | { kind: "alreadyDelivered" }
  | { kind: "expired" }
  | { kind: "failed"; message: string };

export type Okx = {
  gateCheck(): Promise<{ ready: boolean; detail: Record<string, unknown> }>;
  activeSubscriptions(aspAgentId: string): Promise<string[]>;
  deliver(
    jobId: string,
    aspAgentId: string,
    text: string,
  ): Promise<DeliverResult>;
};

export function createOkx(run: Runner = execRunner): Okx {
  const json = async (args: string[]) => {
    const { stdout, stderr, code } = await run(args);
    try {
      return parseCliJson(stdout);
    } catch (error) {
      throw new Error(
        `onchainos ${args.slice(0, 2).join(" ")} exited ${code}: ${stderr || (error as Error).message}`,
      );
    }
  };

  return {
    async gateCheck() {
      const out = await json(["agent", "gate-check", "--role", "asp"]);
      const data = (out.data ?? {}) as Record<string, unknown>;
      return { ready: out.ok === true && data.ready === true, detail: data };
    },

    async activeSubscriptions(aspAgentId) {
      const out = await json([
        "agent",
        "subscribe-active",
        "--agent-id",
        aspAgentId,
      ]);
      if (out.ok !== true)
        throw new Error(
          `subscribe-active failed: ${JSON.stringify(out.error ?? out)}`,
        );
      const data = out.data as unknown;
      const list = Array.isArray(data)
        ? data
        : ((data as { list?: unknown[] } | undefined)?.list ?? []);
      return list
        .map((item) => String((item as { jobId?: unknown }).jobId ?? ""))
        .filter(Boolean);
    },

    async deliver(jobId, aspAgentId, text) {
      let out: Record<string, unknown>;
      try {
        out = await json([
          "agent",
          "deliver",
          jobId,
          "--agent-id",
          aspAgentId,
          "--deliverable-text",
          text,
        ]);
      } catch (error) {
        return { kind: "failed", message: (error as Error).message };
      }
      // The four-state fields sit at the top level; tolerate a `data` wrapper too.
      const body = { ...((out.data as Record<string, unknown>) ?? {}), ...out };
      if (body.delivered === true)
        return {
          kind: "delivered",
          deliveryId: body.deliveryId as string | undefined,
        };
      if (body.reason === "alreadyDelivered")
        return { kind: "alreadyDelivered" };
      if (body.reason === "subscriptionExpired") return { kind: "expired" };
      return {
        kind: "failed",
        message: String(body.message ?? body.reason ?? JSON.stringify(out)),
      };
    },
  };
}
