import { EventEmitter } from "node:events";
import { apcaLc, contrastFailures } from "@keywork/shared";
import { describe, expect, it } from "vitest";
import type { DebounceTiming } from "./debounce.ts";
import { keyworkNightFlavor } from "./flavor.ts";
import { colorQueries, type TerminalColors } from "./osc.ts";
import {
  type ColorTransport,
  colorQueryTimeoutMs,
  colorsFromEnv,
  detectTerminalColors,
  queryTerminalColors,
  stdioColorTransport,
  systemFlavor,
  systemTokens,
} from "./system-theme.ts";
import { keyworkNight } from "./theme.ts";

const tokyoNightAnsi = [
  "#15161e",
  "#f7768e",
  "#9ece6a",
  "#e0af68",
  "#7aa2f7",
  "#bb9af7",
  "#7dcfff",
  "#a9b1d6",
  "#414868",
  "#f7768e",
  "#9ece6a",
  "#e0af68",
  "#7aa2f7",
  "#bb9af7",
  "#7dcfff",
  "#c0caf5",
];

const darkTerminal: TerminalColors = {
  background: "#1a1b26",
  foreground: "#c0caf5",
  ansi: new Map(tokyoNightAnsi.map((hex, index) => [index, hex])),
};

const lightTerminal: TerminalColors = {
  background: "#ffffff",
  foreground: "#000000",
  ansi: new Map(),
};

const reply = (selector: string, spec: string): string => `\x1b]${selector};${spec}\x1b\\`;

const fullReply = [
  reply("11", "rgb:1a1a/1b1b/2626"),
  reply("10", "rgb:c0c0/caca/f5f5"),
  ...tokyoNightAnsi.map((hex, index) => reply(`4;${index}`, hex)),
].join("");

describe("systemTokens", () => {
  it("wears the terminal's own ground and ink on a dark terminal", () => {
    const tokens = systemTokens(darkTerminal);
    expect(tokens.background).toBe("#1a1b26");
    expect(tokens.text).toBe("#c0caf5");
    expect(tokens.accent).toBe("#7aa2f7");
    expect(tokens.ramp[0]).toBe(tokens.accent);
    expect(tokens.success).toBe("#9ece6a");
    expect(tokens.error).toBe("#f7768e");
  });

  it("clears every contrast floor on dark, light, and pure-black grounds", () => {
    for (const colors of [
      darkTerminal,
      lightTerminal,
      { background: "#000000", ansi: new Map() },
      { background: "#fdf6e3", foreground: "#657b83", ansi: new Map() },
    ]) {
      const flavor = systemFlavor(colors);
      expect(contrastFailures(flavor)).toEqual([]);
    }
  });

  it("deepens a light terminal's bright ANSI inks until they read", () => {
    const tokens = systemTokens(lightTerminal);
    expect(apcaLc(tokens.success, tokens.background)).toBeGreaterThanOrEqual(40);
    expect(apcaLc(tokens.error, tokens.background)).toBeGreaterThanOrEqual(40);
    expect(apcaLc(tokens.accent, tokens.background)).toBeGreaterThanOrEqual(40);
    expect(apcaLc(tokens.text, tokens.panelLift)).toBeGreaterThanOrEqual(60);
  });

  it("lifts a foreground that sits too close to the ground", () => {
    const tokens = systemTokens({ background: "#1a1b26", foreground: "#3b4261", ansi: new Map() });
    expect(apcaLc(tokens.text, tokens.background)).toBeGreaterThanOrEqual(60);
  });
});

describe("systemFlavor", () => {
  it("names the flavor system and reads polarity from the ground", () => {
    expect(systemFlavor(darkTerminal).appearance).toBe("dark");
    expect(systemFlavor(lightTerminal).appearance).toBe("light");
    expect(systemFlavor(darkTerminal).name).toBe("system");
  });

  it("falls back to the default flavor under the system name when the terminal stays silent", () => {
    const flavor = systemFlavor(undefined);
    expect(flavor.name).toBe("system");
    expect(flavor.tokens).toEqual(keyworkNight);
    expect(flavor.appearance).toBe(keyworkNightFlavor.appearance);
  });
});

describe("queryTerminalColors", () => {
  it("writes the queries and resolves as soon as every reply has arrived", async () => {
    const terminal = fakeTerminal();
    const pending = queryTerminalColors(terminal.transport, terminal.clock);
    expect(terminal.written).toEqual([colorQueries()]);
    terminal.reply(fullReply.slice(0, 40));
    terminal.reply(fullReply.slice(40));
    const colors = await pending;
    expect(colors?.background).toBe("#1a1b26");
    expect(colors?.foreground).toBe("#c0caf5");
    expect(colors?.ansi.get(15)).toBe("#c0caf5");
    expect(terminal.listeners()).toBe(0);
    expect(terminal.clock.pending()).toBe(0);
  });

  it("settles for the ground alone when the timeout passes", async () => {
    const terminal = fakeTerminal();
    const pending = queryTerminalColors(terminal.transport, terminal.clock);
    terminal.reply(reply("11", "rgb:ffff/ffff/ffff"));
    terminal.clock.advance(colorQueryTimeoutMs);
    const colors = await pending;
    expect(colors?.background).toBe("#ffffff");
    expect(colors?.ansi.size).toBe(0);
    expect(terminal.listeners()).toBe(0);
  });

  it("gives up gracefully when the terminal never answers", async () => {
    const terminal = fakeTerminal();
    const pending = queryTerminalColors(terminal.transport, terminal.clock);
    terminal.clock.advance(colorQueryTimeoutMs);
    expect(await pending).toBeUndefined();
  });
});

