import {
  type LayeredPolicy,
  layeredPolicy,
  type PermissionRule,
  quietGrant,
  type RuleLayer,
  type RuleOrigin,
  type Ruling,
  SessionGrants,
  sameRule,
  trustedReadRules,
  withRules,
} from "@keywork/shared";
import type { GrantedScope, PermissionResolver, PermissionRuling } from "./agent.ts";
import type { ToolCallPart } from "./messages.ts";
import type { AskRule } from "./session/journal.ts";

export interface WorkspaceGrants {
  rules(): readonly PermissionRule[];
  grant(rules: readonly PermissionRule[]): void;
  revoke(rule: PermissionRule): boolean;
}

export interface PermissionsView {
  trusted: boolean;
  bundle: PermissionRule[];
  workspace: PermissionRule[];
  session: Record<string, PermissionRule[]>;
}

export interface PermissionLedgerOptions {
  trusted: boolean;
  workspace: WorkspaceGrants;
  root: string;
  user?: PermissionResolver | undefined;
}

export type SessionRulesListener = (sessionId: string, rules: readonly PermissionRule[]) => void;

export class PermissionLedger {
  private readonly sessions = new Map<string, SessionGrants>();
  private readonly quiet = new Set<string>();
  private readonly sessionRulesListeners = new Set<SessionRulesListener>();

  constructor(private readonly options: PermissionLedgerOptions) {}

  adoptSession(sessionId: string, rules: readonly PermissionRule[]): void {
    this.grantsOf(sessionId).adopt(rules);
  }

  onSessionRules(listener: SessionRulesListener): () => void {
    this.sessionRulesListeners.add(listener);
    return () => this.sessionRulesListeners.delete(listener);
  }

  setQuiet(sessionId: string, on: boolean): void {
    if (on) this.quiet.add(sessionId);
    else this.quiet.delete(sessionId);
  }

  isQuiet(sessionId: string): boolean {
    return this.quiet.has(sessionId);
  }

  quietSessions(): string[] {
    return [...this.quiet];
  }

  grantQuietly(
    sessionId: string,
    call: ToolCallPart,
    rule: AskRule,
  ): readonly PermissionRule[] | undefined {
    if (rule === "trusted" || !this.quiet.has(sessionId)) return undefined;
    const rules = quietGrant(call.name, call.arguments);
    return rules === undefined ? undefined : this.grantSession(sessionId, rules);
  }

  record(sessionId: string, scope: GrantedScope, rules: readonly PermissionRule[]): void {
    if (scope === "workspace") this.options.workspace.grant(rules);
    else this.grantSession(sessionId, rules);
  }

  resolverFor(sessionId?: string): PermissionResolver {
    return (call) =>
      this.options.user?.(call) ??
      engineRuling(this.policyFor(sessionId)(call.name, call.arguments));
  }

  view(): PermissionsView {
    return {
      trusted: this.options.trusted,
      bundle: [...this.bundle()],
      workspace: [...this.options.workspace.rules()],
      session: Object.fromEntries(
        [...this.sessions].flatMap(([sessionId, grants]) =>
          grants.rules.length === 0 ? [] : [[sessionId, [...grants.rules]]],
        ),
      ),
    };
  }

  revokeWorkspace(rule: PermissionRule): boolean {
    return this.options.workspace.revoke(rule);
  }

  revokeSession(sessionId: string, rule: PermissionRule): boolean {
    const revoked = this.sessions.get(sessionId)?.forget(rule) === true;
    if (revoked) this.sessionRulesChanged(sessionId);
    return revoked;
  }

  private grantSession(
    sessionId: string,
    rules: readonly PermissionRule[],
  ): readonly PermissionRule[] {
    const joined = this.grantsOf(sessionId).grant(rules);
    if (joined.length > 0) this.sessionRulesChanged(sessionId);
    return joined;
  }

  private grantsOf(sessionId: string): SessionGrants {
    const known = this.sessions.get(sessionId);
    if (known !== undefined) return known;
    const fresh = new SessionGrants();
    this.sessions.set(sessionId, fresh);
    return fresh;
  }

  private sessionRulesChanged(sessionId: string): void {
    const rules = this.sessionRules(sessionId);
    for (const listener of [...this.sessionRulesListeners]) listener(sessionId, rules);
  }

  private policyFor(sessionId: string | undefined): LayeredPolicy {
    const layers: RuleLayer[] = [
      { origin: "trusted", rules: this.bundle() },
      { origin: "workspace", rules: this.options.workspace.rules() },
      { origin: "session", rules: this.sessionRules(sessionId) },
    ];
    return layeredPolicy(layers, { workspace: this.options.root });
  }

  private sessionRules(sessionId: string | undefined): readonly PermissionRule[] {
    return sessionId === undefined ? [] : (this.sessions.get(sessionId)?.rules ?? []);
  }

  private bundle(): readonly PermissionRule[] {
    return this.options.trusted ? trustedReadRules : [];
  }
}

export function memoryGrants(): WorkspaceGrants {
  let held: PermissionRule[] = [];
  return {
    rules: () => held,
    grant: (rules) => {
      held = withRules(held, rules);
    },
    revoke: (rule) => {
      const kept = held.filter((candidate) => !sameRule(candidate, rule));
      const revoked = kept.length !== held.length;
      held = kept;
      return revoked;
    },
  };
}

function engineRuling(ruling: Ruling | undefined): PermissionRuling | undefined {
  if (ruling === undefined) return undefined;
  const scope = grantedScopeOf(ruling.origin);
  if (scope !== undefined && ruling.effect === "allow") {
    return { permission: "allow", gate: "user", scope };
  }
  return { permission: ruling.effect, gate: ruling.origin === "trusted" ? "trusted" : "policy" };
}

function grantedScopeOf(origin: RuleOrigin): GrantedScope | undefined {
  return origin === "session" || origin === "workspace" ? origin : undefined;
}
