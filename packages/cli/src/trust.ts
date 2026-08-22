import { type TrustStore, toError } from "@keywork/shared";
import { type CommandIo, resolveCommandIo } from "./command-io.ts";

export function trustCommand(
  action: "trust" | "untrust",
  cwd: string,
  store: TrustStore,
  io: CommandIo = {},
): number {
  const { print, printError } = resolveCommandIo(io);
  try {
    if (action === "trust") store.trust(cwd);
    else store.untrust(cwd);
  } catch (cause) {
    printError(toError(cause).message);
    return 1;
  }
  print(`${cwd} is now ${action === "trust" ? "trusted" : "untrusted"}`);
  print(`saved in ${store.file}. run \`keywork ${opposite(action)}\` to undo`);
  return 0;
}

function opposite(action: "trust" | "untrust"): "trust" | "untrust" {
  return action === "trust" ? "untrust" : "trust";
}
