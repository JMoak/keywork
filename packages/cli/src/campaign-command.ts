import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { campaignEventSchema, campaignSchema, createCampaignRequestSchema } from "@keywork/engine";
import { readServerTicket, type ServerTicket, sseFrames } from "@keywork/server";
import { type CommandIo, resolveCommandIo } from "./command-io.ts";
import { exitCodes } from "./dispatch.ts";
import { workspaceIdentity } from "./paths.ts";
import { ticketFilesFor } from "./serve.ts";

export interface CampaignCommandOptions {
  cwd: string;
  workspaceSlug?: string | undefined;
  userRoot?: string | undefined;
  file?: string | undefined;
  after?: string | undefined;
  json?: boolean | undefined;
  signal?: AbortSignal | undefined;
  fetch?: typeof fetch;
}

export const campaignCommandUsage =
  "keywork campaign list | create --file <json> | show <id> | watch <id> [--after <sequence>] [--json] | command <id> --file <json> | export <id> <artifactId> <destination>";

export async function campaignCommand(
  args: readonly string[],
  options: CampaignCommandOptions,
  io: CommandIo = {},
): Promise<number> {
  const output = resolveCommandIo(io);
  let token: string | undefined;
  try {
    const action = await prepareAction(args, options);
    const ticket = await scopedTicket(options);
    token = ticket.token;
    if (action.kind === "watch") return await watchCampaign(action, ticket, options, output);
    const result = await requestJson(ticket, action.path, action.method, action.body, options);
    output.print(JSON.stringify(result, null, options.json === true ? undefined : 2));
    return exitCodes.completed;
  } catch (cause) {
    if (options.signal?.aborted && !(cause instanceof CampaignOutcomeUnknownError))
      return exitCodes.interrupted;
    const message = cause instanceof Error ? cause.message : String(cause);
    output.printError(
      `keywork campaign: ${token === undefined ? message : message.replaceAll(token, "[redacted]")}`,
    );
    if (cause instanceof CampaignCommandUsageError) return exitCodes.usage;
    if (cause instanceof CampaignHttpError)
      return cause.status === 401 || cause.status === 403
        ? exitCodes.denied
        : cause.status === 409
          ? exitCodes.unresolved
          : exitCodes.failed;
    if (cause instanceof CampaignOutcomeUnknownError) return exitCodes.unresolved;
    return exitCodes.failed;
  }
}

type CampaignAction =
  | { kind: "request"; method: "GET" | "POST"; path: string; body?: unknown }
  | { kind: "watch"; id: string; after: number };

