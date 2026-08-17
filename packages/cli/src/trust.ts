import type { TrustStore } from "@keywork/shared";

export interface TrustCommandIo {
  print?: (line: string) => void;
  printError?: (line: string) => void;
}

export function trustCommand(
  action: "trust" | "untrust",
  cwd: string,
  store: TrustStore,
  io: TrustCommandIo = {},
): number {
  const print = io.print ?? console.log;
  const printError = io.printError ?? console.error;
  try {
    if (action === "trust") store.trust(cwd);
    else store.untrust(cwd);
  } catch (cause) {
    printError((cause as Error).message);
    return 1;
  }
  print(`${cwd} is now ${action === "trust" ? "trusted" : "untrusted"}`);
  print(`saved in ${store.file}. run \`keywork ${opposite(action)}\` to undo`);
  return 0;
}

function opposite(action: "trust" | "untrust"): "trust" | "untrust" {
  return action === "trust" ? "untrust" : "trust";
}
