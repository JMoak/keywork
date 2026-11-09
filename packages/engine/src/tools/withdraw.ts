import { z } from "zod";
import { settingIdInput } from "../show/input.ts";
import type { Tool } from "../tools.ts";
import { defineTool } from "./define.ts";
import type { ShowTarget } from "./show.ts";

export const withdrawToolName = "withdraw";

export function withdrawTool(target: ShowTarget): Tool {
  return defineTool({
    name: withdrawToolName,
    description:
      "Take back something you set out beside this conversation. This is IDE control over the console's own space, never the computer, and it asks for no permission. Name the id show answered with, or one from shown. It refuses what the keeper pinned, what the keeper opened and anything that is not yours, because the keeper disposes. What grew from a setting stays out when you take it back.",
    schema: z
      .object({
        id: settingIdInput.describe("The id of the setting to take back."),
      })
      .strict(),
    run: async ({ id }) => {
      const settings = target.settings();
      if (settings === undefined) return noKeeperSurface;
      const taken = settings.takeBack(target, id);
      if ("refused" in taken) return `Not withdrawn: ${taken.error}.`;
      return `Withdrawn: ${taken.id} has left the yard, and what grew from it stays out.`;
    },
  });
}

const noKeeperSurface = "Not withdrawn: no keeper surface takes settings here.";
