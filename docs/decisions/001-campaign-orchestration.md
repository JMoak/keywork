# Campaign orchestration decision

Date: 2026-11-10. Scope: CAM-02. Decision: use a native campaign state machine hosted by Keywork's engine. These experiments establish the approach; production durability remains subject to CAM-03 and its tests.

## Decision and ownership

Keep pure transitions and continuation policy in `@keywork/campaigns`. The engine owns one campaign store and execution host. Use the existing SQLite abstraction for a separate campaign database, with transactional projections, sequenced events, operation intents, budget reservations, and reconciliation receipts. Campaign execution leases are subordinate to the existing shared-runtime owner.

Commit operation identity and reservation before dispatch. Perform external work outside the transaction, then record outcome and usage transactionally. Expected revisions and fencing tokens reject stale controllers. An intent without an acknowledged outcome becomes unknown and waits for reconciliation; reissuing it is not automatic. Cancellation blocks further dispatch and retains outstanding effects and charges. Neither native execution nor LangGraph can promise exactly-once external effects without provider support.

Sessions remain referenced execution records. HTTP/SSE clients consume the authoritative projection and event cursor. Budget admission, authority, adoption, and persistence-probe counters remain campaign decisions.

## Alternatives examined

| Choice | Observed benefit | Integration consequence |
| --- | --- | --- |
| Native transitions with existing SQLite | Atomic revision, event, and reservation updates; existing runtime/effect patterns; no new production dependency | Keywork must implement and test campaign scheduling, recovery, leases, and monitoring. |
| LangGraph 1.7.3 with MemorySaver | Interrupt/resume, branching, and cooperative cancellation worked under Windows and Linux Bun | Checkpoints do not survive restart. Authority, reservations, CAS checks, and effect reconciliation still need application code. |
| LangGraph with official SQLite saver 1.1.0 | Resume in a new Node process worked on Windows | Its better-sqlite3 dependency failed under Windows Bun after native addon installation. A custom saver, another backend, or Node sidecar adds integration work. |

Choose native because campaign invariants still require application transactions and Keywork already provides the storage/runtime boundary. LangGraph's core is not generally incompatible with Bun. Reconsider a graph executor if complex scheduling later provides demonstrated value while the campaign store remains authoritative. A distributed service requires a separate operational need.

## Executed spike

The isolated package pinned `@langchain/langgraph` 1.7.3, `@langchain/core` 1.3.6, `@langchain/langgraph-checkpoint-sqlite` 1.1.0, and `zod` 4.4.3. Bun installed 60 packages in scratch; none were added to Keywork. The SQLite smoke result was obtained after `npm rebuild better-sqlite3`, not just after an install with lifecycle scripts disabled.

The native prototype imports Keywork's real `openSqlite` and `durableTransaction` functions, persists a small projection, events, and intents, and uses a child process that exits after a simulated external write. It is a control experiment, not the production store.

| Runtime and command | Result |
| --- | --- |
| Windows Bun 1.3.14, `bun native.ts` | Pass: eight native scenarios. |
| Windows Node 24.8.0, `node native.ts` | Pass: the same eight scenarios through Node SQLite. |
| Linux Bun 1.3.14 in Keywork-CI, `bun native.ts` | Pass: the same eight scenarios. |
| Windows Bun 1.3.14, `bun langgraph.ts memory` | Pass: five graph control-flow observations. |
| Linux Bun 1.3.14, `bun langgraph.ts memory` | Pass: the same five observations. |
| Windows Node 24.8.0, `node langgraph.ts sqlite` | Pass: the five observations plus process restart and crash/replay. |
| Windows Bun 1.3.14, `SqliteSaver.fromConnString(":memory:")` | Fails with `ERR_DLOPEN_FAILED`: better-sqlite3 unsupported. The same call succeeds under Windows Node. |

Native scenarios covered pause/resume after reopening; stale revision rejection; branching without replacing best; transaction rollback preserving projection/event consistency; child-process exit after a simulated effect; recovery without replaying that unknown effect; reservation retention through recovery/cancellation; and rejecting dispatch after cancellation.

LangGraph observations covered interrupt/resume; pre-interrupt node code executing twice; branches retaining the original checkpoint; an old-checkpoint update branching instead of rejecting a stale mutation; and cooperative AbortSignal cancellation. Its Node SQLite run also resumed an interrupt in another process and deliberately demonstrated an unprotected external write happening twice after crash/resume. These are expected semantics, not a LangGraph defect. A campaign adapter needs the same intent/reconciliation protection as the native host.

No paid-model calls, live external writes, or repository migrations were used. Linux testing used the existing WSL Keywork-CI distro. Linux native-addon checkpointing, compiled binary packaging, forced power loss, and production lease races were not established. These results are not release qualification.

## Implementation constraints

Reuse `openSqlite`, `transaction`, and `durableTransaction` from routines SQLite. Follow `RoutineStore.beginEffect`'s persisted identity pattern, including rejection of identity reuse with different parameters. Do not copy `performEffect`'s generic exception-to-failed classification for paid or remote calls: a missing acknowledgement may mean the effect occurred and must remain unknown.

CAM-03 validates revision and lease fencing atomically, preserves unknown dispatches after restart, and rejects unsupported future schemas without destructive repair. CAM-05 reserves before dispatch and retains unknown charges. Session forks and graph checkpoints do not isolate files; CAM-04 owns candidate workspaces. Preserve runtime activation and compatibility rules.

The reproducer is at `C:/Users/moakj/Documents/Codex/2026-11-08/ther/work/orchestration-spike/`: `package.json`, `bun.lock`, `native.ts`, and `langgraph.ts`. Run the table's commands there. The native script resolves `C:/src/keywork` or `/mnt/c/src/keywork`. These local experiments are not runtime distribution requirements.

## Primary references

LangGraph's [persistence documentation](https://docs.langchain.com/oss/javascript/langgraph/persistence) distinguishes checkpoints from application stores and explains MemorySaver. Its [interrupt documentation](https://docs.langchain.com/oss/javascript/langgraph/interrupts) specifies that a resumed node restarts, including preceding code. [Fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance) assigns idempotency and unknown acknowledgements to application code. [Checkpoint branching](https://docs.langchain.com/oss/javascript/langgraph/use-time-travel) supplies alternate histories; it does not replace revision checks or best-artifact selection.
