import type { CapabilityRecord, LocalServerDirectory, ServerKind } from "@keywork/engine";
import type { KeyworkConfig } from "@keywork/shared";
import { describe, expect, it } from "vitest";
import { composeInference } from "./runtime.ts";

const config: KeyworkConfig = {
  connections: { ollama: { endpoint: "http://127.0.0.1:11434/v1", models: ["qwen3"] } },
};

const ollamaRoot = "http://127.0.0.1:11434";

describe("composeInference over the node's local servers", () => {
  it("asks the node's capability directory first when a provider is built", () => {
    const directory = recordingDirectory();
    const runtime = composeInference({ env: {}, config, credentials: {}, localServers: directory });
    const binding = bound(runtime.resolve({ override: "ollama/qwen3" }));

    runtime.provider(binding);

    expect(directory.asked).toEqual([ollamaRoot]);
  });

  it("answers a binding's probed capabilities from the same directory", () => {
    const record = { model: "qwen3" } as CapabilityRecord;
    const directory = recordingDirectory(record);
    const runtime = composeInference({ env: {}, config, credentials: {}, localServers: directory });
    const binding = bound(runtime.resolve({ override: "ollama/qwen3" }));

    expect(runtime.capabilityOf(binding)).toBe(record);
    expect(directory.recorded).toEqual([[ollamaRoot, "qwen3"]]);
  });

  it("knows nothing probed when the node lends it no directory", () => {
    const runtime = composeInference({ env: {}, config, credentials: {} });
    expect(
      runtime.capabilityOf(bound(runtime.resolve({ override: "ollama/qwen3" }))),
    ).toBeUndefined();
  });
});

interface RecordingDirectory extends LocalServerDirectory {
  asked: string[];
  recorded: [string, string][];
}

function recordingDirectory(record?: CapabilityRecord): RecordingDirectory {
  const directory: RecordingDirectory = {
    asked: [],
    recorded: [],
    kindOf: (root): ServerKind | undefined => {
      directory.asked.push(root);
      return undefined;
    },
    record: (root, model) => {
      directory.recorded.push([root, model]);
      return record;
    },
    fieldMemory: () => ({ rejects: () => false, reject: () => undefined }),
  };
  return directory;
}

function bound(resolution: ReturnType<ReturnType<typeof composeInference>["resolve"]>) {
  if (!resolution.ok) throw new Error(resolution.failure.message);
  return resolution.binding;
}