describe("colorsFromEnv", () => {
  it("reads COLORFGBG as xterm indices", () => {
    expect(colorsFromEnv({ COLORFGBG: "15;0" })).toEqual({
      foreground: "#ffffff",
      background: "#000000",
      ansi: new Map(),
    });
    expect(colorsFromEnv({ COLORFGBG: "0;default;15" })?.background).toBe("#ffffff");
  });

  it("stays silent when the variable is missing or malformed", () => {
    expect(colorsFromEnv({})).toBeUndefined();
    expect(colorsFromEnv({ COLORFGBG: "default" })).toBeUndefined();
    expect(colorsFromEnv({ COLORFGBG: "7;99" })).toBeUndefined();
  });
});

describe("detectTerminalColors", () => {
  it("skips the query off a tty or on a dumb terminal and falls back to the environment", async () => {
    const terminal = fakeTerminal();
    const piped = await detectTerminalColors({
      env: { COLORFGBG: "15;0" },
      tty: false,
      transport: terminal.transport,
    });
    expect(piped?.background).toBe("#000000");
    const dumb = await detectTerminalColors({
      env: { TERM: "dumb" },
      tty: true,
      transport: terminal.transport,
    });
    expect(dumb).toBeUndefined();
    expect(terminal.written).toEqual([]);
  });

  it("prefers the terminal's answer over the environment", async () => {
    const terminal = fakeTerminal();
    const pending = detectTerminalColors({
      env: { COLORFGBG: "15;0" },
      tty: true,
      transport: terminal.transport,
      timing: terminal.clock,
    });
    terminal.reply(fullReply);
    expect((await pending)?.background).toBe("#1a1b26");
  });
});

describe("stdioColorTransport", () => {
  it("borrows raw mode for the reply and hands the stream back untouched", () => {
    const input = fakeInput();
    const output = { write: (bytes: string) => output.bytes.push(bytes), bytes: [] as string[] };
    const transport = stdioColorTransport(
      input as unknown as Parameters<typeof stdioColorTransport>[0],
      output as unknown as NodeJS.WriteStream,
    );
    const heard: string[] = [];
    const stop = transport.onData((bytes) => heard.push(bytes));
    transport.write("query");
    input.emit("data", Buffer.from("answer"));
    expect(input.raw).toBe(true);
    expect(input.flowing).toBe(true);
    expect(heard).toEqual(["answer"]);
    stop();
    input.emit("data", Buffer.from("late"));
    expect(heard).toEqual(["answer"]);
    expect(input.raw).toBe(false);
    expect(input.flowing).toBe(false);
    expect(output.bytes).toEqual(["query"]);
  });
});

interface FakeTerminal {
  transport: ColorTransport;
  clock: FakeClock;
  written: string[];
  reply(bytes: string): void;
  listeners(): number;
}

function fakeTerminal(): FakeTerminal {
  const written: string[] = [];
  const listeners = new Set<(bytes: string) => void>();
  return {
    written,
    clock: fakeClock(),
    transport: {
      write: (bytes) => written.push(bytes),
      onData: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    reply: (bytes) => {
      for (const listener of [...listeners]) listener(bytes);
    },
    listeners: () => listeners.size,
  };
}

interface FakeClock extends DebounceTiming {
  advance(ms: number): void;
  pending(): number;
}

function fakeClock(): FakeClock {
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  return {
    now: () => now,
    after: (delayMs, run) => {
      const timer = { at: now + delayMs, run };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      };
    },
    advance: (ms) => {
      now += ms;
      for (const timer of timers.filter((entry) => entry.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    },
    pending: () => timers.length,
  };
}

function fakeInput() {
  const emitter = new EventEmitter() as EventEmitter & {
    raw: boolean;
    flowing: boolean;
    isRaw: boolean;
    setRawMode(raw: boolean): void;
    resume(): void;
    pause(): void;
  };
  emitter.raw = false;
  emitter.isRaw = false;
  emitter.flowing = false;
  emitter.setRawMode = (raw) => {
    emitter.raw = raw;
    emitter.isRaw = raw;
  };
  emitter.resume = () => {
    emitter.flowing = true;
  };
  emitter.pause = () => {
    emitter.flowing = false;
  };
  return emitter;
}
