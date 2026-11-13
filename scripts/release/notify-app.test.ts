import { describe, expect, it, vi } from "vitest";
import { notifyApp, verifiedPublication } from "./notify-app.ts";

const sourceSha = "a".repeat(40);
const release = { tag_name: "v0.4.1", draft: false, prerelease: false };

function responses(overrides: Partial<typeof release> = {}, sha = sourceSha) {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ ...release, ...overrides }))
    .mockResolvedValueOnce(Response.json({ object: { type: "commit", sha } }))
    .mockResolvedValueOnce(new Response('export const contractVersion = "1.29";\n'));
}

describe("engine publication notification", () => {
  it("derives the version and contract from a public release at its immutable source", async () => {
    const request = responses();
    expect(await verifiedPublication("v0.4.1", sourceSha, request)).toEqual({
      version: "0.4.1",
      sourceSha,
      contract: "1.29",
    });
    expect(request.mock.calls[2]?.[0]).toContain(`/${sourceSha}/packages/server/src/contract.ts`);
  });

  it.each([{ draft: true }, { prerelease: true }, { tag_name: "v0.4.2" }])(
    "rejects an unverified release %j",
    async (invalid) => {
      await expect(verifiedPublication("v0.4.1", sourceSha, responses(invalid))).rejects.toThrow(
        "public stable",
      );
    },
  );

  it("rejects a tag that identifies different source", async () => {
    await expect(
      verifiedPublication("v0.4.1", sourceSha, responses({}, "b".repeat(40))),
    ).rejects.toThrow("published source");
  });

  it("dispatches a data-only event to the fixed downstream repository", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const publication = { version: "0.4.1", sourceSha, contract: "1.29" };
    await notifyApp(publication, "installation-token", request);
    expect(request.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/JMoak/keywork-app/dispatches",
    );
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      event_type: "keywork-engine-published",
      client_payload: publication,
    });
  });

  it("makes missing credentials and failed delivery visible", async () => {
    const publication = { version: "0.4.1", sourceSha, contract: "1.29" };
    await expect(notifyApp(publication, "")).rejects.toThrow("installation token");
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    await expect(notifyApp(publication, "token", request)).rejects.toThrow("HTTP 403");
  });
});
