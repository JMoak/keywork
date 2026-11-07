import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { cliTransport } from "./cli.ts";
import { type EndpointSource, type LocalApiEndpoint, localApiTransport } from "./localapi.ts";
import { type TailscaleTransport, TransportRefusedError, withFallback } from "./transport.ts";

export interface TransportPreferences {
  platform?: NodeJS.Platform | undefined;
  windowsPipe?: boolean | undefined;
  socketPath?: string | undefined;
  cliCommand?: readonly string[] | undefined;
  timeoutMs?: number | undefined;
  macProbe?: MacProbe | undefined;
}

export interface MacProbe {
  appStoreProof(): Promise<string>;
  standalonePort(): Promise<string>;
  standaloneToken(port: string): Promise<string>;
}

export const linuxSocketPath = "/var/run/tailscale/tailscaled.sock";
export const macSocketPath = "/var/run/tailscaled.socket";
export const windowsPipePath =
  "\\\\.\\pipe\\ProtectedPrefix\\Administrators\\Tailscale\\tailscaled";

export function defaultTransport(preferences: TransportPreferences = {}): TailscaleTransport {
  const platform = preferences.platform ?? process.platform;
  const cli = cliTransport({ command: preferences.cliCommand, timeoutMs: preferences.timeoutMs });
  const localApi = (endpoint: EndpointSource) =>
    withFallback(localApiTransport({ endpoint, timeoutMs: preferences.timeoutMs }), cli);
  if (platform === "win32") {
    // Bun cannot open tailscaled's named pipe (FailedToOpenSocket) and Node's pipe client
    // lacks the impersonation level tailscaled demands (401), so Windows reads the CLI.
    return preferences.windowsPipe === true
      ? localApi({ kind: "socket", path: preferences.socketPath ?? windowsPipePath })
      : cli;
  }
  if (platform === "darwin") {
    const probe = preferences.macProbe ?? systemMacProbe;
    const socketPath = preferences.socketPath;
    return localApi(() =>
      socketPath === undefined ? discoverMacEndpoint(probe) : Promise.resolve(socketAt(socketPath)),
    );
  }
  return localApi(socketAt(preferences.socketPath ?? linuxSocketPath));
}

export async function discoverMacEndpoint(probe: MacProbe): Promise<LocalApiEndpoint> {
  const appStore = await attempt(() => probe.appStoreProof());
  const proof = /\.tailscale\.ipn\.macos\/sameuserproof-(\d+)-([0-9a-f]+)/.exec(appStore ?? "");
  if (proof?.[1] !== undefined && proof[2] !== undefined) {
    return { kind: "tcp", port: Number(proof[1]), token: proof[2] };
  }
  const port = await attempt(() => probe.standalonePort());
  const token = port === null ? null : await attempt(() => probe.standaloneToken(port));
  if (port !== null && token !== null && token.trim() !== "" && /^\d+$/.test(port)) {
    return { kind: "tcp", port: Number(port), token: token.trim() };
  }
  return socketAt(macSocketPath);
}

export const systemMacProbe: MacProbe = {
  appStoreProof: () =>
    runText("lsof", ["-n", "-a", `-u${userInfo().uid}`, "-c", "IPNExtension", "-F"]),
  standalonePort: () => readlink("/Library/Tailscale/ipnport"),
  standaloneToken: (port) => readFile(`/Library/Tailscale/sameuserproof-${port}`, "utf8"),
};

function socketAt(path: string): LocalApiEndpoint {
  return { kind: "socket", path };
}

async function attempt(read: () => Promise<string>): Promise<string | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

function runText(file: string, argv: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...argv], { encoding: "utf8", timeout: 3_000 }, (error, stdout) => {
      if (error !== null && stdout === "") {
        reject(new TransportRefusedError(`${file} failed`, { cause: error }));
        return;
      }
      resolve(stdout);
    });
  });
}
