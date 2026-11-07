import { userInfo } from "node:os";

export interface Account {
  name: string;
  domain: string | null;
  uid: number | null;
}

export const nodeAccountAdr = "adr.node-runs-as-the-logged-in-user";

export function currentAccount(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Account {
  const info = safeUserInfo();
  const name = info?.username ?? env.USERNAME ?? env.USER ?? "";
  if (platform === "win32") return { name, domain: env.USERDOMAIN ?? null, uid: null };
  const uid = info !== undefined && info.uid >= 0 ? info.uid : null;
  return { name, domain: null, uid };
}

export function qualifiedName(account: Account): string {
  return account.domain === null ? account.name : `${account.domain}\\${account.name}`;
}

export function privilegeRefusal(
  account: Account,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const privileged = privilegedIdentity(account, platform);
  if (privileged === undefined) return undefined;
  return `the node runs as the logged-in user and never as ${privileged} (${nodeAccountAdr}); sign in as yourself and run this again`;
}

export const systemRequestRefusal = `the node never runs as SYSTEM or root (${nodeAccountAdr}): it drives workshops and the companion, which need your own signed-in session`;

const windowsServiceAccounts = new Set(["system", "local service", "network service"]);

function privilegedIdentity(account: Account, platform: NodeJS.Platform): string | undefined {
  if (platform === "win32") {
    const name = account.name.toLowerCase();
    if (windowsServiceAccounts.has(name)) return account.name.toUpperCase();
    if (name.endsWith("$")) return `the machine account ${account.name}`;
    return name === "" ? "an unknown account" : undefined;
  }
  if (account.uid === 0 || account.name === "root") return "root";
  return account.name === "" ? "an unknown account" : undefined;
}

function safeUserInfo(): { username: string; uid: number } | undefined {
  try {
    return userInfo();
  } catch {
    return undefined;
  }
}
