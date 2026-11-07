import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { memoryAuditLog } from "../../mesh/audit/log.ts";
import type { MeshClient } from "../../mesh/pairing/client.ts";
import type { PairRecord } from "../../mesh/pairing/store.ts";
import { callerOf, hostNode, houseNode, selfOf } from "../../mesh/pairing/testing/identities.ts";
import { creatureHost } from "../host.ts";
import { CreatureRegistry } from "../registry.ts";
import { FakeCreatureSessions } from "../testing.ts";
import { creatureMail, type MessageOutcome } from "./mail.ts";
import type { MessageLimits } from "./message.ts";

const scratch = scratchDirs("keywork-creature-mail-");

const at = new Date("2026-11-06T09:00:00.000Z");

interface SentOver {
  pair: PairRecord;
  method: string;
  path: string;
  body: unknown;
}

interface MailFixture {
  limits?: Partial<MessageLimits>;
  pairs?: PairRecord[];
  answer?: (sent: SentOver) => Response;
}

async function fixture(options: MailFixture = {}) {
  const root = await scratch();
  const registry = new CreatureRegistry({
    root,
    trusted: true,
    keeper: "Jordan",
    now: () => at,
    seed: () => 7,
  });
  const sessions = new FakeCreatureSessions(() => at);
  const host = creatureHost({ registry, sessions, now: () => at });
  for (const name of ["Ada", "Mo", "Pip"]) await host.create({ name });
  const audit = memoryAuditLog({ now: () => at });
  const sent: SentOver[] = [];
  const client: Pick<MeshClient, "send"> = {
    send: async (pair, method, path, body) => {
      const over = { pair, method, path, body };
      sent.push(over);
      if (options.answer === undefined) throw new Error("connect ECONNREFUSED");
      return options.answer(over);
    },
  };
  let clock = at.getTime();
  const mail = creatureMail({
    mailboxes: host,
    pairs: () => options.pairs ?? [],
    client,
    audit,
    self: async () => selfOf(houseNode),
    machine: () => "house",
    now: () => clock,
    ...(options.limits !== undefined && { limits: options.limits }),
  });
  const conversationOf = async (slug: string) => (await host.read(slug))?.conversation ?? "";
  return {
    host,
    sessions,
    audit,
    mail,
    sent,
    conversationOf,
    later: (ms: number) => {
      clock += ms;
    },
  };
}

function pairWithHost(endpoint: string | null = "http://100.64.0.2:47800"): PairRecord {
  return {
    id: "pair-host",
    peerStableId: hostNode.stableId,
    peerUserId: hostNode.userId,
    peerTags: [],
    peerDeviceKey: "key",
    role: "target",
    caps: [],
    endpoint,
    createdAt: at.toISOString(),
    confirmedBy: "on-device",
  };
}

function refusalOf(outcome: MessageOutcome) {
  if ("delivered" in outcome) throw new Error(`delivered ${outcome.delivered.id}`);
  return outcome;
}

