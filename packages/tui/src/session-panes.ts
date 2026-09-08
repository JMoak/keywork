import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type Agent,
  type Message,
  modelReferenceOf,
  type ToolCallPart,
  type ToolGuard,
  textMessage,
} from "@keywork/engine";
import { toError } from "@keywork/shared";
import type { AppCore } from "./app-core.ts";
import type { FocusedArcPort } from "./arc-commands.ts";
import { type ArcIndex, seedArcFromOrigin } from "./arc-index.ts";
import type { ArcsPort } from "./arcs.ts";
import type { FocusedBotPort } from "./bot-commands.ts";
import type { BotEntry, BotSummary } from "./bots.ts";
import type { GlyphSupport } from "./capability.ts";
import type { CommandRegistry } from "./commands.ts";
import type { GaugeStyle } from "./context-gauge.ts";
import type { ConversationPorts, Titler } from "./conversation-model.ts";
import { ConversationPane, type TranscriptElevation } from "./conversation-pane.ts";
import type { ConversationTarget } from "./extension-commands.ts";
import { type CheckpointsPort, forkAtPrompt } from "./fork.ts";
import type { Animator } from "./motion.ts";
import type { PageThresholds } from "./page.ts";
import type { PaneFactory, PaneOrigin } from "./pane-kinds.ts";
import {
  type AfterTurn,
  type AgentFactory,
  type AgentSeams,
  adoptSession,
  bindSessionLifecycle,
  type Compactor,
  type PaneSessionIndex,
  persistingTitler,
  type SessionAttachment,
  type SessionEscrow,
  type SessionPort,
  startFreshSession,
} from "./session-attachment.ts";
import type { SessionTreePort } from "./session-tree-pane.ts";
import type { ShellEscapePort } from "./shell-escape.ts";

export interface SessionPaneDeps {
  core(): AppCore;
  escrow: SessionEscrow;
  paneSessions: PaneSessionIndex;
  arcIndex: ArcIndex;
  animator: Animator;
  page: PageThresholds;
  glyphs: GlyphSupport;
  masthead?: "on" | "off";
  gauge?: GaugeStyle;
  elevation?: TranscriptElevation;
  agentFactory?: AgentFactory;
  sessions?: SessionPort;
  trees?: SessionTreePort;
  checkpoints?: CheckpointsPort;
  titler?: Titler;
  afterTurn?: AfterTurn;
  compact?: Compactor;
  arcs?: ArcsPort;
  botOf?: (name: string) => BotEntry | undefined;
  botSpend?: (name: string) => Promise<BotSummary | undefined>;
  now?: () => number;
  shellEscape?: (guard: ToolGuard) => ShellEscapePort;
  spillFile?: (sessionId: string, spillId: string) => string | undefined;
}

export interface SessionControls {
  switchBot(name: string | undefined): boolean;
  switchModel(reference: string): Promise<string>;
  bindArc(slug: string | undefined): Promise<void>;
  resyncArc(): void;
}

export interface FocusedSessionPane {
  id: string;
  pane: ConversationPane;
  controls: SessionControls;
}

export class SessionPanes {
  private readonly controls = new Map<string, SessionControls>();
  private shellConfirmSequence = 0;

  constructor(private readonly deps: SessionPaneDeps) {}

  readonly createPane: PaneFactory = (id, notify, commands, resumeSessionId, draft, origin) => {
    const attachment =
      resumeSessionId === undefined ? undefined : this.deps.escrow.claim(resumeSessionId);
    if (resumeSessionId !== undefined && attachment === undefined) return undefined;
    const session = new PaneSession(this.deps, id, notify, commands, attachment, draft, origin);
    this.controls.set(id, session);
    return session.pane;
  };

  forget(id: string): void {
    this.controls.delete(id);
  }

