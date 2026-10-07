export class McpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpProtocolError";
  }
}

export class McpRpcError extends McpProtocolError {
  readonly code: number | undefined;
  readonly data: unknown;

  constructor(error: unknown) {
    const record = typeof error === "object" && error !== null ? (error as RpcErrorShape) : {};
    super(typeof record.message === "string" ? record.message : "server returned an error");
    this.name = "McpRpcError";
    this.code = typeof record.code === "number" ? record.code : undefined;
    this.data = record.data;
  }
}

export class McpInputRequiredError extends McpProtocolError {
  constructor(server: string, method: string, asked: readonly string[]) {
    const wanted = asked.length > 0 ? ` (${asked.join(", ")})` : "";
    super(`${server} asked for input on ${method} that keywork can't collect yet${wanted}`);
    this.name = "McpInputRequiredError";
  }
}

export class McpAbortedError extends Error {
  constructor() {
    super("connection attempt aborted");
    this.name = "McpAbortedError";
  }
}

export class McpRequestTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`MCP request ${method} timed out after ${timeoutMs}ms`);
    this.name = "McpRequestTimeoutError";
  }
}

export class McpServerExitedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "McpServerExitedError";
  }
}

interface RpcErrorShape {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}
