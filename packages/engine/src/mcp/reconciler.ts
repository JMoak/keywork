import type { McpServerConfig } from "@keywork/shared";
import type { McpConnection, McpTool, StdioServerSpec } from "./client.ts";

export type McpServerState = "connected" | "connecting" | "down";

export interface McpServerStatus {
  name: string;
  state: McpServerState;
  enabled: boolean;
  toolCount: number;
  lastError?: string;
}

export type ConnectServer = (spec: StdioServerSpec, signal: AbortSignal) => Promise<McpConnection>;

export interface ServerTransition {
  enabled: boolean;
  freshConnection?: boolean;
}

export interface LiveServer {
  connection: McpConnection;
  catalog: readonly McpTool[];
}

export interface ServerReconcilerOptions {
  name: string;
  config: McpServerConfig;
  connect: ConnectServer;
  restartDelays: readonly number[];
  onChange: () => void;
}

export class ServerReconciler {
  readonly name: string;
  readonly config: McpServerConfig;
  private readonly connect: ConnectServer;
  private readonly restartDelays: readonly number[];
  private readonly onChange: () => void;
  private readonly wake = new Wakeup();
  private desired: DesiredState = { enabled: true, epoch: 0, version: 0 };
  private state: McpServerState = "down";
  private connection: McpConnection | undefined;
  private connectionEpoch = -1;
  private lost = false;
  private eager = true;
  private retriesExhausted = false;
  private restartAttempt = 0;
  private catalog: McpTool[] = [];
  private lastError: string | undefined;
  private settledVersion = -1;
  private waiters: SettleWaiter[] = [];
  private loop: Promise<void> | undefined;
  private attempt: AbortController | undefined;
  private stopping = false;

  constructor(options: ServerReconcilerOptions) {
    this.name = options.name;
    this.config = options.config;
    this.connect = options.connect;
    this.restartDelays = options.restartDelays;
    this.onChange = options.onChange;
  }

  status(): McpServerStatus {
    return {
      name: this.name,
      state: this.state,
      enabled: this.desired.enabled,
      toolCount: this.catalog.length,
      ...(this.lastError !== undefined && { lastError: this.lastError }),
    };
  }

  listedTools(): readonly McpTool[] {
    return this.catalog;
  }

  live(): LiveServer | undefined {
    if (!this.desired.enabled || this.state !== "connected" || this.connection === undefined) {
      return undefined;
    }
    return { connection: this.connection, catalog: this.catalog };
  }

  start(): void {
    if (this.desired.enabled) this.spawn();
  }

  transition(change: ServerTransition): Promise<void> {
    this.desired = {
      enabled: change.enabled,
      epoch: this.desired.epoch + (change.freshConnection === true ? 1 : 0),
      version: this.desired.version + 1,
    };
    this.restartAttempt = 0;
    this.retriesExhausted = false;
    this.eager = true;
    this.spawn();
    this.attempt?.abort();
    this.wake.fire();
    return this.settled();
  }