  focused(): FocusedSessionPane | undefined {
    const core = this.deps.core();
    for (const id of core.panesFocusedFirst()) {
      const pane = core.panes.get(id);
      const controls = this.controls.get(id);
      if (pane instanceof ConversationPane && controls !== undefined) return { id, pane, controls };
    }
    return undefined;
  }

  arcOf(paneId: string): string | undefined {
    const pane = this.deps.core().panes.get(paneId);
    return pane instanceof ConversationPane ? pane.arc : undefined;
  }

  resyncArcs(): void {
    for (const controls of this.controls.values()) controls.resyncArc();
  }

  busyCount(): number {
    let busy = 0;
    for (const id of this.controls.keys()) {
      const pane = this.deps.core().panes.get(id);
      if (pane instanceof ConversationPane && pane.model.busy) busy += 1;
    }
    return busy;
  }

  awaiting(): readonly string[] {
    const titles: string[] = [];
    for (const id of this.controls.keys()) {
      const pane = this.deps.core().panes.get(id);
      if (pane instanceof ConversationPane && pane.awaitingYou()) titles.push(pane.titled() ?? id);
    }
    return titles;
  }

  currentModel(): string | undefined {
    const agent = this.focused()?.pane.currentAgent();
    return agent === undefined ? undefined : modelReferenceOf(agent.provider);
  }

  switchModel(reference: string): Promise<string> {
    const found = this.focused();
    if (found === undefined) return Promise.reject(new Error("no conversation pane here"));
    return found.controls.switchModel(reference);
  }

  focusedArcPort(): FocusedArcPort {
    return {
      current: () => this.focused()?.pane.arc,
      titleHint: () => this.focused()?.pane.titled(),
      bind: (slug) => {
        const found = this.focused();
        if (found === undefined) return Promise.reject(new Error("no conversation pane here"));
        return found.controls.bindArc(slug);
      },
    };
  }

  focusedBotPort(): FocusedBotPort {
    return {
      current: () => this.focused()?.pane.bot,
      switch: (name) => this.focused()?.controls.switchBot(name) ?? false,
    };
  }

  postNotice(text: string): boolean {
    const found = this.focused();
    if (found === undefined) return false;
    found.pane.postNotice(text);
    return true;
  }

  conversationTarget(): ConversationTarget | undefined {
    const found = this.focused();
    if (found === undefined) return undefined;
    return {
      confirmShell: (command) => found.pane.confirmMutation(this.shellConfirmCall(command)),
      submitPrompt: (text) => found.pane.submitPrompt(text),
      bot: () => found.pane.bot,
      switchBot: (name) => found.controls.switchBot(name),
    };
  }

  private shellConfirmCall(command: string): ToolCallPart {
    this.shellConfirmSequence += 1;
    return {
      type: "tool-call",
      callId: `command-shell-${this.shellConfirmSequence}`,
      name: "bash",
      arguments: { command },
    };
  }
}

class PaneSession implements SessionControls {
  readonly pane: ConversationPane;
  private readonly guard: ToolGuard;
  private live: SessionAttachment | undefined;
  private selectedModel: string | undefined;

