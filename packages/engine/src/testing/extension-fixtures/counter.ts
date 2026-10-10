import type { ExtensionApi } from "../../extensions/hooks.ts";

export default function counter(api: ExtensionApi): void {
  let count = 0;
  let sideEffects = 0;
  api.on("custom_entry", ({ type, data, replay }) => {
    if (type !== "count") return;
    count = (data as { count: number }).count;
    if (!replay) sideEffects += 1;
  });
  api.on("turn_end", async () => {
    await api.appendEntry("count", { count: count + 1 });
  });
  api.registerCommand({ name: "count", run: () => `${count} turns, ${sideEffects} effects` });
}
