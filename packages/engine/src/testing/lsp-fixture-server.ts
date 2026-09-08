import { appendFileSync, writeFileSync } from "node:fs";
import process from "node:process";

type Json = Record<string, unknown>;

const profile = process.argv[2] ?? "basic";
const markerPath = process.argv[3];
const tracePath = process.argv[4];
const slowInitDelayMs = 2_000;
const brokenMarker = "BROKEN";

main();

function main(): void {
  if (markerPath !== undefined) writeFileSync(markerPath, String(process.pid));
  listen();
}

function listen(): void {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    let frame = nextFrame(buffer);
    while (frame !== undefined) {
      buffer = buffer.subarray(frame.end);
      handle(JSON.parse(frame.body) as Json);
      frame = nextFrame(buffer);
    }
  });
  process.stdin.on("end", () => {
    if (profile !== "stubborn") process.exit(0);
  });
}

function handle(message: Json): void {
  const id = message.id as number | undefined;
  if (tracePath !== undefined) appendFileSync(tracePath, `${String(message.method)}\n`);
  const params = (message.params ?? {}) as Json;
  switch (message.method) {
    case "initialize":
      answerInitialize(id);
      return;
    case "initialized":
      if (profile === "crash-once") {
        process.stderr.write("fixture: crashing after initialized\n");
        process.exit(3);
      }
      return;
    case "textDocument/didOpen":
    case "textDocument/didChange":
      publishFor(params);
      return;
    case "shutdown":
      if (profile !== "stubborn") respond(id, null);
      return;
    case "exit":
      if (profile !== "stubborn") process.exit(0);
      return;
    default:
      if (id !== undefined) {
        emit({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
      }
  }
}

function answerInitialize(id: number | undefined): void {
  const result = {
    capabilities: { textDocumentSync: 1 },
    serverInfo: { name: `fixture-${profile}` },
  };
  if (profile === "slow-init") {
    setTimeout(() => respond(id, result), slowInitDelayMs);
    return;
  }
  respond(id, result);
}

function publishFor(params: Json): void {
  if (profile === "silent") return;
  const document = (params.textDocument ?? {}) as Json;
  const uri = String(document.uri ?? "");
  const text = documentText(params, document);
  emit({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics: diagnosticsFor(text) },
  });
}

function documentText(params: Json, document: Json): string {
  if (typeof document.text === "string") return document.text;
  const changes = (params.contentChanges ?? []) as Json[];
  return String(changes.at(-1)?.text ?? "");
}

function diagnosticsFor(text: string): Json[] {
  const lines = text.split("\n");
  const line = lines.findIndex((candidate) => candidate.includes(brokenMarker));
  if (line === -1) return [];
  const character = lines[line]?.indexOf(brokenMarker) ?? 0;
  return [
    {
      range: {
        start: { line, character },
        end: { line, character: character + brokenMarker.length },
      },
      severity: 1,
      source: "fixture",
      message: `Cannot find name '${brokenMarker}'.`,
    },
    {
      range: { start: { line, character }, end: { line, character } },
      severity: 2,
      source: "fixture",
      message: "Unused marker.",
    },
  ];
}

function respond(id: number | undefined, result: unknown): void {
  if (id === undefined) return;
  emit({ jsonrpc: "2.0", id, result });
}

function emit(message: Json): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
  process.stdout.write(body);
}

interface Frame {
  body: string;
  end: number;
}

function nextFrame(buffer: Buffer): Frame | undefined {
  const terminator = "\r\n\r\n";
  const headerEnd = buffer.indexOf(terminator);
  if (headerEnd === -1) return undefined;
  const match = /content-length:\s*(\d+)/i.exec(buffer.toString("ascii", 0, headerEnd));
  const length = Number(match?.[1] ?? 0);
  const bodyStart = headerEnd + terminator.length;
  const end = bodyStart + length;
  if (buffer.byteLength < end) return undefined;
  return { body: buffer.toString("utf8", bodyStart, end), end };
}
