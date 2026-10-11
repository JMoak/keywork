import { strict as assert } from "node:assert";
import type { Scenario } from "../scenario.ts";

const helloExtension = [
  "export default function hello(api) {",
  "  api.registerTool({",
  '    name: "hello_tool",',
  '    description: "says hello",',
  '    parameters: { type: "object" },',
  '    execute: async () => "hello",',
  "  });",
  "  api.registerCommand({",
  '    name: "hello",',
  '    description: "says hello back: /hello [name]",',
  `    run: (args) => \`hello, \${args}\`,`,
  "  });",
  "}",
  "",
].join("\n");

export const extensionsTour: Scenario = {
  name: "extensions-tour",
  description:
    "a project extension loads from .keywork/extensions and answers /extensions and its own command",
  files: { ".keywork/extensions/hello.ts": helloExtension },
  goldens: ["extensions-listing", "extension-command"],
  run: async (stage) => {
    await stage.settle();

    await stage.type("/extensions");
    await stage.press("enter");
    const listing = await stage.until("1 extension active");
    assert.ok(listing.includes("hello"), "the listing names the project extension");
    assert.ok(listing.includes("1 tool"), "the listing counts the registered tool");
    assert.ok(listing.includes("1 command"), "the listing counts the registered command");
    await stage.capture("extensions-listing");

    await stage.type("/hello e2e");
    await stage.press("enter");
    const answered = await stage.until("hello, e2e");
    assert.ok(!answered.includes("/hello e2e"), "the prompt line clears once the command runs");
    await stage.capture("extension-command");

    await stage.quit();
  },
};
