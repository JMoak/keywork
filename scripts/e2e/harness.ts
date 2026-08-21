import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  sessionChangeFeed,
  sessionPort,
  sessionTreePort,
} from "../../packages/cli/src/sessions.ts";
import { workspaceFile } from "../../packages/cli/src/workspace.ts";
import { Agent, Checkpoints, MockProvider } from "../../packages/engine/src/index.ts";
import { type AppOptions, assumedGlyphs, runApp } from "../../packages/tui/src/index.ts";
import { scenarioArtifactDir, stepFileBase } from "./artifacts.ts";
import type { CapturedFrame } from "./frame.ts";
import { goldenPath, verifyGolden, writeGolden } from "./goldens.ts";
import type { CaptureOptions, FrameSize, Scenario, Stage } from "./scenario.ts";
import { frameToSvg } from "./svg.ts";

export interface HarnessOptions {
  readonly outRoot: string;
  readonly size: FrameSize;
  readonly updateGoldens?: boolean;
  readonly world?: ComposedWorld;
}

export type AppSeams = Pick<AppOptions, "createRenderer" | "exit">;

export interface ComposedWorld {
  readonly workspaceDir: string;
  readonly sessionDir: string;
  compose(seams: AppSeams): Promise<void>;
  dispose(): void;
}

export interface ScenarioResult {
  readonly name: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly artifactDir: string;
  readonly captures: readonly string[];
  readonly goldens: readonly string[];
  readonly exitCode?: number;
}

export async function runScenario(
  scenario: Scenario,
  options: HarnessOptions,
): Promise<ScenarioResult> {
  const artifactDir = freshArtifactDir(options.outRoot, scenario.name);
  const world = options.world ?? temporaryWorld(scenario);
  const size = scenario.size ?? options.size;
  const testing = await loadTesting();
  const previousCwd = process.cwd();
  process.chdir(world.workspaceDir);
  scenario.beforeBoot?.(world);
  const boot = async (): Promise<RunningApp> => {
    const setup = await testing.createTestRenderer({ width: size.width, height: size.height });
    const exit: ExitLatch = { code: undefined };
    await world.compose({
      createRenderer: async () => setup.renderer,
      exit: (code) => {
        exit.code ??= code;
      },
    });
    return { setup, exit };
  };
  const captures: string[] = [];
  const goldens: string[] = [];
  let app: RunningApp | undefined;
  let error: string | undefined;
  try {
    app = await boot();
    await scenario.run(
      buildStage({
        world,
        app,
        reboot: boot,
        scenarioName: scenario.name,
        artifactDir,
        captures,
        goldens,
        updateGoldens: options.updateGoldens === true,
      }),
    );
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    const running = app;
    if (running !== undefined) {
      quietly(() =>
        writeFileSync(join(artifactDir, "failure.txt"), running.setup.captureCharFrame()),
      );
    }
  } finally {
    const running = app;
    if (running !== undefined && running.exit.code === undefined) {
      quietly(() => running.setup.renderer.destroy());
    }
    process.chdir(previousCwd);
    quietly(() => world.dispose());
  }
  return {
    name: scenario.name,
    ok: error === undefined,
    ...(error !== undefined && { error }),
    artifactDir,
    captures,
    goldens,
    ...(app !== undefined && app.exit.code !== undefined && { exitCode: app.exit.code }),
  };
}

type TestingModule = typeof import("@opentui/core/testing");
type TestSetup = Awaited<ReturnType<TestingModule["createTestRenderer"]>>;
type KeyInput = Parameters<TestSetup["mockInput"]["pressKey"]>[0];

interface TemporaryPaths {
  root: string;
  workspaceDir: string;
  sessionDir: string;
}

interface ExitLatch {
  code: number | undefined;
}

interface RunningApp {
  setup: TestSetup;
  exit: ExitLatch;
}

interface StageContext {
  readonly world: ComposedWorld;
  readonly app: RunningApp;
  readonly reboot: () => Promise<RunningApp>;
  readonly scenarioName: string;
  readonly artifactDir: string;
  readonly captures: string[];
  readonly goldens: string[];
  readonly updateGoldens: boolean;
}

const untilTimeoutMs = 10_000;
const quitTimeoutMs = 5_000;
const pollMs = 15;
const escapeParserWindowMs = 50;
const goldenRoot = fileURLToPath(new URL("goldens", import.meta.url));

function loadTesting(): Promise<TestingModule> {
  const anchor = fileURLToPath(new URL("../../packages/tui/src/index.ts", import.meta.url));
  const resolved = Bun.resolveSync("@opentui/core/testing", dirname(anchor));
  return import(pathToFileURL(resolved).href) as Promise<TestingModule>;
}

