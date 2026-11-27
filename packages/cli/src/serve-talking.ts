import {
  bindForClass,
  type CreatureRegistry,
  type CreaturesPort,
  type ModelReference,
  type PolicyEnvironment,
  type SessionStore,
  sameTalkingChoice,
  type TalkingChoice,
  type TalkingModel,
  talkingChoiceOf,
} from "@keywork/engine";
import type { EventLog } from "@keywork/server";
import { toError } from "@keywork/shared";
import { type AskingTheServer, conversationModel } from "./serve-conversation-model.ts";

export interface CreatureTalkingOptions {
  log: Pick<EventLog, "subscribe" | "record">;
  creatures: Pick<CreaturesPort, "subscribe">;
  registry: Pick<CreatureRegistry, "read">;
  conversationOf(slug: string): Promise<string | undefined>;
  storeOf(session: string): Promise<SessionStore | undefined>;
  inherit(): ModelReference | undefined;
  environment(): PolicyEnvironment;
  ask: AskingTheServer;
  notice(text: string): void;
}

export interface CreatureTalkingFollower {
  talkingOf(slug: string): Promise<TalkingModel | undefined>;
  close(): void;
}

export function followCreatureTalking(options: CreatureTalkingOptions): CreatureTalkingFollower {
  const told = new Map<string, string>();
  const conversations = new Map<string, string>();
  const pending = new Map<string, Promise<TalkingModel | undefined>>();
  const settle = async (slug: string) => {
    const found = await talkingNow(slug, options, conversations);
    if (found === undefined) {
      told.delete(slug);
      return undefined;
    }
    const before = told.get(slug);
    const said = JSON.stringify(found);
    told.set(slug, said);
    if (before !== undefined && before !== said) {
      options.log.record("", "creature.talking", { slug, talking: found });
    }
    return found;
  };
  const refresh = (slug: string): Promise<TalkingModel | undefined> => {
    const next = (pending.get(slug) ?? Promise.resolve(undefined))
      .catch(() => undefined)
      .then(() => settle(slug));
    pending.set(slug, next);
    void next.finally(() => {
      if (pending.get(slug) === next) pending.delete(slug);
    });
    return next;
  };
  const recheck = (slug: string) => {
    if (!told.has(slug)) return;
    refresh(slug).catch((cause: unknown) =>
      options.notice(`what ${slug} talks on was not read: ${toError(cause).message}`),
    );
  };
  const forget = (slug: string) => {
    told.delete(slug);
    for (const [session, owner] of conversations) {
      if (owner === slug) conversations.delete(session);
    }
  };
  const unfollowCreatures = options.creatures.subscribe(({ slug, change }) => {
    if (change === "removed") forget(slug);
    else recheck(slug);
  });
  const unfollowLog = options.log.subscribe(({ type, sessionId }) => {
    if (type === "models.changed") {
      for (const slug of told.keys()) recheck(slug);
      return;
    }
    const slug = type === "session.state" ? conversations.get(sessionId) : undefined;
    if (slug !== undefined) recheck(slug);
  });
  return {
    talkingOf: refresh,
    close: () => {
      unfollowCreatures();
      unfollowLog();
    },
  };
}

export function withTalking<Port extends Pick<CreaturesPort, "read">>(
  creatures: Port,
  talking: CreatureTalkingFollower | undefined,
): Port {
  if (talking === undefined) return creatures;
  return {
    ...creatures,
    read: async (slug: string) => {
      const detail = await creatures.read(slug);
      if (detail === undefined) return undefined;
      const talks = await talking.talkingOf(slug);
      return talks === undefined ? detail : { ...detail, talking: talks };
    },
  };
}

async function talkingNow(
  slug: string,
  options: CreatureTalkingOptions,
  conversations: Map<string, string>,
): Promise<TalkingModel | undefined> {
  const creature = await options.registry.read(slug);
  if (creature === undefined) return undefined;
  const conversation = await options.conversationOf(slug);
  if (conversation !== undefined) conversations.set(conversation, slug);
  const store = conversation === undefined ? undefined : await options.storeOf(conversation);
  const reference = talksOn(store, creature.file.models.strong, options.inherit);
  if (reference !== undefined) await askedWhetherItCallsTools(reference, options);
  return conversationModel(reference, options.environment());
}

function talksOn(
  store: SessionStore | undefined,
  choice: TalkingChoice,
  inherit: () => ModelReference | undefined,
): ModelReference | undefined {
  const chosen = choice === "inherit" ? inherit() : choice;
  const selection = store?.modelSelection();
  if (store === undefined || selection === undefined) return chosen;
  const talking = { provider: selection.provider, model: selection.modelId };
  const followed = talkingChoiceOf(store.entries()) ?? talking;
  return sameTalkingChoice(choice, followed) ? talking : chosen;
}

async function askedWhetherItCallsTools(
  reference: ModelReference,
  options: Pick<CreatureTalkingOptions, "environment" | "ask">,
): Promise<void> {
  const bound = bindForClass(reference, "strong", options.environment().registrations);
  if (bound.ok) await options.ask(bound.binding).catch(() => undefined);
}
