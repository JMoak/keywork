import { type PresetName, presetOrder } from "@keywork/shared";
import {
  bodyOf,
  fieldsOf,
  type JsonSchema,
  json,
  type RouteFamily,
  type RouteSpec,
} from "./family.ts";

const presetBody: JsonSchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", enum: [...presetOrder] },
    confirmed: { type: "boolean", const: true },
  },
  additionalProperties: false,
};

export const presetRoutes = [
  {
    method: "POST",
    path: "/preset",
    operationId: "setPreset",
    summary:
      "Switch the permission preset for every session this server runs: `careful` asks before each core tool, `standard` follows the configured rules, `open` allows the core tools. Moving to a looser preset is refused unless the body carries `confirmed: true`, the same confirmation a terminal user types. The switch is saved to the user config and announced as a process-level `gate.preset` event.",
    authenticated: true,
    requestBody: presetBody,
    responses: {
      "200": "`{ from, to }`: the preset left and the one now active.",
      "400": 'The body is not `{ name: "careful" | "standard" | "open", confirmed?: true }`.',
      "409":
        "The switch loosens permissions and `confirmed: true` was not sent, or this process has no preset switch.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const presetFamily = {
  routes: presetRoutes,
  handlers: ({ host }) => ({
    setPreset: async (request) => {
      const choice = presetChoiceOf(await bodyOf(request));
      if (choice === undefined) {
        return json(400, {
          error: `the body must be { name: ${presetOrder.map((name) => `"${name}"`).join(" | ")}, confirmed?: true }`,
        });
      }
      const outcome = await host.setPreset(choice.name, choice.confirmed);
      if (outcome === "unavailable") {
        return json(409, { error: "this process has no preset switch" });
      }
      if (outcome === "needs-confirmation") {
        return json(409, { error: "loosening needs confirmed: true" });
      }
      return json(200, outcome);
    },
  }),
} satisfies RouteFamily<typeof presetRoutes>;

function presetChoiceOf(body: unknown): { name: PresetName; confirmed: boolean } | undefined {
  const fields = fieldsOf<{ name: unknown; confirmed: unknown }>(body);
  const name = fields?.name;
  if (typeof name !== "string" || !isPresetName(name)) return undefined;
  if (fields?.confirmed !== undefined && fields.confirmed !== true) return undefined;
  return { name, confirmed: fields?.confirmed === true };
}

function isPresetName(name: string): name is PresetName {
  return (presetOrder as readonly string[]).includes(name);
}