  constructor(
    private readonly deps: SessionPaneDeps,
    id: string,
    private readonly notify: () => void,
    commands: CommandRegistry,
    attachment: SessionAttachment | undefined,
    draft: string | undefined,
    origin: PaneOrigin | undefined,
  ) {
    this.selectedModel = attachment?.modelReference;
    const checkpoints = deps.checkpoints;
    this.guard = {
      confirm: (call) => this.pane.confirmMutation(call),
      ...(checkpoints !== undefined && { beforeMutation: () => checkpoints.capture() }),
    };
    const initial = buildAgent(
      deps.agentFactory,
      this.guard,
      attachment?.history,
      this.seamsFor(undefined, this.selectedModel),
      attachment?.bot,
    );
    const ports: ConversationPorts = {
      readFile: readWorkspaceFile,
      forkAtPrompt: (promptId, promptDraft) =>
        forkAtPrompt(
          deps.trees,
          (sessionId, forkDraft) =>
            deps.core().openPane(sessionId, forkDraft, { sourcePaneId: id, arc: "inherit" }),
          deps.checkpoints,
          this.pane.sessionId,
          promptId,
          promptDraft,
        ),
      ...(initial.failure !== undefined && { idleNotice: initial.failure }),
      ...(deps.botSpend !== undefined && { botSpend: deps.botSpend }),
      ...(deps.botOf !== undefined && { botOf: deps.botOf }),
      ...(deps.now !== undefined && { now: deps.now }),
      ...(deps.shellEscape !== undefined && {
        shellEscape: deps.shellEscape(this.guard),
        recordShellEscape: (transcript: string) => this.recordShellEscape(transcript),
      }),
      spillFile: (spillId) => this.spillOnDisk(spillId),
      openFile: (path, options) => deps.core().intents.openFile(path, options),
    };
    this.pane = new ConversationPane(
      id,
      initial.agent,
      notify,
      persistingTitler(deps.titler, () => this.live),
      commands,
      {
        ports,
        page: deps.page,
        glyphs: deps.glyphs,
        animator: deps.animator,
        siblingTitles: () => siblingTitles(deps.core(), id),
        ...(deps.botOf !== undefined && { botOf: deps.botOf }),
        ...(deps.masthead !== undefined && { masthead: deps.masthead }),
        ...(deps.gauge !== undefined && { gauge: deps.gauge }),
        ...(deps.elevation !== undefined && { elevation: deps.elevation }),
        ...(draft !== undefined && { initialDraft: draft }),
      },
    );
    deps.paneSessions.bind(id, () => this.pane.sessionId, {
      busy: () => this.pane.currentAgent()?.busy() ?? false,
      waiting: () => this.pane.awaitingYou(),
    });
    if (attachment !== undefined) {
      this.wire(attachment, initial.agent);
      return;
    }
    startFreshSession(
      deps.sessions,
      notify,
      (fresh) => {
        this.wire(fresh, initial.agent);
        this.seedArc(origin);
        this.seedBot(origin);
      },
      () => !this.pane.disposed(),
    );
  }

  switchBot(name: string | undefined): boolean {
    const factory = this.deps.agentFactory;
    const current = this.pane.currentAgent();
    if (factory === undefined || current === undefined || current.busy()) return false;
    const seed = name === undefined ? undefined : this.deps.botOf?.(name)?.model;
    const reference = seed ?? this.modelInForce();
    this.pane.swapAgent(
      factory(this.guard, current.history(), this.seamsFor(current.bus, reference), name),
    );
    this.pane.bot = name;
    if (seed !== undefined) this.selectedModel = seed;
    void this.persistBot(name, seed);
    return true;
  }

  async switchModel(reference: string): Promise<string> {
    const factory = this.deps.agentFactory;
    if (factory === undefined) throw new Error("no inference runtime in this session");
    const current = this.pane.currentAgent();
    if (current?.busy() === true) throw new Error("agent busy · finish the turn first");
    const next = factory(
      this.guard,
      current?.history(),
      this.seamsFor(current?.bus, reference),
      this.pane.bot,
    );
    await this.live?.recordModel?.(reference);
    this.selectedModel = reference;
    this.pane.swapAgent(next);
    return `model → ${modelReferenceOf(next.provider) ?? reference}`;
  }

  async bindArc(slug: string | undefined): Promise<void> {
    const session = this.live;
    if (session === undefined) throw new Error("this session has no store yet · try again");
    await session.bindArc?.(slug);
    this.pane.arc = slug;
    this.deps.arcIndex.changed();
    this.notify();
  }

  resyncArc(): void {
    const arc = this.live?.arc;
    if (this.live === undefined || this.pane.arc === arc) return;
    this.pane.arc = arc;
    this.notify();
  }

