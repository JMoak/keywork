---
description: Run a TypeScript project's tests with vitest or bun test and read the result well
---
# test

Run the project's test suite and read its output the way a maintainer would.

## Find the command

Run the resolver from the project root; it reads `package.json`, the lockfile and the config
files at the root, and prints the command this project expects:

```
bun "<this skill's directory>/resolve.ts" <project root>
```

The directory is the one named in the `files in` line above. The output has three lines:
`tool:` (vitest, bun test or none), `command:` (what to run) and `reason:` (why). A package
script named `test` wins over a bare invocation, because it carries the project's flags and
reporter. When the tool is `none`, say so and stop.

Mind the difference between the two runners: `bun test` is Bun's own runner and `vitest run`
is vitest. A project that installs vitest wants vitest even though `bun test` would also
execute the files, with different semantics for mocks and globals.

## Run it

Run the printed command from the project root with the shell tool. Both runners exit 1 when
any test fails. To narrow a run to one file, append the file path to the command.

## Read vitest output

- A clean run ends with `Test Files  N passed (N)` and `Tests  M passed (M)` and exits 0.
- Each failing test prints a block headed `FAIL  path > describe > test name` followed by the
  assertion message and a diff (`- Expected`, `+ Received`). The first failure is the first
  `FAIL` line.
- The summary counts failures as `Tests  F failed | P passed (T)`; `Test Files` counts
  files, `Tests` counts cases. Use `Tests` when reporting.
- A file that fails to import shows under `Failed Suites`; fix those first, since every test
  inside them is unreported.

## Read bun test output

- A clean run ends with `N pass`, `0 fail` and `Ran N tests across M files.` and exits 0.
- Each failing test prints `(fail) describe > test name` after its assertion error and
  diff; passing tests print `(pass)`. The first failure is the first `(fail)` line.
- The summary lines `N pass` and `F fail` give the counts. `error:` lines above a `(fail)`
  belong to it.

## Report

Say whether the run was clean, and if not, give the first failing test name and assertion
verbatim, plus the pass and fail totals from the summary.
