import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Campaign, type CampaignWorkload, currentPurpose } from "@keywork/campaigns";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { SkillDefinition } from "../extensions/skills.ts";
import type { ToolResultPart } from "../messages.ts";
import type { Provider, ProviderRequest, TurnDelta } from "../provider.ts";
import { CampaignArtifacts } from "./artifacts.ts";
import { CampaignCartridges } from "./cartridges.ts";
import { type CampaignExecutorOptions, campaignExecutor } from "./executor.ts";
import { OpenRouterQuoteCache } from "./pricing.ts";
import { CampaignService } from "./service.ts";
import { CampaignStore } from "./store.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("campaign executor integration", () => {
  it.each<CampaignWorkload>(["app-improvement", "project-development", "research-refinement"])(
    "refines %s through isolated work, independent review, and bounded persistence",
    async (workload) => {
      const world = await environment(improvementScript, { workload });
      await world.start();
      const final = world.campaign();
      expect(final.status, `${final.statusReason}; ${world.notices.join("; ")}`).toBe("completed");
      expect(final.currentBestArtifactId).not.toBe(final.baselineArtifactId);
      expect(final.attempts).toHaveLength(3);
      expect(final.persistence.probesUsed).toBe(2);
      expect(final.verification).toBe("partial");
      expect(final.achievements).toHaveLength(1);
      expect(final.achievements[0]).toMatchObject({ status: "observed", verifiedBy: null });
      const independent = final.evidence.filter((item) => item.kind !== "claim");
      expect(independent).toHaveLength(1);
      expect(independent[0]).toMatchObject({ kind: "critique", verdict: "pass" });
      expect(independent[0]?.sourceRefs).toHaveLength(2);
      expect(final.evidence.filter((item) => item.kind === "claim")).toHaveLength(3);
      expect(await readFile(world.source, "utf8")).toBe(originalText);
      const preview = await world.service.artifact(
        final.id,
        final.currentBestArtifactId ?? "",
        "brief.md",
      );
      expect(preview.content).toBe(improvedText);
      const reviews = world.requests.filter((request) =>
        request.tools.some((tool) => tool.name === "submit_evaluation"),
      );
      expect(reviews).toHaveLength(3);
      expect(
        reviews.every((request) =>
          request.tools.every((tool) =>
            ["inspect_artifact", "submit_evaluation", "read_campaign_evidence"].includes(tool.name),
          ),
        ),
      ).toBe(true);
      expect(
        reviews.every(
          (request) => !JSON.stringify(request.messages).includes("BUILDER_PRIVATE_ASSERTION"),
        ),
      ).toBe(true);
      expect(
        world.requests.every(
          (request) => request.retry === "never" && request.maxOutputTokens === 512,
        ),
      ).toBe(true);
      expect(world.store.spending(final.id)).toMatchObject({
        settledMicros: world.requests.length * 100,
        reservedMicros: 0,
        unresolvedOperations: 0,
      });
      expect(final.contexts).toHaveLength(world.requests.length);
      expect(final.contexts.every((context) => context.estimatedTokens <= 24_000)).toBe(true);
      const journals = await sessionText(world.sessionRoot);
      expect(journals).toContain("campaign-inspection");
      expect(journals).toContain("inspection:");
      expect(journals).toContain(improvedText.trim());
      expect(world.notices).toEqual([]);
    },
  );

  it("skips paid review when the candidate bytes are unchanged", async () => {
    const world = await environment(unchangedScript);
    await world.start();
    const final = world.campaign();
    expect(final.status).toBe("completed");
    expect(final.currentBestArtifactId).toBe(final.baselineArtifactId);
    expect(final.artifacts).toHaveLength(1);
    expect(final.evaluations).toEqual([]);
    expect(world.requests).toHaveLength(6);
    expect(
      world.requests.every((request) =>
        request.tools.some((tool) => tool.name === "submit_candidate"),
      ),
    ).toBe(true);
    expect(final.usage.every((receipt) => receipt.stage === "building")).toBe(true);
  });

  it("retains a changed artifact without accepting invented inspection references", async () => {
    const world = await environment((turn) => {
      if (turn.stage === "building") return improvementScript(turn);
      if (turn.step === 0) return evaluation(turn, ["inspection:invented"]);
      expect(toolResults(turn.request).at(-1)).toMatchObject({ isError: true });
      return text("I cannot supply evidence.");
    });
    await world.start();
    const final = world.campaign();
    expect(final.status).toBe("waiting");
    expect(final.statusReason).toMatch(/evidence-linked evaluation/);
    expect(final.currentBestArtifactId).toBe(final.baselineArtifactId);
    expect(final.artifacts).toHaveLength(2);
    expect(final.evidence.filter((item) => item.kind !== "claim")).toEqual([]);
    expect(final.achievements).toEqual([]);
    expect(final.attempts[0]).toMatchObject({
      status: "failed",
      candidateArtifactId: final.artifacts.at(-1)?.id,
    });
  });

  it("requires inspection of the current best before accepting claimed improvement", async () => {
    const world = await environment((turn) => {
      if (turn.stage === "building") return improvementScript(turn);
      if (turn.step === 0) return inspectVersions(turn, false);
      if (turn.step === 1) return evaluation(turn, inspectionRefs(turn.request));
      expect(toolResults(turn.request).at(-1)?.output).toContain("current best");
      return text("The comparison is incomplete.");
    });
    await world.start();
    expect(world.campaign()).toMatchObject({ status: "waiting", evaluations: [] });
    expect(world.campaign().evidence.filter((item) => item.kind !== "claim")).toEqual([]);
    expect(world.campaign().currentBestArtifactId).toBe(world.campaign().baselineArtifactId);
  });

  it("never turns a reviewer assertion about unperformed tests into verified execution", async () => {
    const world = await environment(
      (turn) => {
        if (turn.stage !== "evaluating" || turn.step !== 1) return improvementScript(turn);
        return evaluation(
          turn,
          inspectionRefs(turn.request),
          "All tests ran and passed, although no test tool was called.",
        );
      },
      { criteria: ["The executable passes its runtime tests"] },
    );
    await world.start();
    const final = world.campaign();
    expect(final.verification).toBe("partial");
    expect(final.evidence.every((item) => ["critique", "claim"].includes(item.kind))).toBe(true);
    expect(
      final.evidence
        .filter((item) => item.kind === "claim")
        .every((item) => item.verdict === "uncertain"),
    ).toBe(true);
    expect(
      final.achievements.every((item) => item.status === "observed" && item.verifiedBy === null),
    ).toBe(true);
    expect(final.handoff?.unresolved).toContain("The executable passes its runtime tests");
  });

  it("enforces the request allowance before dispatching another paid request", async () => {
    const world = await environment(() => call("read", { path: "brief.md" }), {
      executor: { maxRequestsPerStage: 2 },
    });
    await world.start();
    expect(world.requests).toHaveLength(2);
    expect(world.campaign()).toMatchObject({ status: "waiting", waitingReason: "person" });
    expect(world.campaign().statusReason).toMatch(/request allowance/);
    expect(world.store.operations(world.campaign().id)).toHaveLength(2);
    expect(world.store.spending(world.campaign().id)).toMatchObject({
      settledMicros: 200,
      reservedMicros: 0,
      unresolvedOperations: 0,
    });
  });

  it("preserves worker-reported uncertainty through later attempts and the final handoff", async () => {
    const unresolved = "A screen reader review of the exported artifact remains unperformed.";
    const world = await environment((turn) => {
      if (turn.stageNumber > 1 && turn.step === 0)
        expect(JSON.stringify([turn.request.systemPrompt, turn.request.messages])).toContain(
          unresolved,
        );
      return turn.step === 0
        ? call("submit_candidate", {
            summary: "The content is ready for human inspection.",
            finishProposed: true,
            unresolved: [unresolved],
          })
        : text("The remaining review needs a human.");
    });
    await world.start();
    const final = world.campaign();
    expect(final.status).toBe("completed");
    expect(final.handoff?.unresolved).toContain(unresolved);
    expect(
      final.evidence.some((item) => item.kind === "claim" && item.summary === unresolved),
    ).toBe(true);
    expect(final.verification).toBe("unverified");
    expect(final.achievements.some((item) => item.status === "verified")).toBe(false);
  });

  it("retains a failed dispatched mutation for reconciliation without charging a second request", async () => {
    const world = await environment(() => call("write", { path: "brief.md" }));
    await world.start();
    const final = world.campaign();
    expect(world.requests).toHaveLength(1);
    expect(final).toMatchObject({ status: "waiting", waitingReason: "reconciliation" });
    expect(final.attempts[0]?.status).toBe("unknown");
    const mutations = world.store
      .operations(final.id)
      .filter((operation) => operation.model === null);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({
      state: "unknown",
      maximumMicros: 0,
      receipt: { state: "unknown", costMicros: null },
    });
    expect(world.store.spending(final.id)).toMatchObject({
      settledMicros: 100,
      reservedMicros: 0,
      unresolvedOperations: 1,
    });
    expect(await readFile(world.source, "utf8")).toBe(originalText);
    expect(final.currentBestArtifactId).toBe(final.baselineArtifactId);
  });

  it("rejects overflowing mandatory instructions before any paid dispatch", async () => {
    const world = await environment(unchangedScript, {
      executor: { instructions: async () => "mandatory ".repeat(5000) },
    });
    await world.start();
    expect(world.requests).toEqual([]);
    expect(world.campaign()).toMatchObject({ status: "waiting", waitingReason: "person" });
    expect(world.campaign().statusReason).toMatch(/Required campaign instructions/);
    expect(world.store.operations(world.campaign().id)).toEqual([]);
  });

  it("applies the tool allowance to every call in a single model response before mutation", async () => {
    const world = await environment(
      (turn) => {
        if (turn.stage === "evaluating") return text("The tool allowance needs a fresh decision.");
        if (turn.step === 0)
          return ["first", "second", "forbidden third"].flatMap((content) =>
            call("write", { path: "brief.md", content }),
          );
        const results = toolResults(turn.request);
        expect(results).toHaveLength(3);
        expect(results.filter((result) => !result.isError)).toHaveLength(2);
        expect(results.at(-1)).toMatchObject({ isError: true });
        expect(results.at(-1)?.output).toContain("tool allowance exhausted");
        return text("No further tools are authorized in this stage.");
      },
      { executor: { maxToolsPerStage: 2 } },
    );
    await world.start();
    const final = world.campaign();
    const candidate = final.artifacts.at(-1);
    if (candidate === undefined) throw new Error("Missing retained candidate.");
    expect(await world.artifacts.readText(candidate, "brief.md", 1024)).toBe("second");
    expect(await readFile(world.source, "utf8")).toBe(originalText);
    expect(
      world.store.operations(final.id).filter((operation) => operation.model === null),
    ).toHaveLength(2);
    expect(world.store.spending(final.id).unresolvedOperations).toBe(0);
    expect(final.currentBestArtifactId).toBe(final.baselineArtifactId);
  });

  it("rechecks trust after the model returns and before executing its proposed mutation", async () => {
    let trusted = true;
    const world = await environment(
      () => {
        trusted = false;
        return call("write", { path: "brief.md", content: "unauthorized" });
      },
      { executor: { trusted: () => trusted } },
    );
    await world.start();
    expect(world.requests).toHaveLength(1);
    expect(world.campaign()).toMatchObject({ status: "waiting", waitingReason: "person" });
    expect(world.campaign().statusReason).toContain("trust was revoked");
    expect(await readFile(world.source, "utf8")).toBe(originalText);
    expect(
      world.store.operations(world.campaign().id).filter((operation) => operation.model === null),
    ).toEqual([]);
  });

  it("releases a reservation if trust is revoked before paid dispatch", async () => {
    let trusted = true;
    const world = await environment(unchangedScript, { executor: { trusted: () => trusted } });
    const unsubscribe = world.store.subscribe((event) => {
      if (event.kind === "usage.reserved") trusted = false;
    });
    await world.start();
    unsubscribe();
    expect(world.requests).toEqual([]);
    expect(world.campaign()).toMatchObject({ status: "waiting", waitingReason: "person" });
    expect(world.store.operations(world.campaign().id)).toHaveLength(1);
    expect(world.store.operations(world.campaign().id)[0]?.state).toBe("released");
    expect(world.store.spending(world.campaign().id)).toMatchObject({
      settledMicros: 0,
      reservedMicros: 0,
      unresolvedOperations: 0,
    });
  });

  it("loads only explicitly requested resources from the active pinned cartridge", async () => {
    const resource = "PINNED_RESOURCE_TEXT: retain its qualifications.\r\n";
    const world = await environment(
      (turn) => {
        expect(turn.request.tools.some((tool) => tool.name === "cartridge_resource")).toBe(true);
        expect(turn.request.systemPrompt).toContain("Read guide.md only when needed.");
        expect(turn.request.systemPrompt).not.toContain("PINNED_RESOURCE_TEXT");
        if (turn.step === 0) {
          expect(JSON.stringify(turn.request.messages)).not.toContain("PINNED_RESOURCE_TEXT");
          return call("cartridge_resource", { cartridgeId: "skill:method", path: "guide.md" });
        }
        if (turn.step === 1) {
          expect(toolResults(turn.request).at(-1)).toMatchObject({
            output: resource,
            isError: false,
          });
          return call("cartridge_resource", { cartridgeId: "skill:unselected", path: "guide.md" });
        }
        if (turn.step === 2) {
          expect(toolResults(turn.request).at(-1)).toMatchObject({ isError: true });
          return submitCandidate();
        }
        return text("No forced change is needed.");
      },
      {
        skills: async (root) => {
          const dir = join(root, "trusted-skill");
          await mkdir(dir);
          const file = join(dir, "SKILL.md");
          const body = "Read guide.md only when needed.";
          await writeFile(file, body);
          await writeFile(join(dir, "guide.md"), resource);
          const skill: SkillDefinition = {
            name: "method",
            description: "Use pinned supporting material.",
            body,
            dir,
            file,
            source: "user",
            convention: ".agents/skills",
            authoredBy: undefined,
          };
          return [
            skill,
            {
              ...skill,
              name: "unselected",
              dir: join(root, "absent-skill"),
              file: join(root, "absent-skill", "SKILL.md"),
            },
          ];
        },
      },
    );
    await world.command({
      type: "set-cartridges",
      cartridgeIds: ["skill:method"],
      reason: "Use the selected trusted task method.",
    });
    await world.start();
    expect(world.campaign().status).toBe("completed");
    expect(
      world
        .campaign()
        .cartridges.filter((lock) => lock.status !== "retired")
        .map((lock) => lock.id),
    ).toEqual(["skill:method"]);
    expect(world.campaign().currentBestArtifactId).toBe(world.campaign().baselineArtifactId);
  });

  it("stops growing tool output before the next paid request exceeds the context allowance", async () => {
    const world = await environment(
      (turn) =>
        turn.step === 0 ? call("read", { path: "brief.md" }) : text("Unexpected paid continuation"),
      { source: "evidence ".repeat(2500) },
    );
    await world.start();
    expect(world.requests).toHaveLength(1);
    expect(world.campaign()).toMatchObject({ status: "waiting", waitingReason: "person" });
    expect(world.campaign().statusReason).toMatch(/context budget/);
    expect(world.store.spending(world.campaign().id)).toMatchObject({
      settledMicros: 100,
      reservedMicros: 0,
      unresolvedOperations: 0,
    });
  });

  it("confines rejected artifact writes and never offers shell without a sandbox", async () => {
    const world = await environment((turn) => {
      expect(turn.request.tools.some((tool) => tool.name === "bash")).toBe(false);
      return call("write", { path: world.source, content: "escaped" });
    });
    await world.start();
    expect(await readFile(world.source, "utf8")).toBe(originalText);
    expect(world.campaign().currentBestArtifactId).toBe(world.campaign().baselineArtifactId);
    expect(world.requests).toHaveLength(1);
    expect(world.campaign()).toMatchObject({ status: "waiting", waitingReason: "reconciliation" });
    expect(world.store.spending(world.campaign().id).unresolvedOperations).toBe(1);
  });

  it("stops a dispatched request on cancellation and recovers its unknown receipt without replay", async () => {
    const entered = Promise.withResolvers<void>();
    const world = await environment(async (turn) => {
      entered.resolve();
      await new Promise<never>((_resolve, reject) => {
        const signal = turn.request.signal;
        if (signal === undefined) throw new Error("Missing request abort signal.");
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return text("Unreachable");
    });
    await world.command({ type: "start", reason: "Start" });
    await entered.promise;
    await world.command({ type: "cancel", reason: "Stop immediately" });
    await world.service.settled(world.campaign().id);
    const stopped = world.campaign();
    expect(stopped).toMatchObject({ status: "waiting", waitingReason: "reconciliation" });
    expect(stopped.attempts[0]?.status).toBe("unknown");
    expect(world.requests).toHaveLength(1);
    expect(world.store.spending(stopped.id).reservedMicros).toBeGreaterThan(0);
    await world.close();
    const reopened = await CampaignStore.open(world.database);
    cleanups.push(async () => reopened.close());
    const recovered = new CampaignService({
      store: reopened,
      artifacts: world.artifacts,
      cartridges: world.cartridges,
      workspace: world.workspace,
      ownerScope: "fixture-owner",
      executor: world.executor,
      trusted: () => true,
    });
    recovered.recover();
    expect(reopened.read(stopped.id)).toMatchObject({
      status: "waiting",
      waitingReason: "reconciliation",
    });
    expect(reopened.operations(stopped.id)).toHaveLength(1);
    expect(world.requests).toHaveLength(1);
    const snapshot = recovered.read(stopped.id);
    if (snapshot === undefined) throw new Error("Missing recovered campaign.");
    await expect(
      recovered.command(stopped.id, {
        expectedRevision: snapshot.campaign.revision,
        command: { type: "resume", reason: "Retry" },
      }),
    ).rejects.toThrow(/outstanding attempts/);
    expect(world.requests).toHaveLength(1);
  });
});

