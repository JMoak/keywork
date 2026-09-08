---
description: Typecheck a TypeScript project with tsc and read the result well
---
# typecheck

Run the project's TypeScript compiler and read its output the way a maintainer would.

## Find the command

Run the resolver from the project root; it reads `package.json` and the lockfile and prints
the command this project expects:

```
bun "<this skill's directory>/resolve.ts" <project root>
```

The directory is the one named in the `files in` line above. The output has three lines:
`tool:` (tsc or none), `command:` (what to run) and `reason:` (why). A package script that
wraps tsc wins over a bare `tsc --noEmit`, because the script carries the project's flags
(`--build`, `-p`, project references). When the tool is `none`, say so and stop; do not
guess at a command.

## Run it

Run the printed command from the project root with the shell tool. Let it finish; tsc on a
large project can take a minute and prints nothing until it is done.

## Read the output

- A clean run prints nothing and exits 0. Silence is success.
- Every error is one line of the form `path(line,col): error TSnnnn: message`. The first
  error is the first line matching `error TS`; fix from the top, since a bad type early in a
  file cascades into false errors below it.
- Count failures with the number of lines containing `error TS`. tsc prints a summary
  `Found N errors in M files.` when N is more than one; trust the summary over your count.
- With `--build`, the file path may be prefixed by the package that owns it. The path is
  still the thing to open.
- `TS2307` (cannot find module) usually means dependencies are not installed. Suggest the
  install command for the detected package manager before touching code.
- `TS6133` (declared but never read) and `TS7006` (implicit any) are strictness flags from
  `tsconfig.json`. Fix the code; do not loosen the config.

## Report

Say whether the run was clean, and if not, give the first error verbatim with its path and
line, plus the total count from the summary line.
