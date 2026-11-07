import { parseRoutine } from "./routine.ts";
import { RoutineStore } from "./store.ts";
import { routineInput } from "./testing.ts";

export const crashFiredAt = Date.parse("2026-11-05T09:00:00Z");

export const crashEffectKey = `deliver:wren/triage/${crashFiredAt}`;

export const crashEffectParams = { destination: { kind: "conversation" } };

if (import.meta.main) await startEffectThenDie(process.argv[2] ?? "", process.argv[3] ?? "");

async function startEffectThenDie(databasePath: string, routineFile: string): Promise<void> {
  const store = await RoutineStore.open(databasePath);
  store.index("wren", "triage", routineFile, parseRoutine(routineInput()), crashFiredAt - 60_000);
  const run = store.insertRun({
    creature: "wren",
    routineId: "triage",
    attempt: 1,
    trigger: "cron",
    catchUp: false,
    firedAt: crashFiredAt,
    scheduledFor: crashFiredAt,
    status: "running",
  });
  store.markHandled("wren", "triage", crashFiredAt);
  store.startRun(run?.runId ?? "", "session-1", crashFiredAt);
  store.beginEffect(crashEffectKey, run?.runId ?? "", "deliver", crashEffectParams, crashFiredAt);
  process.stdout.write(`effect started under ${process.versions.bun ? "bun" : "node"}\n`);
  process.kill(process.pid, "SIGKILL");
  store.completeEffect(crashEffectKey, { delivered: true }, crashFiredAt);
  process.stdout.write("effect recorded\n");
}
