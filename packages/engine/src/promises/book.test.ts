import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { hourMs, minuteMs } from "../routines/clock.ts";
import type { QuestionChoice } from "../routines/service.ts";
import { RoutineHarness, routineInput } from "../routines/testing.ts";
import { type ActionOutcome, PromiseBook } from "./book.ts";
import { ModelWatch } from "./models.ts";

let harness: RoutineHarness;

afterEach(async () => {
  await harness.close();
});

describe("a broken promise", () => {
  it("ends a failed repair in one question with its choices, and answering does the chosen thing", async () => {
    harness = await RoutineHarness.create({ start: Date.parse("2026-11-05T08:00:00Z") });
    const file = await harness.writeRoutine(
      routineInput({ trigger: { kind: "interval", minutes: 60 } }),
    );
    await harness.service.start();
    harness.runner.refuseWith = "the provider refused the key";
    await harness.advance(61 * minuteMs);
    for (let index = 0; index < 4; index++) await harness.advance(5 * minuteMs);
    const book = promiseBook();

    const asked = await book.view("wren");
    expect(asked?.promises[0]).toMatchObject({
      kind: "chores-ran",
      state: "broken",
      repairs: [expect.objectContaining({ outcome: "failed", tries: 5, bound: 5 })],
    });
    expect(asked?.questions).toEqual([
      expect.objectContaining({
        id: "chore-triage",
        sentence: 'Wren\'s chore "Morning triage" kept failing, so it stopped. Try it again?',
        address: null,
        lastFailure: "the run could not start: the provider refused the key",
        choices: [
          { id: "retry", label: "Try again" },
          { id: "model", label: "Choose another model", models: [spare] },
          { id: "off", label: "Turn the chore off" },
        ],
      }),
    ]);

    const retried = await book.answer("wren", "chore-triage", { choice: "retry" });
    await harness.service.drain();
    expect(retried).toMatchObject({ done: "Morning triage is trying again now." });
    expect(harness.store.runs("wren", "triage", 10)).toHaveLength(6);
    expect((await book.view("wren"))?.questions.map(({ id }) => id)).toEqual(["chore-triage"]);
    await harness.advance(3 * hourMs);
    expect(harness.store.runs("wren", "triage", 10)).toHaveLength(6);

    const off = await book.answer("wren", "chore-triage", { choice: "off" });
    expect(off).toMatchObject({
      done: "Morning triage is off. It runs again only when you turn it on.",
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ enabled: false });
    expect((await book.view("wren"))?.questions).toEqual([]);
    expect(harness.service.needsYou()).toEqual([]);
  });
});

const spare = { provider: "spare", model: "puppet:7b" };

function promiseBook(): PromiseBook {
  const answer = async (routineId: string, choice: QuestionChoice): Promise<ActionOutcome> => {
    const outcome = await harness.service.answer("wren", routineId, choice);
    if (typeof outcome === "string") return { refusal: outcome };
    return "refusal" in outcome ? outcome : outcome.done;
  };
  return new PromiseBook({
    watch: new ModelWatch({ probe: async () => false, clock: harness.clock }),
    sources: {
      name: async () => "Wren",
      chores: async (creature) => {
        const journals = await harness.service.journalOf(creature);
        return typeof journals === "string" ? [] : journals;
      },
      choreBound: 5,
      models: async () => [],
      choreModel: async () => undefined,
      workshop: async () => [],
      gates: async () => [],
      usable: async () => () => [spare],
    },
    actions: {
      retryChore: (_creature, routineId) => answer(routineId, "retry"),
      turnOffChore: (_creature, routineId) => answer(routineId, "off"),
      chooseModel: async () => "chosen",
    },
  });
}
