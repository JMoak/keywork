import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import process from "node:process";

type Json = Record<string, unknown>;

interface FixtureTool {
  name: string;
  description: string;
  inputSchema: Json;
  asks?: Json;
  respond(args: Json, call: CallContext): Outcome;
}

interface CallContext {
  responses: Json | undefined;
  clientCapabilities: Json;
}

interface Outcome {
  text: string;
  isError?: boolean;
}

type Era = "legacy" | "modern" | "dual";

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const flags = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key = "", value = ""] = arg.slice(2).split("=");
      return [key, value] as const;
    }),
);
const profile = positional[0] ?? "basic";
const markerPath = positional[1];
const era = eraFlag(flags.get("era"));
const ttlMs = Number(flags.get("ttl") ?? 60_000);
const modernVersion = "2026-07-28";
const versionKey = "io.modelcontextprotocol/protocolVersion";
const capabilitiesKey = "io.modelcontextprotocol/clientCapabilities";
const subscriptionKey = "io.modelcontextprotocol/subscriptionId";
const serverInfo = { name: `fixture-${profile}`, version: "1.0.0" };
let legacySession = false;
let subscriptionId: number | undefined;

main();

function main(): void {
  if (profile === "silent") {
    setInterval(() => {}, 60_000);
    return;
  }
  if (profile === "crash-once" && markerPath !== undefined && !existsSync(markerPath)) {
    writeFileSync(markerPath, "crashed");
    process.exit(1);
  }
  if (profile === "leaky" && markerPath !== undefined) {
    const grandchild = spawn(process.execPath, [process.argv[1] ?? "", "silent"], {
      stdio: "ignore",
    });
    writeFileSync(markerPath, `${process.pid}\n${grandchild.pid ?? 0}`);
  }
  serve(toolsFor(profile), profile === "leaky");
}

function eraFlag(value: string | undefined): Era {
  return value === "modern" || value === "dual" ? value : "legacy";
}

function toolsFor(profile: string): FixtureTool[] {
  if (profile === "hazard") return hazardTools();
  if (profile === "growing") return growingTools();
  if (profile === "asking") return askingTools();
  return basicTools();
}

function basicTools(): FixtureTool[] {
  return [
    {
      name: "echo",
      description: "Echoes the given text back verbatim.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      respond: (args) => ({ text: String(args.text ?? "") }),
    },
    {
      name: "add",
      description: "Adds two numbers and returns the sum.",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
      respond: (args) => ({ text: String(Number(args.a) + Number(args.b)) }),
    },
  ];
}

function hazardTools(): FixtureTool[] {
  return [
    {
      name: "blast",
      description: "Returns an oversized wall of text.",
      inputSchema: { type: "object", properties: {} },
      respond: () => ({ text: "x".repeat(200_000) }),
    },
    {
      name: "boom",
      description: "Crashes the server mid-call.",
      inputSchema: { type: "object", properties: {} },
      respond: () => process.exit(1),
    },
  ];
}

function growingTools(): FixtureTool[] {
  const tools: FixtureTool[] = [
    ...basicTools(),
    {
      name: "grow",
      description: "Adds a sprout tool to the catalog and announces the change.",
      inputSchema: { type: "object", properties: {} },
      respond: () => {
        tools.push({
          name: "sprout",
          description: "Appeared after the catalog changed.",
          inputSchema: { type: "object", properties: {} },
          respond: () => ({ text: "sprouted" }),
        });
        setTimeout(announceToolsChanged, 5);
        return { text: "grown" };
      },
    },
  ];
  return tools;
}

