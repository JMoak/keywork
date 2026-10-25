import type { PermissionLedger } from "@keywork/engine";
import type { GrantSink } from "./asks.ts";
import type { EventLog } from "./events.ts";
import { surfaceChanged } from "./routes/answers.ts";

export function servedGrants(ledger: PermissionLedger, log: EventLog): GrantSink {
  return {
    record: (sessionId, scope, rules) => ledger.record(sessionId, scope, rules),
    grantsQuietly: (sessionId, call, rule) => {
      const joined = ledger.grantQuietly(sessionId, call, rule);
      if (joined === undefined) return false;
      if (joined.length > 0) surfaceChanged(log, "permissions");
      return true;
    },
  };
}
