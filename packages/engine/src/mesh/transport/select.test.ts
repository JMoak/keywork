import { describe, expect, it } from "vitest";
import { defaultTransport, discoverMacEndpoint, type MacProbe, macSocketPath } from "./select.ts";

const nothing = () => Promise.reject(new Error("absent"));

function probe(overrides: Partial<MacProbe>): MacProbe {
  return {
    appStoreProof: nothing,
    standalonePort: nothing,
    standaloneToken: nothing,
    ...overrides,
  };
}

describe("defaultTransport", () => {
  it("reads the CLI on Windows", () => {
    expect(defaultTransport({ platform: "win32" }).name).toBe("cli");
  });

  it("keeps the named pipe behind a flag on Windows, falling back to the CLI", () => {
    expect(defaultTransport({ platform: "win32", windowsPipe: true }).name).toBe(
      "localapi (falls back to cli)",
    );
  });

  it.each(["linux", "darwin", "freebsd"] as const)(
    "speaks the LocalAPI on %s with the CLI behind it",
    (platform) => {
      expect(defaultTransport({ platform }).name).toBe("localapi (falls back to cli)");
    },
  );
});

describe("discoverMacEndpoint", () => {
  it("prefers the App Store extension's same-user proof", async () => {
    const lsof =
      "p123\nn/private/var/folders/x/.tailscale.ipn.macos/sameuserproof-61822-0a1b2c3d\n";
    const endpoint = await discoverMacEndpoint(probe({ appStoreProof: async () => lsof }));
    expect(endpoint).toEqual({ kind: "tcp", port: 61822, token: "0a1b2c3d" });
  });

  it("falls to the standalone port and token files", async () => {
    const endpoint = await discoverMacEndpoint(
      probe({
        appStoreProof: async () => "p123\n",
        standalonePort: async () => "51234",
        standaloneToken: async (port) => (port === "51234" ? "f00d\n" : ""),
      }),
    );
    expect(endpoint).toEqual({ kind: "tcp", port: 51234, token: "f00d" });
  });

  it("falls to the open-source daemon's socket when neither GUI variant answers", async () => {
    expect(await discoverMacEndpoint(probe({}))).toEqual({ kind: "socket", path: macSocketPath });
  });

  it("ignores a token it cannot read", async () => {
    const endpoint = await discoverMacEndpoint(
      probe({ standalonePort: async () => "51234", standaloneToken: async () => "  " }),
    );
    expect(endpoint).toEqual({ kind: "socket", path: macSocketPath });
  });
});
