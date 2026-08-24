import type { Tool } from "../../../packages/engine/src/index.ts";

export const notesBefore = "alpha\nbeta\ngamma\n";
export const notesAfter = "alpha\nBETA\ngamma\n";

export const listTool: Tool = {
  name: "list",
  description: "lists workspace files",
  parameters: { type: "object" },
  execute: async () => "total 4\ndrwxr-xr-x 2 dev dev 4096 .",
};