function askingTools(): FixtureTool[] {
  return [
    ...basicTools(),
    {
      name: "confirm",
      description: "Asks the user to confirm before answering.",
      inputSchema: { type: "object", properties: {} },
      asks: {
        confirm: elicitation({
          message: "Proceed?",
          requestedSchema: { type: "object", properties: {} },
        }),
      },
      respond: (_args, call) => answered(call, "confirm", () => "confirmed"),
    },
    {
      name: "greet",
      description: "Asks for a name and a colour, then greets.",
      inputSchema: { type: "object", properties: {} },
      asks: {
        who: elicitation({
          mode: "form",
          message: "Who should I greet?",
          requestedSchema: {
            type: "object",
            properties: {
              name: { type: "string", title: "Name", default: "friend" },
              color: { type: "string", enum: ["Red", "Green"], default: "Red" },
            },
            required: ["name"],
          },
        }),
      },
      respond: (_args, call) =>
        answered(call, "who", (content) => `hello ${content.name} in ${content.color}`),
    },
    {
      name: "register",
      description: "Asks for a handle it cannot default.",
      inputSchema: { type: "object", properties: {} },
      asks: {
        handle: elicitation({
          message: "Pick a handle",
          requestedSchema: {
            type: "object",
            properties: { handle: { type: "string" } },
            required: ["handle"],
          },
        }),
      },
      respond: (_args, call) =>
        answered(call, "handle", (content) => `registered ${content.handle}`),
    },
    {
      name: "connect",
      description: "Sends the user to a link before answering.",
      inputSchema: { type: "object", properties: {} },
      asks: {
        link: elicitation({
          mode: "url",
          message: "Finish connecting in your browser",
          url: "https://fixture.example/connect",
        }),
      },
      respond: (_args, call) => answered(call, "link", () => "connected"),
    },
    {
      name: "nag",
      description: "Keeps asking no matter what it hears.",
      inputSchema: { type: "object", properties: {} },
      asks: {
        again: elicitation({
          message: "Once more?",
          requestedSchema: { type: "object", properties: {} },
        }),
      },
      respond: () => ({ text: "never answered" }),
    },
    {
      name: "capabilities",
      description: "Echoes the client capabilities the caller advertised.",
      inputSchema: { type: "object", properties: {} },
      respond: (_args, call) => ({ text: JSON.stringify(call.clientCapabilities) }),
    },
  ];
}

function elicitation(params: Json): Json {
  return { method: "elicitation/create", params };
}

function answered(call: CallContext, key: string, reply: (content: Json) => string): Outcome {
  const response = (call.responses?.[key] ?? {}) as Json;
  if (response.action !== "accept") {
    return {
      text: `${key}: the user ${String(response.action ?? "gave no answer")}`,
      isError: true,
    };
  }
  return { text: reply((response.content ?? {}) as Json) };
}

function announceToolsChanged(): void {
  const method = "notifications/tools/list_changed";
  if (legacySession) {
    emit({ jsonrpc: "2.0", method });
    return;
  }
  if (subscriptionId === undefined) return;
  emit({ jsonrpc: "2.0", method, params: { _meta: { [subscriptionKey]: subscriptionId } } });
}

function serve(tools: FixtureTool[], lingerAfterEof: boolean): void {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) handle(JSON.parse(line) as Json, tools);
      newline = buffer.indexOf("\n");
    }
  });
  process.stdin.on("end", () => {
    if (lingerAfterEof) setInterval(() => {}, 60_000);
    else process.exit(0);
  });
}

function handle(message: Json, tools: FixtureTool[]): void {
  const id = message.id as number | undefined;
  const params = (message.params ?? {}) as Json;
  const method = String(message.method);
  if (method === "notifications/initialized") return;
  if (method === "server/discover" && flags.has("mute-discover")) return;
  if (method === "initialize") {
    answerInitialize(id, params);
    return;
  }
  const modern = era !== "legacy" && hasModernMeta(params);
  if (era === "modern" && !modern) {
    fail(id, -32602, "missing _meta protocol fields");
    return;
  }
  const version = (params._meta as Json | undefined)?.[versionKey];
  if (modern && version !== modernVersion) {
    fail(id, -32022, "Unsupported protocol version", {
      supported: [modernVersion],
      requested: version,
    });
    return;
  }
  serveMethod(method, id, params, tools, modern);
}

function answerInitialize(id: number | undefined, params: Json): void {
  if (era === "modern") {
    fail(id, -32601, `initialize is not supported; this server speaks ${modernVersion}`);
    return;
  }
  legacySession = true;
  respond(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo });
}