  private spillOnDisk(spillId: string): string | undefined {
    const sessionId = this.pane.sessionId;
    const path = sessionId === undefined ? undefined : this.deps.spillFile?.(sessionId, spillId);
    return path !== undefined && existsSync(path) ? path : undefined;
  }

  private async recordShellEscape(transcript: string): Promise<void> {
    await this.live?.append(textMessage("user", transcript));
  }

  private wire(attachment: SessionAttachment, agent: Agent | undefined): void {
    this.live = attachment;
    const chosen = this.pane.bot;
    adoptSession(this.pane, agent, attachment);
    if (chosen !== undefined && attachment.bot === undefined) {
      this.pane.bot = chosen;
      void this.persistBot(chosen, undefined);
    }
    bindSessionLifecycle({
      pane: this.pane,
      attachment,
      modelInForce: () => this.modelInForce(),
      ...(this.deps.afterTurn !== undefined && { afterTurn: this.deps.afterTurn }),
      ...(this.deps.compact !== undefined && { compact: this.deps.compact }),
      rebuild: (history, current) =>
        this.deps.agentFactory?.(
          this.guard,
          history,
          this.seamsFor(current.bus, this.modelInForce()),
          this.pane.bot,
        ),
    });
  }

  private seedBot(origin: PaneOrigin | undefined): void {
    const inherited = inheritedBot(origin, this.deps.core());
    if (inherited === undefined) return;
    if (!this.switchBot(inherited)) this.pane.postNotice(`bot ${inherited} could not bind here`);
  }

  private async persistBot(name: string | undefined, seed: string | undefined): Promise<void> {
    try {
      if (seed !== undefined) await this.live?.recordModel?.(seed);
      await this.live?.bindBot?.(name);
      this.notify();
    } catch (cause) {
      this.pane.postNotice(toError(cause).message);
    }
  }

  private seedArc(origin: PaneOrigin | undefined): void {
    void seedArcFromOrigin(origin, this.deps.core(), this.deps.arcs, (slug) =>
      this.bindArc(slug),
    ).then(
      (notice) => notice !== undefined && this.pane.postNotice(notice),
      (cause: unknown) => this.pane.postNotice(toError(cause).message),
    );
  }

  private modelInForce(): string | undefined {
    const current = this.pane.currentAgent();
    return (
      (current === undefined ? undefined : modelReferenceOf(current.provider)) ?? this.selectedModel
    );
  }

  private seamsFor(bus: Agent["bus"] | undefined, modelReference: string | undefined): AgentSeams {
    return {
      sessionId: () => this.pane.sessionId,
      discloseRetrieval: (text) => this.pane.discloseRetrieval(text),
      ...(bus !== undefined && { bus }),
      ...(modelReference !== undefined && { modelReference }),
    };
  }
}

function inheritedBot(origin: PaneOrigin | undefined, core: AppCore): string | undefined {
  if (origin === undefined) return undefined;
  if (origin.bot !== undefined) return origin.bot;
  const source =
    origin.sourcePaneId === undefined ? undefined : core.panes.get(origin.sourcePaneId);
  return source instanceof ConversationPane ? source.bot : undefined;
}

function buildAgent(
  factory: AgentFactory | undefined,
  guard: ToolGuard,
  history: readonly Message[] | undefined,
  seams: AgentSeams,
  bot: string | undefined,
): { agent?: Agent; failure?: string } {
  if (factory === undefined) return {};
  try {
    return { agent: factory(guard, history, seams, bot) };
  } catch (cause) {
    return { failure: toError(cause).message };
  }
}

function siblingTitles(core: AppCore, selfId: string): readonly string[] {
  return core
    .snapshot()
    .panes.filter((pane) => pane.id !== selfId)
    .map((pane) => pane.title.split(" ·")[0] ?? pane.title);
}

function readWorkspaceFile(path: string): string | undefined {
  try {
    return readFileSync(resolve(process.cwd(), path), "utf8");
  } catch {
    return undefined;
  }
}
