# Live smoke: Anthropic provider

The recorded-fixture tests prove the wire mapping; this is the ten-minute check against the
real API with a real key before a release that touches `engine/src/providers/anthropic.ts`.

## What you need

- An API key from the Anthropic console (`platform.claude.com/settings/keys`). A Claude
  subscription is not a credential here and never will be.
- A checkout with `bun run check && bun test` green.

## The walk

1. **Connect through the environment.**
   ```sh
   KEYWORK_ANTHROPIC_API_KEY=sk-ant-... bun run keywork run "say hi in five words" --json
   ```
   Expect a `run.finished` event, a short reply, and a `model_change` naming
   `anthropic/claude-haiku-4-5` in the session file. Expect no `authorization` header anywhere
   in a `--debug` log; the request carries `x-api-key` and `anthropic-version` only.

2. **Connect through the screen.** Unset the variable, start `keywork`, run `/connect`, pick
   `Anthropic`, paste the key, Enter. The verify step performs one `GET /v1/models`; the
   receipt lists the reported models. `~/.keywork/auth.json` gains `anthropic` under
   `api_key`; `keywork.json` stays secret-free.

3. **A tool turn.** In a trusted workspace ask for something that needs a tool (`what files are
   in this directory`). The turn should stream text, run the tool, and continue. Behind the
   scenes the model's thinking blocks are carried back as owned provider state for the tool
   loop, then dropped once the turn ends.

4. **Cache tokens on the cost line.** Send two prompts in a row. The second turn's usage in the
   session file should show `cacheReadInputTokens` above zero (the request carries top-level
   `cache_control: {type: "ephemeral"}` so the API caches the growing prefix), and `/cost`
   should price it at the model's cache-read rate.

5. **Switch models both ways.** `/model openai/gpt-5-mini`, one prompt, `/model
   anthropic/claude-sonnet-5`, one prompt. Both turns succeed; the neutral transcript carries
   across with no 400 about thinking blocks.

6. **A wrong key.** `KEYWORK_ANTHROPIC_API_KEY=sk-ant-wrong bun run keywork run "hi"`. Expect a
   clean `anthropic request failed (401)` failure whose text does not contain the key.

## Stop if you see

- Any request to a host other than `api.anthropic.com` (or your declared proxy).
- Any `authorization: Bearer` header on an Anthropic request.
- The key, or any `sk-ant-` string, in a log, a notice, a session file, or an error.
- A 400 mentioning thinking blocks after a model switch or a compaction. That means the
  thinking replay policy in `messages-wire.ts` needs revisiting; record it in
  [`../backlog/70-anthropic.md`](../backlog/70-anthropic.md).
