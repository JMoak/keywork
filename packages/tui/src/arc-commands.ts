import { type ArcPicker, type ArcPickerChoice, arcPickerOver } from "./arc-picker.ts";
import { type ArcsPort, arcSlugProblem, describeCloseOutcome, suggestArcSlug } from "./arcs.ts";

export interface FocusedArcPort {
  current(): string | undefined;
  titleHint(): string | undefined;
  bind(slug: string | undefined): Promise<void>;
}

export interface ArcCommandSeams {
  arcs: ArcsPort;
  focusedArc: FocusedArcPort | undefined;
  notice(text: string): void;
  showPicker(picker: ArcPicker): void;
}

export function runArcCommand(seams: ArcCommandSeams, argument: string): Promise<void> {
  const [verb = "", operand] = argument.split(/\s+/).filter((word) => word !== "");
  switch (verb) {
    case "":
      return showArcPicker(seams);
    case "new":
      return createArc(seams, operand);
    case "none":
    case "release":
      return bindFocusedArc(seams, undefined);
    case "close":
      return closeArc(seams, operand);
    case "abandon":
      return abandonArc(seams, operand);
    default:
      return switchArc(seams, verb);
  }
}

export function applyArcChoice(seams: ArcCommandSeams, choice: ArcPickerChoice): Promise<void> {
  switch (choice.kind) {
    case "release":
      return bindFocusedArc(seams, undefined);
    case "bind":
      return bindFocusedArc(seams, choice.slug);
    case "create":
      return createArc(seams, choice.slug);
    case "archived":
      seams.notice(`arc ${choice.slug} is archived · pick an active arc or /arc new`);
      return Promise.resolve();
  }
}

async function showArcPicker(seams: ArcCommandSeams): Promise<void> {
  seams.showPicker(arcPickerOver(await seams.arcs.list(), seams.focusedArc?.current()));
}

async function bindFocusedArc(seams: ArcCommandSeams, slug: string | undefined): Promise<void> {
  const focused = seams.focusedArc;
  if (focused === undefined) {
    seams.notice("no session pane here · /arc binds the focused session");
    return;
  }
  await focused.bind(slug);
  seams.notice(slug === undefined ? "arc released" : `arc → ${slug}`);
}

async function createArc(seams: ArcCommandSeams, requested: string | undefined): Promise<void> {
  const taken = (await seams.arcs.list()).map((arc) => arc.slug);
  const slug = requested ?? suggestArcSlug(seams.focusedArc?.titleHint(), taken);
  const problem = arcSlugProblem(slug);
  if (problem !== undefined) {
    seams.notice(problem);
    return;
  }
  if (taken.includes(slug)) {
    seams.notice(`an arc named ${slug} already exists · /arc ${slug} switches to it`);
    return;
  }
  await seams.arcs.create(slug);
  const focused = seams.focusedArc;
  if (focused === undefined) {
    seams.notice(`arc ${slug} created`);
    return;
  }
  await focused.bind(slug);
  seams.notice(`arc → ${slug} · new`);
}

async function switchArc(seams: ArcCommandSeams, slug: string): Promise<void> {
  const found = (await seams.arcs.list()).find((arc) => arc.slug === slug);
  if (found === undefined) {
    seams.notice(`no arc named ${slug} · /arc new ${slug} creates it`);
    return;
  }
  if (found.status === "archived") {
    seams.notice(`arc ${slug} is archived · /arc new starts another`);
    return;
  }
  await bindFocusedArc(seams, slug);
}

async function closeArc(seams: ArcCommandSeams, requested: string | undefined): Promise<void> {
  const slug = requested ?? seams.focusedArc?.current();
  if (slug === undefined) {
    seams.notice("no arc to close · this session is unbound · /arc close <slug> names one");
    return;
  }
  seams.notice(describeCloseOutcome(slug, await seams.arcs.close(slug)));
}

async function abandonArc(seams: ArcCommandSeams, slug: string | undefined): Promise<void> {
  if (slug === undefined) {
    seams.notice("abandon needs a name · /arc abandon <slug>");
    return;
  }
  await seams.arcs.abandon(slug);
  seams.notice(`arc ${slug} abandoned · archived without distilling, nothing deleted`);
}
