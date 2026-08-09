import type { Tool } from "../tools.ts";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

export function coreTools(cwd: string): Tool[] {
  return [readTool(cwd), writeTool(cwd), editTool(cwd), bashTool(cwd)];
}