type Turn = {
  request: ProviderRequest;
  stage: "building" | "evaluating";
  stageNumber: number;
  step: number;
  campaign: Campaign;
};
type Script = (turn: Turn) => TurnDelta[] | Promise<TurnDelta[]>;
type EnvironmentOptions = {
  workload?: CampaignWorkload;
  criteria?: string[];
  source?: string;
  skills?: (root: string) => Promise<SkillDefinition[]>;
  executor?: Partial<CampaignExecutorOptions>;
};

const originalText = "The original artifact needs one clear improvement.\n";
const improvedText =
  "The revised artifact explains its outcome and remaining uncertainty clearly.\n";
const modelId = "openai/gpt-4.1";

async function environment(script: Script, options: EnvironmentOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "keywork-campaign-executor-"));
  const workspace = join(root, "workspace");
  const source = join(workspace, "brief.md");
  await mkdir(workspace);
  await writeFile(source, options.source ?? originalText);
  const database = join(root, "campaigns.db");
  const store = await CampaignStore.open(database);
  const artifacts = new CampaignArtifacts(join(root, "artifacts"));
  const cartridges = new CampaignCartridges({
    root: join(root, "cartridges"),
    ...(options.skills === undefined ? {} : { skills: await options.skills(root) }),
  });
  const sessionRoot = join(root, "sessions");
  const requests: ProviderRequest[] = [];
  const notices: string[] = [];
  const stages = { building: 0, evaluating: 0 };
  let id = "";
  const campaign = () => {
    const current = store.read(id);
    if (current === undefined) throw new Error("Missing campaign fixture.");
    return current;
  };
  const provider: Provider = {
    name: "openrouter",
    modelId,
    requestSupport: { maxOutputTokens: true, singleAttempt: true, openRouterRouting: true },
    async *stream(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      const stage = request.tools.some((tool) => tool.name === "submit_evaluation")
        ? "evaluating"
        : "building";
      const step = request.messages.filter((message) => message.role === "assistant").length;
      if (step === 0) stages[stage] += 1;
      const deltas = await script({
        request,
        stage,
        stageNumber: stages[stage],
        step,
        campaign: campaign(),
      });
      yield* deltas;
      yield {
        type: "done",
        usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.0001 },
        receipt: {
          usageReported: true,
          requestedModel: modelId,
          servedModel: modelId,
          servedProvider: "OpenAI",
          responseId: randomUUID(),
          finishReason: deltas.some((delta) => delta.type === "tool-call") ? "tool_calls" : "stop",
        },
      };
    },
  };
  const quotes = new OpenRouterQuoteCache({
    fetchFn: async () =>
      Response.json({
        data: {
          id: modelId,
          architecture: {
            tokenizer: "GPT",
            input_modalities: ["text"],
            output_modalities: ["text"],
          },
          endpoints: [
            {
              model_id: modelId,
              provider_name: "OpenAI",
              tag: "openai",
              status: 0,
              service_tier: null,
              context_length: 100_000,
              max_prompt_tokens: null,
              max_completion_tokens: 32768,
              supported_parameters: ["max_tokens", "tools"],
              pricing: { prompt: "0.000002", completion: "0.000008" },
            },
          ],
        },
      }),
  });
  const executor = campaignExecutor({
    artifacts,
    cartridges,
    quotes,
    provider: () => provider,
    instructions: async () => "Preserve source bytes. Work only in the isolated candidate.",
    sessionRoot,
    guardFor: () => ({}),
    permissions: () => "allow",
    trusted: () => true,
    maxOutputTokens: 512,
    ...options.executor,
  });
  const service = new CampaignService({
    store,
    artifacts,
    cartridges,
    workspace,
    ownerScope: "fixture-owner",
    executor,
    trusted: () => true,
    notice: (message) => notices.push(message),
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await service.close();
  };
  cleanups.push(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });
  const created = await service.create({
    title: "Make the artifact useful",
    workload: options.workload ?? "research-refinement",
    objective: "Make the intended outcome and uncertainty clear",
    criteria: options.criteria ?? ["The outcome and uncertainty are clear to the reader"],
    references: [],
    model: { provider: "openrouter", model: modelId },
    budgetMicros: 1_000_000,
    persistenceProfile: "focused",
    artifactPath: "brief.md",
  });
  id = created.campaign.id;
  const command = (value: Record<string, unknown>) =>
    service.command(id, { expectedRevision: campaign().revision, command: value });
  return {
    root,
    workspace,
    source,
    database,
    store,
    artifacts,
    cartridges,
    sessionRoot,
    executor,
    service,
    requests,
    notices,
    campaign,
    close,
    command,
    start: async () => {
      await command({ type: "start", reason: "Start" });
      await service.settled(id);
    },
  };
}

