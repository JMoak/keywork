import {
  type LayeredPolicy,
  layeredPolicy,
  type PermissionRule,
  type RuleLayer,
  type RuleOrigin,
  type Ruling,
  sameRule,
  trustedReadRules,
  withRules,
} from "@keywork/shared";
import type { GrantedScope, PermissionResolver, PermissionRuling } from "./agent.ts";

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

export class PermissionLedger {
  private readonly sessions = new Map<string, PermissionRule[]>();

  constructor(private readonly options: PermissionLedgerOptions) {}

  record(sessionId: string, scope: GrantedScope, rules: readonly PermissionRule[]): void {
    if (scope === "workspace") {
      this.options.workspace.grant(rules);
      return;
    }
    this.sessions.set(sessionId, withRules(this.sessions.get(sessionId) ?? [], rules));
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
      session: Object.fromEntries(this.sessions),
    };
  }

  revokeWorkspace(rule: PermissionRule): boolean {
    return this.options.workspace.revoke(rule);
  }

  revokeSession(sessionId: string, rule: PermissionRule): boolean {
    const held = this.sessions.get(sessionId) ?? [];
    const kept = held.filter((candidate) => !sameRule(candidate, rule));
    if (kept.length === held.length) return false;
    if (kept.length === 0) this.sessions.delete(sessionId);
    else this.sessions.set(sessionId, kept);
    return true;
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
    return sessionId === undefined ? [] : (this.sessions.get(sessionId) ?? []);
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
