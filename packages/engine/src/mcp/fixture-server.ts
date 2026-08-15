import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import process from "node:process";

type Json = Record<string, unknown>;

interface FixtureTool {
  name: string;
  description: string;
  inputSchema: Json;
  respond(args: Json): { text: string; isError?: boolean };
}

const profile = process.argv[2] ?? "basic";
const markerPath = process.argv[3];

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
  serve(profile === "hazard" ? hazardTools() : basicTools(), profile === "leaky");
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
  switch (message.method) {
    case "initialize":
      respond(id, {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: `fixture-${profile}`, version: "1.0.0" },
      });
      return;
    case "notifications/initialized":
      return;
    case "tools/list":
      respond(id, listPage(tools, params.cursor));
      return;
    case "tools/call":
      respond(id, callResult(tools, params));
      return;
    default:
      if (id !== undefined) {
        emit({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
      }
  }
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

function callResult(tools: FixtureTool[], params: Json): Json {
  const tool = tools.find((candidate) => candidate.name === params.name);
  if (tool === undefined) {
    return {
      content: [{ type: "text", text: `no such tool: ${String(params.name)}` }],
      isError: true,
    };
  }
  const outcome = tool.respond((params.arguments ?? {}) as Json);
  return {
    content: [{ type: "text", text: outcome.text }],
    ...(outcome.isError === true && { isError: true }),
  };
}

function respond(id: number | undefined, result: Json): void {
  if (id === undefined) return;
  emit({ jsonrpc: "2.0", id, result });
}

function emit(message: Json): void {
  const line = `${JSON.stringify(message)}\n`;
  if (profile === "garbage") {
    process.stdout.write("this line is not json at all\n");
    const half = Math.floor(line.length / 2);
    process.stdout.write(line.slice(0, half));
    setTimeout(() => process.stdout.write(line.slice(half)), 5);
    return;
  }
  process.stdout.write(line);
}