  settled(): Promise<void> {
    const version = this.desired.version;
    if (this.settledVersion >= version) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ version, resolve }));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.attempt?.abort();
    this.wake.fire();
    await this.loop;
  }

  private spawn(): void {
    this.loop ??= this.serve();
  }

  private async serve(): Promise<void> {
    while (!this.stopping) {
      const goal = this.desired;
      if (this.aligned(goal)) {
        if (!goal.enabled) this.clearDisabledPresentation();
        this.settle(goal.version);
        await this.wake.wait();
      } else {
        await this.alignOnce(goal);
      }
    }
    await this.dropConnection();
    this.settle(this.desired.version);
  }

  private aligned(goal: DesiredState): boolean {
    if (this.connection !== undefined) {
      return goal.enabled && !this.lost && this.connectionEpoch === goal.epoch;
    }
    return !goal.enabled || this.retriesExhausted;
  }

  private async alignOnce(goal: DesiredState): Promise<void> {
    if (this.connection !== undefined) return this.dropConnection();
    if (!this.eager) {
      const delay = this.restartDelays[this.restartAttempt];
      if (delay === undefined) return this.markRetriesExhausted(goal.version);
      this.restartAttempt += 1;
      await this.wake.wait(delay);
      if (this.superseded(goal)) return;
    }
    await this.attemptConnect(goal);
  }

  private async attemptConnect(goal: DesiredState): Promise<void> {
    this.eager = false;
    this.state = "connecting";
    this.onChange();
    const attempt = new AbortController();
    this.attempt = attempt;
    try {
      const opened = await this.openConnection(attempt.signal);
      if (this.superseded(goal)) {
        await closeQuietly(opened.connection);
        return;
      }
      this.adopt(goal, opened);
    } catch (cause) {
      if (this.superseded(goal)) return;
      this.state = "down";
      this.lastError = errorMessage(cause);
      this.onChange();
      this.settle(goal.version);
    } finally {
      this.attempt = undefined;
    }
  }

  private async openConnection(signal: AbortSignal): Promise<LiveServer> {
    const connection = await this.connect(stdioSpec(this.config), signal);
    try {
      return { connection, catalog: await connection.listTools() };
    } catch (cause) {
      await closeQuietly(connection);
      throw cause;
    }
  }

  private adopt(goal: DesiredState, opened: LiveServer): void {
    const { connection } = opened;
    this.connection = connection;
    this.connectionEpoch = goal.epoch;
    this.lost = false;
    this.catalog = [...opened.catalog];
    this.state = "connected";
    this.lastError = undefined;
    this.restartAttempt = 0;
    connection.onClose((error) => this.handleLoss(connection, error));
    connection.onToolsChanged(() => void this.refreshCatalog(connection));
    this.onChange();
    this.settle(goal.version);
  }

  private async refreshCatalog(connection: McpConnection): Promise<void> {
    let catalog: McpTool[];
    try {
      catalog = await connection.listTools();
    } catch (cause) {
      if (this.connection !== connection) return;
      this.lastError = `tool list refresh failed: ${errorMessage(cause)}`;
      this.onChange();
      return;
    }
    if (this.connection !== connection) return;
    this.catalog = catalog;
    this.onChange();
  }

  private async dropConnection(): Promise<void> {
    const connection = this.connection;
    if (connection === undefined) return;
    this.connection = undefined;
    this.lastError = this.lost ? this.lastError : undefined;
    this.lost = false;
    this.state = "down";
    this.catalog = [];
    this.onChange();
    await closeQuietly(connection);
  }

  private handleLoss(connection: McpConnection, error: Error | undefined): void {
    if (this.connection !== connection) return;
    this.lost = true;
    this.state = "down";
    this.catalog = [];
    this.lastError = error?.message ?? "server closed the connection";
    this.onChange();
    this.wake.fire();
  }

  private clearDisabledPresentation(): void {
    const cleared =
      this.state === "down" && this.lastError === undefined && this.catalog.length === 0;
    if (cleared) return;
    this.state = "down";
    this.lastError = undefined;
    this.catalog = [];
    this.onChange();
  }

  private markRetriesExhausted(version: number): void {
    this.retriesExhausted = true;
    this.lastError = `${this.lastError ?? "down"} · retry limit reached, restart manually`;
    this.onChange();
    this.settle(version);
  }

  private superseded(goal: DesiredState): boolean {
    return this.stopping || this.desired.version !== goal.version;
  }

  private settle(version: number): void {
    if (version <= this.settledVersion) return;
    this.settledVersion = version;
    const remaining: SettleWaiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.version <= version) waiter.resolve();
      else remaining.push(waiter);
    }
    this.waiters = remaining;
  }
}

interface DesiredState {
  enabled: boolean;
  epoch: number;
  version: number;
}

interface SettleWaiter {
  version: number;
  resolve: () => void;
}

class Wakeup {
  private fired = false;
  private release: (() => void) | undefined;

  fire(): void {
    this.fired = true;
    const release = this.release;
    this.release = undefined;
    release?.();
  }

  wait(timeoutMs?: number): Promise<void> {
    if (this.fired) {
      this.fired = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.release = undefined;
              resolve();
            }, timeoutMs);
      this.release = () => {
        if (timer !== undefined) clearTimeout(timer);
        this.fired = false;
        resolve();
      };
    });
  }
}

function stdioSpec(config: McpServerConfig): StdioServerSpec {
  if (config.transport !== "stdio") {
    throw new Error("http MCP transport is not supported yet (arrives with D9)");
  }
  return {
    command: config.command,
    ...(config.args !== undefined && { args: config.args }),
    ...(config.env !== undefined && { env: config.env }),
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function closeQuietly(connection: McpConnection): Promise<void> {
  try {
    await connection.close();
  } catch {
    return;
  }
}
