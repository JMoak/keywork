import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { rememberFrom } from "./admission.ts";
import { parseMemorySource } from "./sources.ts";
import {
  addresseeFor,
  isStagedWrite,
  MalformedStagedItemError,
  parseStagedMeta,
  type StagedItem,
} from "./staging.ts";
import { MemoryStore } from "./store.ts";

const scratch = scratchDirs("keywork-addressee-");
const clock = () => new Date("2026-11-06T17:20:00.000Z");
const wren = parseMemorySource("creature:wren");

async function vault(): Promise<{ store: MemoryStore; root: string }> {
  const root = await scratch();
  return { store: new MemoryStore({ vaultRoot: root, trusted: true, now: clock }), root };
}

function writes(items: readonly StagedItem[]) {
  return items.filter(isStagedWrite);
}

describe("a staged item's addressee", () => {
  it("records the creature a message was for in the vault's staged sidecar", async () => {
    const { store, root } = await vault();
    await rememberFrom(store, wren, {
      title: "message from wren K3GImfYB",
      body: "hi\n",
      self: "cob",
    });

    const [item] = writes(await store.listStaged());
    expect(item).toMatchObject({ source: "creature:wren", for: "creature:cob" });
    const sidecars = (await readdir(join(root, ".staging"))).filter((name) =>
      name.endsWith(".json"),
    );
    const raw = JSON.parse(await readFile(join(root, ".staging", sidecars[0] ?? ""), "utf8"));
    expect(raw.for).toBe("creature:cob");
  });

  it("addresses the keeper when no creature received the words", async () => {
    const { store } = await vault();
    await rememberFrom(store, parseMemorySource("web:example.com"), {
      title: "Fetched",
      body: "x\n",
    });
    expect(writes(await store.listStaged())[0]?.for).toBe("keeper");
    expect(addresseeFor()).toBe("keeper");
    expect(addresseeFor("cob")).toBe("creature:cob");
  });

  it("reads a sidecar written before addressees as keeper-addressed", async () => {
    const { store, root } = await vault();
    await rememberFrom(store, wren, {
      title: "message from wren 0a1b2c3d",
      body: "old\n",
      self: "cob",
    });
    const sidecar = (await readdir(join(root, ".staging"))).find((name) => name.endsWith(".json"));
    const path = join(root, ".staging", sidecar ?? "");
    const { for: _addressee, ...legacy } = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, `${JSON.stringify(legacy)}\n`);

    expect(writes(await store.listStaged())[0]?.for).toBe("keeper");
  });

  it("refuses an addressee that names neither the keeper nor a creature", () => {
    const raw = JSON.stringify({ kind: "note", target: "N.md", created: "c", for: "everyone" });
    expect(() => parseStagedMeta(raw, ".staging/x.json")).toThrow(MalformedStagedItemError);
  });
});

describe("the staged-change signal", () => {
  it("fires when staging changes and stays quiet for an admitted note", async () => {
    const { store } = await vault();
    let heard = 0;
    const stop = store.onStaged(() => {
      heard += 1;
    });
    await store.writeNote({ title: "Own words", body: "mine\n", provenance: "agent" });
    expect(heard).toBe(0);

    await rememberFrom(store, wren, {
      title: "message from wren K3GImfYB",
      body: "hi\n",
      self: "cob",
    });
    expect(heard).toBe(1);

    const [item] = await store.listStaged();
    await store.discard(item?.id ?? "");
    expect(heard).toBe(2);

    stop();
    await rememberFrom(store, wren, {
      title: "message from wren 11111111",
      body: "again\n",
      self: "cob",
    });
    expect(heard).toBe(2);
  });
});