class CampaignCommandUsageError extends Error {}
class CampaignOutcomeUnknownError extends Error {}
class CampaignHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function prepareAction(
  args: readonly string[],
  options: CampaignCommandOptions,
): Promise<CampaignAction> {
  const [verb = "list", id, artifactId, destination] = args;
  const arity = { list: 1, create: 1, show: 2, watch: 2, command: 2, export: 4 }[verb];
  if (arity === undefined || (args.length !== arity && !(verb === "list" && args.length === 0)))
    throw new CampaignCommandUsageError(campaignCommandUsage);
  if (options.file !== undefined && verb !== "create" && verb !== "command")
    throw new CampaignCommandUsageError("--file belongs to campaign create or command");
  if (options.after !== undefined && verb !== "watch")
    throw new CampaignCommandUsageError("--after belongs to campaign watch");
  if (verb === "list") return { kind: "request", method: "GET", path: "/campaigns" };
  if (verb === "create") {
    const parsed = createCampaignRequestSchema.safeParse(await jsonFile(options));
    if (!parsed.success)
      throw new CampaignCommandUsageError(
        `Invalid create body: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
      );
    return { kind: "request", method: "POST", path: "/campaigns", body: parsed.data };
  }
  if (id === undefined || id.trim() === "" || id.length > 256)
    throw new CampaignCommandUsageError("A campaign id is required");
  const path = `/campaigns/${encodeURIComponent(id)}`;
  if (verb === "show") return { kind: "request", method: "GET", path };
  if (verb === "watch") {
    const after = options.after ?? "0";
    if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))
      throw new CampaignCommandUsageError("--after must be a nonnegative event sequence");
    return { kind: "watch", id, after: Number(after) };
  }
  if (verb === "command") {
    const body = object(await jsonFile(options));
    const command = object(body.command);
    if (
      Object.keys(body).some((key) => key !== "expectedRevision" && key !== "command") ||
      !Number.isSafeInteger(body.expectedRevision) ||
      Number(body.expectedRevision) < 0 ||
      typeof command.type !== "string" ||
      command.type.trim() === ""
    )
      throw new CampaignCommandUsageError(
        "Command JSON requires explicit expectedRevision and command.type; fetch show to inspect the current revision",
      );
    return { kind: "request", method: "POST", path: `${path}/commands`, body };
  }
  if (!artifactId || artifactId.length > 256 || !destination)
    throw new CampaignCommandUsageError(
      "Export requires a campaign id, artifact id, and new destination",
    );
  return {
    kind: "request",
    method: "POST",
    path: `${path}/artifacts/${encodeURIComponent(artifactId)}/export`,
    body: { destination: resolve(options.cwd, destination) },
  };
}

async function scopedTicket(options: CampaignCommandOptions): Promise<ServerTicket> {
  const fetcher = options.fetch ?? fetch;
  const identity = workspaceIdentity(options.cwd, options.workspaceSlug);
  let mismatch = false;
  for (const file of ticketFilesFor(options.cwd, options.workspaceSlug, options.userRoot)) {
    const ticket = readServerTicket(file);
    if (ticket === undefined) continue;
    try {
      const url = new URL(ticket.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        continue;
      const response = await fetcher(`${ticket.url.replace(/\/$/, "")}/doc`, {
        redirect: "error",
        signal: requestSignal(options.signal),
      });
      if (!response.ok) continue;
      const info = object(object(await response.json()).info);
      if (info.title !== "keywork") continue;
      if (object(info.workspace).identity !== identity) {
        mismatch = true;
        continue;
      }
      return ticket;
    } catch {
      options.signal?.throwIfAborted();
    }
  }
  throw new Error(
    mismatch
      ? "The available runtime serves another workspace; start or select the runtime for this workspace"
      : "No running runtime ticket serves this workspace; run keywork serve separately before using campaign commands",
  );
}

async function requestJson(
  ticket: ServerTicket,
  path: string,
  method: "GET" | "POST",
  body: unknown,
  options: CampaignCommandOptions,
): Promise<unknown> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${ticket.url.replace(/\/$/, "")}${path}`, {
      method,
      redirect: "error",
      headers: {
        authorization: `Bearer ${ticket.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: requestSignal(options.signal),
    });
  } catch (cause) {
    if (method === "POST")
      throw new CampaignOutcomeUnknownError(
        "Request outcome is unknown; inspect campaign show before retrying this action",
      );
    throw cause;
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    if (response.ok && method === "POST")
      throw new CampaignOutcomeUnknownError(
        "Runtime returned an unreadable action result; inspect campaign show before retrying",
      );
    if (response.ok) throw new Error("Runtime returned invalid campaign JSON");
    result = {};
  }
  if (!response.ok) throw responseFailure(response.status, result);
  return result;
}

async function watchCampaign(
  action: Extract<CampaignAction, { kind: "watch" }>,
  ticket: ServerTicket,
  options: CampaignCommandOptions,
  output: Required<CommandIo>,
): Promise<number> {
  const path = `/campaigns/${encodeURIComponent(action.id)}`;
  const response = await (options.fetch ?? fetch)(
    `${ticket.url.replace(/\/$/, "")}${path}/events?after=${action.after}`,
    {
      headers: { authorization: `Bearer ${ticket.token}`, accept: "text/event-stream" },
      redirect: "error",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  if (!response.ok) throw responseFailure(response.status, await response.json().catch(() => ({})));
  if (
    response.body === null ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  )
    throw new Error("Runtime did not return a campaign event stream");
  let cursor = action.after;
  let snapshotCursor = -1;
  let terminal = false;
  const printSnapshot = (raw: unknown) => {
    const snapshot = object(raw);
    if (!Number.isSafeInteger(snapshot.sequence))
      throw new Error("Invalid campaign snapshot cursor");
    const sequence = Number(snapshot.sequence);
    if (sequence < snapshotCursor) return;
    const campaign = campaignSchema.parse(snapshot.campaign);
    if (campaign.id !== action.id) throw new Error("Runtime returned another campaign's snapshot");
    snapshotCursor = sequence;
    terminal = campaign.status === "cancelled" || campaign.status === "completed";
    if (options.json === true) output.print(JSON.stringify({ type: "snapshot", ...snapshot }));
    else {
      let settled = 0;
      let pending = 0;
      for (const receipt of campaign.usage) {
        if (receipt.state === "released") continue;
        if (receipt.state === "reported" || receipt.state === "reconciled")
          settled += receipt.costMicros ?? 0;
        else pending += Math.max(receipt.reservedMicros, receipt.costMicros ?? 0);
      }
      const achievements = campaign.achievements
        .filter((item) => item.status === "verified")
        .map((item) => item.title);
      output.print(
        `${campaign.id} ${campaign.status} revision=${campaign.revision} sequence=${sequence} cost=$${(settled / 1_000_000).toFixed(6)} pending=$${(pending / 1_000_000).toFixed(6)} budget=$${(campaign.budget.limitMicros / 1_000_000).toFixed(6)}`,
      );
      for (const achievement of achievements) output.print(`verified: ${achievement}`);
    }
  };
  for await (const frame of sseFrames(response.body)) {
    if (frame.event === "heartbeat") continue;
    let value: unknown;
    try {
      value = JSON.parse(frame.data);
    } catch {
      throw new Error("Invalid JSON in campaign event stream");
    }
    if (frame.event === "snapshot") {
      printSnapshot(value);
      continue;
    }
    if (frame.event !== "campaign") continue;
    const event = campaignEventSchema.parse(value);
    if (event.campaignId !== action.id)
      throw new Error("Runtime returned another campaign's event");
    if (event.sequence <= cursor) continue;
    cursor = event.sequence;
    output.print(
      options.json === true
        ? JSON.stringify({ type: "campaign", ...event })
        : `${event.sequence} ${event.kind}: ${event.summary}`,
    );
    if (/usage|achievement|operation\.response|completed|cancelled/.test(event.kind))
      printSnapshot(await requestJson(ticket, path, "GET", undefined, options));
  }
  if (options.signal?.aborted) return exitCodes.interrupted;
  if (terminal) return exitCodes.completed;
  output.printError(
    `Campaign watch disconnected at sequence ${cursor}; resume with keywork campaign watch ${action.id} --after ${cursor}`,
  );
  return exitCodes.unresolved;
}

async function jsonFile(options: CampaignCommandOptions): Promise<unknown> {
  if (options.file === undefined)
    throw new CampaignCommandUsageError(
      "--file <json> is required; create never starts execution and command requires an explicit revision",
    );
  const file = resolve(options.cwd, options.file);
  const facts = await stat(file);
  if (!facts.isFile() || facts.size > 1_100_000)
    throw new CampaignCommandUsageError(
      "Campaign JSON must be a regular file of at most 1100000 bytes",
    );
  const text = await readFile(file, "utf8");
  if (Buffer.byteLength(text) > 1_100_000)
    throw new CampaignCommandUsageError("Campaign JSON exceeds the supported size");
  try {
    return JSON.parse(text);
  } catch {
    throw new CampaignCommandUsageError("Campaign file is not valid JSON");
  }
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(20_000);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new CampaignCommandUsageError("Expected a JSON object");
  return value as Record<string, unknown>;
}

function responseFailure(status: number, body: unknown): CampaignHttpError {
  const value = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const detail =
    typeof value.error === "string"
      ? value.error.slice(0, 2000)
      : "Runtime refused the campaign request";
  return new CampaignHttpError(
    status,
    `${status}: ${detail}${status === 409 ? "; inspect show and choose a new command against its current revision" : ""}`,
  );
}
