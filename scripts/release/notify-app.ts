import { readGithubRelease } from "./github-release.ts";

export interface EnginePublication {
  version: string;
  sourceSha: string;
  contract: string;
}

export async function verifiedPublication(
  tag: string,
  sourceSha: string,
  request: typeof fetch = fetch,
): Promise<EnginePublication> {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) {
    throw new Error("Expected a stable release tag");
  }
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("Expected a full source SHA");
  const release = await readGithubRelease(`tags/${tag}`, request);
  if (!release || release.draft || release.prerelease || release.tag_name !== tag) {
    throw new Error(`${tag} is not a public stable release`);
  }
  const response = await request(`https://api.github.com/repos/JMoak/keywork/git/ref/tags/${tag}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GH_TOKEN ?? ""}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Cannot verify published tag: HTTP ${response.status}`);
  const ref = (await response.json()) as { object?: { type?: string; sha?: string } };
  if (ref.object?.type !== "commit" || ref.object.sha !== sourceSha) {
    throw new Error(`${tag} does not identify the published source ${sourceSha}`);
  }
  const contractResponse = await request(
    `https://raw.githubusercontent.com/JMoak/keywork/${sourceSha}/packages/server/src/contract.ts`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!contractResponse.ok) throw new Error("Cannot read the published engine contract");
  const contract = (await contractResponse.text()).match(
    /^export const contractVersion = "(\d+\.\d+)";$/m,
  )?.[1];
  if (!contract) throw new Error("Published source names no engine contract");
  return { version: tag.slice(1), sourceSha, contract };
}

export async function notifyApp(
  publication: EnginePublication,
  token: string,
  request: typeof fetch = fetch,
): Promise<void> {
  if (!token) throw new Error("A dependency GitHub App installation token is required");
  const response = await request("https://api.github.com/repos/JMoak/keywork-app/dispatches", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ event_type: "keywork-engine-published", client_payload: publication }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 204)
    throw new Error(`Engine notification failed: HTTP ${response.status}`);
}

if (import.meta.main) {
  const publication = await verifiedPublication(
    process.env.RELEASE_TAG ?? "",
    process.env.RELEASE_SHA ?? "",
  );
  await notifyApp(publication, process.env.DEPENDENCY_TOKEN ?? "");
  console.log(`Notified keywork-app of verified keywork ${publication.version}`);
}
