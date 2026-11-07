import type { SubstrateKind } from "../workshop/substrate.ts";
import { isRefused, type Refused, type Workshops } from "../workshop/workshops.ts";
import type { CreatureSummary, CreaturesPort } from "./host.ts";
import { type CreatureDraft, slugOf } from "./registry.ts";

export type CreatureWorkshops = Pick<Workshops, "create" | "start" | "remove">;

export async function raiseCreature(
  creatures: Pick<CreaturesPort, "list" | "create">,
  workshops: CreatureWorkshops,
  draft: CreatureDraft,
  substrate: SubstrateKind,
): Promise<CreatureSummary | Refused> {
  const slug = slugOf(draft.name);
  if ((await creatures.list()).some((creature) => creature.slug === slug)) {
    return { refused: "conflict", error: `a creature named ${slug} already exists` };
  }
  const workshop = await workshops.create({ creature: slug, substrate });
  if (isRefused(workshop)) return workshop;
  const creature = await writtenOrUnraised(creatures, workshops, draft, workshop.id);
  await workshops.start(workshop.id);
  return creature;
}

async function writtenOrUnraised(
  creatures: Pick<CreaturesPort, "create">,
  workshops: CreatureWorkshops,
  draft: CreatureDraft,
  workshop: string,
): Promise<CreatureSummary> {
  try {
    return await creatures.create({ ...draft, workshop });
  } catch (cause) {
    await workshops.remove(workshop, false);
    throw cause;
  }
}
