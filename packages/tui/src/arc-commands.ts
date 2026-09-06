import { type ArcPicker, type ArcPickerChoice, arcPickerOver } from "./arc-picker.ts";
import { type ArcsPort, arcSlugProblem, describeCloseOutcome, suggestArcSlug } from "./arcs.ts";
import { verbAndOperand } from "./commands.ts";

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
  openArcPane(slug: string): void;
}

export type ArcInvocation =
  | { verb: "pick"; slug?: string | undefined }
  | { verb: "new"; slug?: string | undefined }
  | { verb: "open"; slug?: string | undefined }
  | { verb: "release" }
  | { verb: "close"; slug?: string | undefined; direction?: string | undefined }
  | { verb: "abandon"; slug?: string | undefined };

export function runArcCommand(seams: ArcCommandSeams, invocation: ArcInvocation): Promise<void> {
  switch (invocation.verb) {
    case "pick":
      return invocation.slug === undefined
        ? showArcPicker(seams)
        : switchArc(seams, invocation.slug);
    case "new":
      return createArc(seams, invocation.slug);
    case "open":
      return openArcPane(seams, invocation.slug);
    case "release":
      return bindFocusedArc(seams, undefined);
    case "close":
      return closeArc(seams, invocation.slug, invocation.direction);
    case "abandon":
      return abandonArc(seams, invocation.slug);
  }
}

export function legacyArcInvocation(argument: string): ArcInvocation {
  const [verb, operand] = verbAndOperand(argument);
  switch (verb) {
    case "":
      return { verb: "pick" };
    case "new":
      return { verb: "new", slug: operand };
    case "open":
      return { verb: "open", slug: operand };
    case "none":
    case "release":
      return { verb: "release" };
    case "close":
      return { verb: "close", slug: operand };
    case "abandon":
      return { verb: "abandon", slug: operand };
    default:
      return { verb: "pick", slug: verb };
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
      seams.notice(`arc ${choice.slug} is archived · pick an active arc or /arc-new`);
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

async function openArcPane(seams: ArcCommandSeams, requested: string | undefined): Promise<void> {
  const slug = requested ?? seams.focusedArc?.current();
  if (slug === undefined) {
    seams.notice("no arc here · /arc-open <slug> names one");
    return;
  }
  const found = (await seams.arcs.list()).find((arc) => arc.slug === slug);
  if (found === undefined) {
    seams.notice(`no arc named ${slug} · /arc-new ${slug} creates it`);
    return;
  }
  seams.openArcPane(slug);
}

async function switchArc(seams: ArcCommandSeams, slug: string): Promise<void> {
  const found = (await seams.arcs.list()).find((arc) => arc.slug === slug);
  if (found === undefined) {
    seams.notice(`no arc named ${slug} · /arc-new ${slug} creates it`);
    return;
  }
  if (found.status === "archived") {
    seams.notice(`arc ${slug} is archived · /arc-new starts another`);
    return;
  }
  await bindFocusedArc(seams, slug);
}

async function closeArc(
  seams: ArcCommandSeams,
  requested: string | undefined,
  direction: string | undefined,
): Promise<void> {
  const slug = requested ?? seams.focusedArc?.current();
  if (slug === undefined) {
    seams.notice("no arc to close · this session is unbound · /arc <slug> binds one first");
    return;
  }
  seams.notice(describeCloseOutcome(slug, await seams.arcs.close(slug, direction)));
}

async function abandonArc(seams: ArcCommandSeams, slug: string | undefined): Promise<void> {
  if (slug === undefined) {
    seams.notice("abandon needs a name · /arc-abandon <slug>");
    return;
  }
  await seams.arcs.abandon(slug);
  seams.notice(`arc ${slug} abandoned · archived without distilling, nothing deleted`);
}