function improvementScript(turn: Turn): TurnDelta[] {
  if (turn.stage === "evaluating") {
    if (turn.step === 0) return inspectVersions(turn);
    if (turn.step === 1) return evaluation(turn, inspectionRefs(turn.request));
    return text("Independent review complete.");
  }
  if (turn.stageNumber > 1) return unchangedScript(turn);
  if (turn.step === 0) return call("read", { path: "brief.md" });
  if (turn.step === 1) return call("write", { path: "brief.md", content: improvedText });
  if (turn.step === 2) return submitCandidate("BUILDER_PRIVATE_ASSERTION: It is perfect.");
  return text("The isolated candidate is ready for independent review.");
}

function unchangedScript(turn: Turn): TurnDelta[] {
  return turn.step === 0 ? submitCandidate() : text("No further worthwhile change.");
}

function submitCandidate(
  summary = "A focused attempt has reached a useful boundary.",
): TurnDelta[] {
  return call("submit_candidate", {
    summary,
    finishProposed: true,
    unresolved: ["Runtime and external behavior remain unchecked"],
  });
}

function inspectVersions(turn: Turn, includeBest = true): TurnDelta[] {
  const candidate = turn.campaign.artifacts.at(-1);
  if (candidate === undefined) throw new Error("Missing candidate.");
  const ids = [
    candidate.id,
    ...(includeBest && turn.campaign.currentBestArtifactId
      ? [turn.campaign.currentBestArtifactId]
      : []),
  ];
  return ids.flatMap((artifactId) =>
    call("inspect_artifact", { artifactId, path: "brief.md", startLine: 1, lineCount: 20 }),
  );
}

