import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { meshKeysFile } from "../mesh/pairing/keys.ts";
import { routinesStateOf } from "./state.ts";

describe("routinesStateOf", () => {
  it("keeps the journal and the outputs under the node state root the mesh keys share", () => {
    const stateDir = join("home", ".keywork", "node");
    const state = routinesStateOf(stateDir);
    expect(state).toEqual({
      dir: join(stateDir, "routines"),
      database: join(stateDir, "routines", "routines.db"),
      outputs: join(stateDir, "routines", "outputs"),
    });
    expect(meshKeysFile(stateDir).startsWith(stateDir)).toBe(true);
  });
});
