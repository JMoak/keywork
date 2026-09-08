import { bell, type FocusEvent, notifyOsc9, notifyOsc777, type TerminalFacts } from "./osc.ts";

export type NotificationTransport = "osc777" | "osc9" | "bell" | "off";
export type NotificationPolicy = "auto" | NotificationTransport;

export interface WorkNotice {
  readonly title: string;
  readonly reason: string;
}

export interface WorkSnapshot {
  readonly title: string;
  readonly asks: readonly string[];
  readonly inbox: number;
}

export const defaultInboxThreshold = 3;
export const askReason = "needs you · ask";

export function inboxReason(waiting: number): string {
  return `inbox · ${waiting} waiting`;
}

export function transportFor(
  policy: NotificationPolicy,
  facts: TerminalFacts = {},
): NotificationTransport {
  return policy === "auto" ? notificationTransport(facts) : policy;
}

export function notificationTransport(facts: TerminalFacts = {}): NotificationTransport {
  const env = facts.env ?? process.env;
  const tty = facts.tty ?? process.stdout.isTTY === true;
  if (!tty || env.TERM === "dumb") return "off";
  if (env.TMUX !== undefined) return "bell";
  if (speaksOsc777(env)) return "osc777";
  if (speaksOsc9(env)) return "osc9";
  return "bell";
}

export function notificationBytes(transport: NotificationTransport, notice: WorkNotice): string {
  switch (transport) {
    case "osc777":
      return notifyOsc777(notice.title, notice.reason);
    case "osc9":
      return notifyOsc9(`${notice.title} · ${notice.reason}`);
    case "bell":
      return bell;
    case "off":
      return "";
  }
}

export class Notifier {
  private focused = true;
  private notifiedThisStretch = { ask: false, inbox: false };
  private last: WorkSnapshot = { title: "", asks: [], inbox: 0 };

  constructor(
    private readonly write: (bytes: string) => void,
    readonly transport: NotificationTransport,
    private readonly inboxThreshold = defaultInboxThreshold,
  ) {}

  focusChanged(event: FocusEvent): void {
    this.focused = event === "focus-in";
    if (this.focused) this.notifiedThisStretch = { ask: false, inbox: false };
  }

  observe(snapshot: WorkSnapshot): void {
    const previous = this.last;
    this.last = snapshot;
    if (this.focused || this.transport === "off") return;
    const ask = newlyAsking(previous, snapshot);
    if (ask !== undefined) this.notify("ask", { title: ask, reason: askReason });
    if (crossedInboxThreshold(previous, snapshot, this.inboxThreshold)) {
      this.notify("inbox", { title: snapshot.title, reason: inboxReason(snapshot.inbox) });
    }
  }

  private notify(trigger: "ask" | "inbox", notice: WorkNotice): void {
    if (this.notifiedThisStretch[trigger]) return;
    this.notifiedThisStretch[trigger] = true;
    this.write(notificationBytes(this.transport, notice));
  }
}

function newlyAsking(previous: WorkSnapshot, current: WorkSnapshot): string | undefined {
  if (current.asks.length <= previous.asks.length) return undefined;
  return current.asks.find((title) => !previous.asks.includes(title)) ?? current.asks[0];
}

function crossedInboxThreshold(
  previous: WorkSnapshot,
  current: WorkSnapshot,
  threshold: number,
): boolean {
  return previous.inbox < threshold && current.inbox >= threshold;
}

function speaksOsc777(env: Readonly<Record<string, string | undefined>>): boolean {
  return (
    env.TERM?.startsWith("rxvt") === true ||
    env.TERM_PROGRAM === "ghostty" ||
    env.TERM_PROGRAM === "WezTerm" ||
    env.VTE_VERSION !== undefined
  );
}

function speaksOsc9(env: Readonly<Record<string, string | undefined>>): boolean {
  return (
    env.WT_SESSION !== undefined || env.TERM_PROGRAM === "iTerm.app" || env.TERM === "xterm-kitty"
  );
}