function hasModernMeta(params: Json): boolean {
  const meta = params._meta as Json | undefined;
  return typeof meta?.[versionKey] === "string" && typeof meta[capabilitiesKey] === "object";
}

function serveMethod(
  method: string,
  id: number | undefined,
  params: Json,
  tools: FixtureTool[],
  modern: boolean,
): void {
  if (method === "server/discover" && modern) {
    respond(id, modernResult(discovery(), true));
    return;
  }
  if (method === "subscriptions/listen" && modern) {
    acknowledgeSubscription(id);
    return;
  }
  if (method === "tools/list") {
    const page = listPage(tools, params.cursor);
    respond(id, modern ? modernResult(page, true) : page);
    return;
  }
  if (method === "tools/call") {
    const result = callResult(tools, params, modern);
    respond(id, modern ? modernResult(result, false) : result);
    return;
  }
  fail(id, -32601, "method not found");
}

function discovery(): Json {
  return {
    supportedVersions: era === "dual" ? [modernVersion, "2025-11-25"] : [modernVersion],
    capabilities: { tools: { listChanged: profile === "growing" } },
  };
}

function acknowledgeSubscription(id: number | undefined): void {
  subscriptionId = id;
  emit({
    jsonrpc: "2.0",
    method: "notifications/subscriptions/acknowledged",
    params: { _meta: { [subscriptionKey]: id }, notifications: { toolsListChanged: true } },
  });
}

function modernResult(result: Json, cacheable: boolean): Json {
  return {
    resultType: "complete",
    ...result,
    _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
    ...(cacheable && { ttlMs, cacheScope: "public" }),
  };
}

function fail(id: number | undefined, code: number, message: string, data?: Json): void {
  if (id === undefined) return;
  emit({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined && { data }) } });
}

function listPage(tools: FixtureTool[], cursor: unknown): Json {
  const catalog = tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  if (cursor === "rest") return { tools: catalog.slice(1) };
  return { tools: catalog.slice(0, 1), nextCursor: "rest" };
}

function callResult(tools: FixtureTool[], params: Json, modern: boolean): Json {
  const tool = tools.find((candidate) => candidate.name === params.name);
  if (tool === undefined) {
    return {
      content: [{ type: "text", text: `no such tool: ${String(params.name)}` }],
      isError: true,
    };
  }
  const responses = params.inputResponses as Json | undefined;
  const asksFirst = tool.asks !== undefined && modern;
  const needsRound = asksFirst && (responses === undefined || tool.name === "nag");
  if (needsRound) return inputRequired(tool);
  if (asksFirst && params.requestState !== stateFor(tool)) {
    return { content: [{ type: "text", text: "requestState did not round-trip" }], isError: true };
  }
  const clientCapabilities = ((params._meta as Json | undefined)?.[capabilitiesKey] ?? {}) as Json;
  const outcome = tool.respond((params.arguments ?? {}) as Json, { responses, clientCapabilities });
  return {
    content: [{ type: "text", text: outcome.text }],
    ...(outcome.isError === true && { isError: true }),
  };
}

function inputRequired(tool: FixtureTool): Json {
  return { resultType: "input_required", inputRequests: tool.asks, requestState: stateFor(tool) };
}

function stateFor(tool: FixtureTool): string {
  return `state-${tool.name}`;
}

function respond(id: number | undefined, result: Json): void {
  if (id === undefined) return;
  emit({ jsonrpc: "2.0", id, result });
}

function emit(message: Json): void {
  const line = `${JSON.stringify(message)}\n`;
  if (profile === "flood") {
    process.stdout.write("x".repeat(10 * 1024 * 1024));
    return;
  }
  if (profile === "garbage") {
    process.stdout.write("this line is not json at all\n");
    const half = Math.floor(line.length / 2);
    process.stdout.write(line.slice(0, half));
    setTimeout(() => process.stdout.write(line.slice(half)), 5);
    return;
  }
  process.stdout.write(line);
}
