import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Disk,
  type JsonFileStore,
  jsonFileStore,
  pathKeyedStringStore,
} from "./json-file-store.ts";

type StringMap = Record<string, string>;

class StoreError extends Error {}

let scratch: string;
let file: string;

function strictStore(disk?: Disk): JsonFileStore<StringMap> {
  return jsonFileStore<StringMap>({
    file,
    disk,
    mode: "strict",
    error: (_file, detail) => new StoreError(detail),
    validate: (data) => data as StringMap,
  });
}

function lenientStore(): JsonFileStore<StringMap> {
  return jsonFileStore<StringMap>({ file, mode: "lenient", validate: (data) => data as StringMap });
}

function plantCorruptFile(): void {
  mkdirSync(join(scratch, "nested"), { recursive: true });
  writeFileSync(file, "{ not json");
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "keywork-json-store-"));
  file = join(scratch, "nested", "data.json");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("jsonFileStore read policy", () => {
  it("reads back what it wrote as pretty JSON with a trailing newline", () => {
    const store = strictStore();
    store.write({ a: "1" });
    expect(store.read()).toEqual({ a: "1" });
    expect(readFileSync(file, "utf8")).toBe('{\n  "a": "1"\n}\n');
  });

  it("reads an absent file as undefined in both modes", () => {
    expect(strictStore().read()).toBeUndefined();
    expect(lenientStore().read()).toBeUndefined();
  });

  it("throws through the error factory on corrupt JSON in strict mode, never replacing it", () => {
    plantCorruptFile();
    expect(() => strictStore().read()).toThrow(StoreError);
    expect(() => strictStore().read()).toThrow(/not valid JSON/);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("throws through the error factory when the file is unreadable in strict mode", () => {
    mkdirSync(file, { recursive: true });
    expect(() => strictStore().read()).toThrow(/unreadable/);
  });

  it("treats corrupt or unreadable files as absent in lenient mode", () => {
    plantCorruptFile();
    expect(lenientStore().read()).toBeUndefined();
    rmSync(file);
    mkdirSync(file, { recursive: true });
    expect(lenientStore().read()).toBeUndefined();
  });

  it("hands parsed JSON to the validator and lets it reject a bad shape", () => {
    mkdirSync(join(scratch, "nested"), { recursive: true });
    writeFileSync(file, JSON.stringify([1, 2, 3]));
    const store = jsonFileStore<StringMap>({
      file,
      mode: "strict",
      error: (_file, detail) => new StoreError(detail),
      validate: (data) => {
        if (Array.isArray(data)) throw new StoreError("expected an object");
        return data as StringMap;
      },
    });
    expect(() => store.read()).toThrow("expected an object");
  });
});

describe("jsonFileStore atomic writes", () => {
  it("stages beside the target and renames into place", () => {
    const calls: string[] = [];
    const disk: Disk = {
      mkdirSync,
      readFileSync,
      chmodSync,
      rmSync,
      writeFileSync: (path, data, options) => {
        calls.push(`write ${basename(String(path))}`);
        return writeFileSync(path, data as string, options);
      },
      renameSync: (from, to) => {
        calls.push(`rename ${basename(String(from))} -> ${basename(String(to))}`);
        renameSync(from, to);
      },
    };
    strictStore(disk).write({ a: "1" });

    expect(calls[0]).toMatch(/^write data\.json\..+\.tmp$/);
    expect(calls[1]).toMatch(/^rename data\.json\..+\.tmp -> data\.json$/);
    expect(readdirSync(join(scratch, "nested"))).toEqual(["data.json"]);
  });

  it("keeps the prior file intact and removes the staging file when a write fails midway", () => {
    strictStore().write({ a: "1" });
    const before = readFileSync(file, "utf8");
    const disk: Disk = {
      mkdirSync,
      readFileSync,
      chmodSync,
      renameSync,
      rmSync,
      writeFileSync: (path, data, options) => {
        writeFileSync(path, String(data).slice(0, 4), options);
        throw new Error("ENOSPC: no space left on device");
      },
    };

    expect(() => strictStore(disk).write({ a: "2" })).toThrow("ENOSPC");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(join(scratch, "nested"))).toEqual(["data.json"]);
  });

  it("writes nothing when serialization itself throws", () => {
    const store = strictStore();
    const poison = {
      toJSON: () => {
        throw new Error("cannot serialize");
      },
    } as unknown as StringMap;
    expect(() => store.write(poison)).toThrow("cannot serialize");
    expect(store.read()).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "locks a private file and its directory to the owner",
    () => {
      jsonFileStore<StringMap>({
        file,
        mode: "lenient",
        private: true,
        validate: (data) => data as StringMap,
      }).write({ a: "1" });

      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(scratch, "nested")).mode & 0o777).toBe(0o700);
    },
  );
});

describe("pathKeyedStringStore", () => {
  it("keys entries by canonical path and shrugs off a corrupt file", () => {
    const store = pathKeyedStringStore(file, "linux");
    expect(store.get("/a/b")).toBeUndefined();
    store.set("/a/b", "root");
    expect(store.get("/a/b")).toBe("root");

    writeFileSync(file, "{ not json");
    const reopened = pathKeyedStringStore(file, "linux");
    expect(reopened.get("/a/b")).toBeUndefined();
    reopened.set("/a/b", "again");
    expect(reopened.get("/a/b")).toBe("again");
  });

  it("keeps only string values from a hand-edited file", () => {
    mkdirSync(join(scratch, "nested"), { recursive: true });
    writeFileSync(file, JSON.stringify({ "/kept": "yes", "/dropped": 7, "/also": null }));
    const store = pathKeyedStringStore(file, "linux");
    store.set("/new", "v");
    const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    expect(written["/kept"]).toBe("yes");
    expect(Object.keys(written)).toHaveLength(2);
    expect(store.get("/new")).toBe("v");
  });

  it("folds case on win32 and keeps it elsewhere", () => {
    const folded = pathKeyedStringStore(file, "win32");
    folded.set("C:\\Src\\Repo", "root");
    expect(folded.get("c:\\src\\repo")).toBe("root");

    rmSync(file, { force: true });
    const cased = pathKeyedStringStore(file, "linux");
    cased.set("/Src/Repo", "root");
    expect(cased.get("/src/repo")).toBeUndefined();
  });
});