function freshArtifactDir(outRoot: string, scenarioName: string): string {
  const artifactDir = scenarioArtifactDir(outRoot, scenarioName);
  rmSync(artifactDir, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(artifactDir, { recursive: true });
  return artifactDir;
}

function temporaryWorld(scenario: Scenario): ComposedWorld {
  const root = mkdtempSync(join(tmpdir(), "keywork-e2e-"));
  const workspaceDir = join(root, "workspace");
  const sessionDir = join(root, "sessions");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  for (const [path, content] of Object.entries(scenario.files ?? {})) {
    const target = join(workspaceDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return {
    workspaceDir,
    sessionDir,
    compose: (seams) => composeMockApp(scenario, { root, workspaceDir, sessionDir }, seams),
    dispose: () => rmSync(root, { recursive: true, force: true, maxRetries: 3 }),
  };
}

async function composeMockApp(
  scenario: Scenario,
  paths: TemporaryPaths,
  seams: AppSeams,
): Promise<void> {
  const checkpoints = await Checkpoints.open({
    worktree: paths.workspaceDir,
    gitDir: join(paths.root, "snapshots-git"),
  }).catch(() => undefined);
  const tools = scenario.tools?.(paths.workspaceDir) ?? [];
  const changes = sessionChangeFeed();
  await runApp({
    ...seams,
    ...(scenario.provider !== "none" && {
      agentFactory: (guard, history) =>
        new Agent({
          provider: new MockProvider([...(scenario.turns ?? [])]),
          tools,
          guard,
          ...(history !== undefined && { history }),
        }),
    }),
    ...(scenario.presets !== undefined && { presets: scenario.presets(paths.root) }),
    sessions: sessionPort(paths.sessionDir, paths.workspaceDir, {
      checkpointTag: () => checkpoints?.takeTurnTag(),
      onChange: (sessionId) => changes.emit(sessionId),
    }),
    sessionTrees: sessionTreePort(paths.sessionDir, changes),
    workspace: workspaceFile(join(paths.root, "workspace-state.json"), 0),
    ...(checkpoints !== undefined && { checkpoints }),
    glyphs: assumedGlyphs,
    statusLabel: "keywork e2e",
  });
}

function buildStage(context: StageContext): Stage {
  const { world, app, artifactDir, captures, goldens } = context;
  let ordinal = 0;
  const quit = async (): Promise<number> => {
    app.setup.mockInput.pressKey("q", { ctrl: true });
    const deadline = Date.now() + quitTimeoutMs;
    while (app.exit.code === undefined && Date.now() < deadline) await sleep(pollMs);
    if (app.exit.code === undefined) throw new Error("quit never reached the exit seam");
    return app.exit.code;
  };
  return {
    workspaceDir: world.workspaceDir,
    sessionDir: world.sessionDir,
    press: async (...chords) => {
      for (const chord of chords) {
        pressChord(app.setup, chord);
        if (chord.toLowerCase().endsWith("escape")) await sleep(escapeParserWindowMs);
      }
      await sleep(0);
    },
    type: async (text) => {
      await app.setup.mockInput.typeText(text);
      await sleep(0);
    },
    click: async (x, y) => {
      await app.setup.mockMouse.click(x, y);
      await sleep(0);
    },
    scroll: async (x, y, direction, times = 1) => {
      for (let step = 0; step < times; step += 1) {
        await app.setup.mockMouse.scroll(x, y, direction);
      }
      await sleep(0);
    },
    drag: async (from, to) => {
      await app.setup.mockMouse.drag(from.x, from.y, to.x, to.y);
      await sleep(0);
    },
    settle: () => settle(app.setup),
    until: (marker, timeoutMs = untilTimeoutMs) => frameContaining(app.setup, marker, timeoutMs),
    capture: async (stepName, options?: CaptureOptions) => {
      ordinal += 1;
      const base = stepFileBase(ordinal, stepName);
      const frame = app.setup.captureCharFrame();
      writeFileSync(join(artifactDir, `${base}.txt`), frame);
      writeFileSync(
        join(artifactDir, `${base}.svg`),
        frameToSvg(app.setup.captureSpans() as CapturedFrame),
      );
      captures.push(base);
      if (options?.golden === true) {
        const golden = goldenPath(goldenRoot, context.scenarioName, base);
        if (context.updateGoldens) writeGolden(golden, frame);
        else verifyGolden(golden, frame);
        goldens.push(base);
      }
      return frame;
    },
    evidence: (fileName, content) => {
      const path = join(artifactDir, fileName);
      writeFileSync(path, content);
      return path;
    },
    resize: async (width, height) => {
      app.setup.resize(width, height);
      await settle(app.setup);
    },
    relaunch: async () => {
      await quit();
      Object.assign(app, await context.reboot());
    },
    quit,
  };
}

async function settle(setup: TestSetup): Promise<void> {
  try {
    await setup.waitForVisualIdle({ quietFrames: 2, maxFrames: 240 });
  } catch {
    await setup.renderOnce();
    await setup.renderOnce();
  }
}

async function frameContaining(
  setup: TestSetup,
  marker: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frame = setup.captureCharFrame();
    if (frame.includes(marker)) return frame;
    if (Date.now() >= deadline) {
      throw new Error(`marker never appeared: "${marker}"\nlast frame:\n${frame}`);
    }
    await sleep(pollMs);
  }
}

const namedKeys: Record<string, KeyInput> = {
  enter: "RETURN",
  return: "RETURN",
  escape: "ESCAPE",
  tab: "TAB",
  backspace: "BACKSPACE",
  space: " ",
  up: "ARROW_UP",
  down: "ARROW_DOWN",
  left: "ARROW_LEFT",
  right: "ARROW_RIGHT",
};

function pressChord(setup: TestSetup, spec: string): void {
  const parts = spec.split("+");
  const key = (parts.at(-1) ?? spec).toLowerCase();
  setup.mockInput.pressKey(namedKeys[key] ?? key, {
    ctrl: parts.includes("ctrl"),
    shift: parts.includes("shift"),
    meta: parts.includes("meta"),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quietly(action: () => void): void {
  try {
    action();
  } catch {}
}