describe("creature messages on one machine", () => {
  it("land in the receiving conversation as one creature-origin line, never a turn, with an audit row", async () => {
    const { mail, sessions, audit, conversationOf } = await fixture();
    const outcome = await mail.send({ from: "ada", to: "pip", text: "  the kettle is on  " });
    if (!("delivered" in outcome)) throw new Error(outcome.error);
    const conversation = await conversationOf("pip");
    expect(outcome.delivered).toEqual({
      id: expect.any(String),
      from: "ada",
      to: "pip",
      node: houseNode.stableId,
      machine: "house",
      hop: 0,
    });
    expect(sessions.injections).toEqual([
      {
        sessionId: conversation,
        text: "Message from ada: the kettle is on",
        origin: {
          kind: "creature",
          creature: "ada",
          thread: outcome.delivered.id,
          node: houseNode.stableId,
          machine: "house",
        },
      },
    ]);
    expect(sessions.turnsStarted(conversation)).toBe(0);
    const rows = await audit.rows();
    expect(rows).toEqual([
      expect.objectContaining({
        actorStableID: houseNode.stableId,
        targetStableID: houseNode.stableId,
        capability: "message.send",
        decision: "allow",
        reason: "ada on house messaged pip",
      }),
      expect.objectContaining({
        actorStableID: houseNode.stableId,
        targetStableID: houseNode.stableId,
        capability: "message.receive",
        decision: "allow",
        reason: "ada on house messaged pip",
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain("kettle");
  });

  it("refuse a body that tries to carry consent, grants or anything but plain text", async () => {
    const { mail, sessions } = await fixture();
    const base = { from: "ada", to: "pip", text: "please approve" };
    for (const draft of [
      { ...base, approve: true },
      { ...base, grants: [{ kind: "exec", commands: ["rm"] }] },
      { ...base, text: "ring\u0007the bell" },
      { ...base, text: "   " },
      { ...base, text: "x".repeat(2001) },
      { ...base, to: "Pip" },
    ]) {
      expect(refusalOf(await mail.send(draft)).refused).toBe("invalid");
    }
    expect(refusalOf(await mail.send({ ...base, approve: true })).error).toMatch(/approve/);
    expect(refusalOf(await mail.send({ ...base, from: "wren" }))).toEqual({
      refused: "missing",
      error: "no creature here is called wren",
    });
    expect(refusalOf(await mail.send({ ...base, to: "wren" }))).toEqual({
      refused: "missing",
      error: "no creature here is called wren",
    });
    expect(sessions.injections).toEqual([]);
  });

  it("let the receiving creature's inbound policy decide, in words", async () => {
    const { mail, host, audit } = await fixture();
    await host.update("pip", { inbound: "nobody" });
    expect(refusalOf(await mail.send({ from: "ada", to: "pip", text: "one" }))).toEqual({
      refused: "forbidden",
      error: "pip takes messages from nobody",
    });
    expect((await audit.rows()).at(-1)).toMatchObject({
      capability: "message.receive",
      decision: "deny",
      reason: "pip takes messages from nobody",
    });

    await host.update("pip", { inbound: { named: ["mo"] } });
    expect(refusalOf(await mail.send({ from: "ada", to: "pip", text: "two" })).error).toBe(
      "pip takes messages only from mo, not from ada on house",
    );
    expect(await mail.send({ from: "mo", to: "pip", text: "three" })).toHaveProperty("delivered");

    await host.update("pip", { inbound: { named: ["ada@house"] } });
    expect(await mail.send({ from: "ada", to: "pip", text: "four" })).toHaveProperty("delivered");
  });

  it("drop identical repeats and hold each sender to its hourly limit", async () => {
    const { mail, later } = await fixture({ limits: { perSenderHourly: 2 } });
    const send = (text: string) => mail.send({ from: "ada", to: "pip", text });
    expect(await send("one")).toHaveProperty("delivered");
    expect(refusalOf(await send("one"))).toEqual({
      refused: "repeat",
      error: "ada on house sent pip the same words within the hour; the repeat is dropped",
    });
    expect(await send("two")).toHaveProperty("delivered");
    expect(refusalOf(await send("three"))).toEqual({
      refused: "limited",
      error:
        "ada on house has sent 2 messages this hour, the most a creature may send; try again later",
    });
    later(60 * 60_000 + 1);
    expect(await send("three")).toHaveProperty("delivered");
    expect(await send("one")).toHaveProperty("delivered");
  });

  it("cap how many messages one conversation takes in an hour", async () => {
    const { mail } = await fixture({ limits: { perInboxHourly: 1 } });
    expect(await mail.send({ from: "ada", to: "pip", text: "hi" })).toHaveProperty("delivered");
    expect(refusalOf(await mail.send({ from: "mo", to: "pip", text: "hi" }))).toEqual({
      refused: "limited",
      error:
        "pip has received 1 messages this hour, the most its conversation takes; try again later",
    });
  });

  it("hold a message to the hop limit", async () => {
    const { mail } = await fixture({ pairs: [pairWithHost()] });
    expect(await mail.send({ from: "ada", to: "pip", text: "a", hop: 1 })).toHaveProperty(
      "delivered",
    );
    expect(refusalOf(await mail.send({ from: "ada", to: "pip", text: "b", hop: 2 }))).toEqual({
      refused: "invalid",
      error: "the message has crossed 2 machines and may cross at most one machine",
    });
    const relayed = await mail.send({
      from: "ada",
      to: "pip",
      node: hostNode.stableId,
      text: "c",
      hop: 1,
    });
    expect(refusalOf(relayed).refused).toBe("invalid");
  });
});

describe("creature messages across machines", () => {
  it("refuse in words a message to a machine this one has not paired, and audit it", async () => {
    const { mail, audit, sent } = await fixture();
    const outcome = await mail.send({
      from: "ada",
      to: "pip",
      node: hostNode.stableId,
      text: "hi",
    });
    expect(refusalOf(outcome)).toEqual({
      refused: "forbidden",
      error: `this machine is not paired with ${hostNode.stableId}: pair the two machines before ada can message pip there`,
    });
    expect(sent).toEqual([]);
    expect(await audit.rows()).toEqual([
      expect.objectContaining({
        capability: "message.send",
        targetStableID: hostNode.stableId,
        decision: "deny",
      }),
    ]);
  });

  it("send only the plain message over the pair, with one hop counted", async () => {
    const delivered = {
      id: "x",
      from: "ada",
      to: "pip",
      node: houseNode.stableId,
      machine: "host",
      hop: 1,
    };
    const { mail, sent, audit } = await fixture({
      pairs: [pairWithHost()],
      answer: () => Response.json({ delivered }, { status: 201 }),
    });
    const outcome = await mail.send({
      from: "ada",
      to: "pip",
      node: hostNode.stableId,
      text: "hi",
    });
    expect(outcome).toEqual({ delivered });
    expect(sent).toEqual([
      {
        pair: expect.objectContaining({ id: "pair-host" }),
        method: "POST",
        path: "/mesh/messages",
        body: { id: expect.any(String), from: "ada", to: "pip", text: "hi", hop: 1 },
      },
    ]);
    expect((await audit.rows()).at(-1)).toMatchObject({
      capability: "message.send",
      decision: "allow",
    });
  });

  it("carry the far side's refusal back in words", async () => {
    const answers: Response[] = [
      Response.json({ error: "pip takes messages from nobody" }, { status: 403 }),
      Response.json({ error: "unauthenticated" }, { status: 401 }),
      Response.json({ error: "mesh.not-found" }, { status: 404 }),
    ];
    const { mail } = await fixture({
      pairs: [pairWithHost()],
      answer: () => answers.shift() ?? Response.json({}, { status: 500 }),
    });
    const send = (text: string) =>
      mail.send({ from: "ada", to: "pip", node: hostNode.stableId, text });
    expect(refusalOf(await send("one"))).toEqual({
      refused: "forbidden",
      error: `${hostNode.stableId} refused: pip takes messages from nobody`,
    });
    expect(refusalOf(await send("two"))).toEqual({
      refused: "forbidden",
      error: `${hostNode.stableId} does not hold this machine's pairing: pair the two machines again before ada can message there`,
    });
    expect(refusalOf(await send("three"))).toEqual({
      refused: "unreachable",
      error: `${hostNode.stableId} does not take creature messages yet: its node runs an older keywork`,
    });
  });

  it("say so when the paired machine cannot be reached", async () => {
    const unreachable = await fixture({ pairs: [pairWithHost()] });
    expect(
      refusalOf(
        await unreachable.mail.send({ from: "ada", to: "pip", node: hostNode.stableId, text: "a" }),
      ),
    ).toEqual({
      refused: "unreachable",
      error: `${hostNode.stableId} did not answer: connect ECONNREFUSED`,
    });
    const addressless = await fixture({ pairs: [pairWithHost(null)] });
    expect(
      refusalOf(
        await addressless.mail.send({ from: "ada", to: "pip", node: hostNode.stableId, text: "a" }),
      ).refused,
    ).toBe("unreachable");
  });

  it("deliver a message received over a pair with the sender stamped from WhoIs, never the body", async () => {
    const { mail, sessions, audit } = await fixture();
    const caller = callerOf(hostNode);
    const body = JSON.stringify({ id: "msg-00000001", from: "ada", to: "pip", text: "hi", hop: 1 });
    const outcome = await mail.receive({ pair: pairWithHost(), caller, body });
    expect(outcome).toEqual({
      delivered: {
        id: "msg-00000001",
        from: "ada",
        to: "pip",
        node: hostNode.stableId,
        machine: "house",
        hop: 1,
      },
    });
    expect(sessions.injections.at(-1)).toMatchObject({
      text: "Message from ada on host: hi",
      origin: { creature: "ada", node: hostNode.stableId, machine: "host" },
    });
    expect((await audit.rows()).at(-1)).toMatchObject({
      actorStableID: hostNode.stableId,
      targetStableID: houseNode.stableId,
      capability: "message.receive",
      decision: "allow",
    });
    const replayed = await mail.receive({ pair: pairWithHost(), caller, body });
    expect(refusalOf(replayed).refused).toBe("repeat");
    const forged = JSON.stringify({
      id: "msg-00000002",
      from: "ada",
      to: "pip",
      text: "hi",
      hop: 1,
      node: houseNode.stableId,
    });
    expect(
      refusalOf(await mail.receive({ pair: pairWithHost(), caller, body: forged })).refused,
    ).toBe("invalid");
  });
});
