import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockProvider } from "../mock-provider.ts";
import type { Provider, ProviderRequest, TurnDelta } from "../provider.ts";
import type { PersistentShell } from "../tools/shell-session.ts";

export interface RecordingProvider extends Provider {
  readonly requests: ProviderRequest[];
}

export function recordingProvider(
  script?: TurnDelta[][],
  identity: { name?: string; modelId?: string } = {},
): RecordingProvider {
  const inner = script === undefined ? undefined : new MockProvider(script);
  const requests: ProviderRequest[] = [];
  return {
    name: identity.name ?? "recording",
    ...(identity.modelId !== undefined && { modelId: identity.modelId }),
    requests,
    stream: (request: ProviderRequest) => {
      requests.push(request);
      return inner === undefined ? okTurn() : inner.stream(request);
    },
  };
}

export interface RecordingShell extends PersistentShell {
  readonly commands: readonly string[];
}

export function recordingShell(): RecordingShell {
  const commands: string[] = [];
  return {
    shellName: "a recording shell",
    commands,
    run: async (command, options = {}) => {
      options.signal?.throwIfAborted();
      commands.push(command);
      const output = `ran ${command}`;
      options.onOutput?.(output);
      return output;
    },
    close: async () => undefined,
  };
}

async function* okTurn(): AsyncIterable<TurnDelta> {
  yield { type: "text", text: "ok" };
  yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
}

export const lspFixtureServerPath = fileURLToPath(
  new URL("./lsp-fixture-server.ts", import.meta.url),
);

export interface LanguageServerShim {
  dir: string;
  marker: string;
  trace: string;
}

export function installLanguageServerShim(
  dir: string,
  name: string,
  profile: string,
): LanguageServerShim {
  const marker = join(dir, `${name}.pid`);
  const trace = join(dir, `${name}.trace`);
  const argv = [lspFixtureServerPath, profile, marker, trace];
  if (process.platform === "win32") {
    const quoted = [process.execPath, ...argv].map((part) => `"${part}"`).join(" ");
    writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\n${quoted} %*\r\n`);
  } else {
    const quoted = [process.execPath, ...argv].map((part) => `'${part}'`).join(" ");
    writeFileSync(join(dir, name), `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o755 });
  }
  return { dir, marker, trace };
}

export const extensionFixturesDir = fileURLToPath(
  new URL("./extension-fixtures/", import.meta.url),
);