function evaluation(
  turn: Turn,
  refs: string[],
  summary = "The candidate clarifies the intended outcome and openly retains uncertainty.",
): TurnDelta[] {
  return call("submit_evaluation", {
    materialImprovement: true,
    summary,
    observations: currentPurpose(turn.campaign).criteria.map((criterion) => ({
      criterionId: criterion.id,
      verdict: "pass",
      summary,
      inspectionRefs: refs,
    })),
  });
}

function inspectionRefs(request: ProviderRequest): string[] {
  return toolResults(request).flatMap((result) => {
    if (result.isError || !result.output.startsWith("{")) return [];
    const parsed = z.object({ ref: z.string() }).safeParse(JSON.parse(result.output));
    return parsed.success ? [parsed.data.ref] : [];
  });
}

function toolResults(request: ProviderRequest): ToolResultPart[] {
  return request.messages.flatMap((message) =>
    message.parts.filter((part): part is ToolResultPart => part.type === "tool-result"),
  );
}

function call(name: string, args: unknown): TurnDelta[] {
  return [
    { type: "tool-call", call: { type: "tool-call", callId: randomUUID(), name, arguments: args } },
  ];
}

function text(value: string): TurnDelta[] {
  return [{ type: "text", text: value }];
}

async function sessionText(root: string): Promise<string> {
  return (
    await Promise.all(
      (
        await readdir(root)
      )
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => readFile(join(root, file), "utf8")),
    )
  ).join("\n");
}
