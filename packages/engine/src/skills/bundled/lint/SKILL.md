---
description: Lint a TypeScript project with biome or eslint and read the result well
---
# lint

Run the project's linter and read its output the way a maintainer would.

## Find the command

Run the resolver from the project root; it reads `package.json`, the lockfile and the config
files at the root, and prints the command this project expects:

```
bun "<this skill's directory>/resolve.ts" <project root>
```

The directory is the one named in the `files in` line above. The output has three lines:
`tool:` (biome, eslint or none), `command:` (what to run) and `reason:` (why). A package
script named `lint` wins over a bare invocation, because it carries the project's paths and
flags. When the tool is `none`, say so and stop; do not install a linter uninvited.

## Run it

Run the printed command from the project root with the shell tool. Both linters exit 1 when
they find anything; a non-zero exit with output is the normal failing case, and a non-zero
exit with no findings means the tool itself failed (a bad config, a missing plugin).

## Read biome output

- A clean run ends with `Checked N files in Xms. No fixes applied.` and exits 0.
- Each finding is a block: `path:line:col lint/rule-name` on the first line, then a message
  and a code frame with `×` marking the offending span. The first finding is the first line
  matching `:\d+:\d+ `.
- The summary line `Found N errors.` and `Found N warnings.` gives the count; only errors
  fail the run.
- `biome check --write .` applies safe fixes. Offer it when most findings are formatting.

## Read eslint output

- A clean run prints nothing and exits 0.
- Findings group by file: a line with the file path, then one indented line per finding of
  the form `line:col  error|warning  message  rule-name`. The first error is the first
  indented line containing `  error  `.
- The summary `✖ N problems (E errors, W warnings)` gives the count; a following line says
  how many are fixable with `--fix`.
- `Parsing error` at the top of a file means eslint could not read it; fix that before
  looking at rule findings in the same file.

## Report

Say whether the run was clean, and if not, give the first finding verbatim with its path,
line and rule name, plus the totals from the summary line.
