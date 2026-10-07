# Windows notes

Linux is the primary platform and Windows is fully supported (T3 in
[`textures.md`](textures.md) wants that parity proven by tests). This file collects the
terminal-citizenship facts that differ per host, so a Windows regression has one place to
be checked against.

## Terminal escapes (2026-09-06, V2.12 / V2.15)

`packages/tui/src/osc.ts` produces every escape as a string and `terminalSupport()` decides
which ones are written. The decision is pure and tested; nothing probes the terminal.

| Escape | Linux terminals | Windows Terminal | conhost / ConEmu | Off when |
|---|---|---|---|---|
| Title, OSC 0 (`ESC ] 0 ; text BEL`) | written | written | written (conhost renders it in the window frame) | stdout not a TTY, `TERM=dumb` |
| Title stack, XTWINOPS `ESC [ 22;0 t` / `ESC [ 23;0 t` | xterm-class terminals restore the old title on exit | honored | ignored (last title stays) | same as title |
| Progress, OSC 9;4 (`ESC ] 9 ; 4 ; state ; pct BEL`) | not written | written under `WT_SESSION`: taskbar shows indeterminate while working, paused while an ask waits, error after a failed turn | written under `ConEmuANSI=ON` or `ConEmuPID` | any other terminal, so no stray bytes reach an unknown emulator |
| Clipboard, OSC 52 (`ESC ] 52 ; c ; base64 BEL`) | written; works over SSH and through tmux with `set-clipboard on` | written and honored | written; conhost ignores it silently | stdout not a TTY, `TERM=dumb` |

Facts used: `WT_SESSION`, `ConEmuANSI`, `ConEmuPID`, `TERM`, and whether stdout is a TTY.
`TERM_PROGRAM` is read by nothing today; iTerm2 and kitty title handling rides the plain
OSC 0 path.

## Input reality

- Windows Terminal binds `ctrl+shift+p` to its own palette; keywork's palette rides
  `leader i` there (see the README keys section and 112's note).
- Bracketed paste arrives as one `paste` event through OpenTUI on both hosts; CRLF is
  normalized to `\n` before the input buffer sees it (`injection-citizenship.test.ts` pins
  this).
- The e2e harness's `typeText` splits by UTF-16 code unit, so astral graphemes (emoji,
  ZWJ families, flags) are proven in the vitest probe and BMP graphemes (accents, CJK,
  Hangul) in the `injection-citizenship` e2e scenario.

## Terminal pane (C15, SW11 2026-10-07)

The terminal pane (`/terminal`, alias `/term`, `leader shift+t`) has two modes. **Mirror**
renders the agent's `bash` calls as sanitized text lines on every host. **Shell** has two
backends behind one seam (`packages/tui/src/terminal-backend.ts`), chosen once when the
pane opens from a capability probe, never from a config option:

| Backend | Where | What it is |
|---|---|---|
| `pty` | Linux and macOS under a Bun with `Bun.Terminal` | `Bun.spawn({ terminal })` feeds OpenTUI 0.5.14's embedded terminal renderable (libghostty): the shell's own prompt, readline, job control, colors, the alternate screen, `vim`, `htop`; keys route to the child while the pane is focused; the pty follows the pane's content geometry |
| `pipes` | Windows, Node, or any Bun whose `Bun.Terminal` refuses to open | the 2026-09-07 line model below, with the reason on the pane's first line (`· pipes: …`) and `· pipes` in the title |

The whole `Bun.*` surface lives in `packages/engine/src/tools/pty.ts`
(`probePtySupport`), which reads `globalThis.Bun` structurally; everything else stays on
`node:*`.

### Windows verdict (2026-10-07)

There is no PTY path on Windows, and keywork does not fake one:

- `bun-types@1.3.14` documents `Bun.spawn({ terminal })` as "Only available on POSIX
  systems (Linux, macOS)". The 117 overlay's line that 1.3.14 brought ConPTY was wrong and
  is corrected there.
- Probed on this machine with Bun 1.3.9 on Windows 11: `new Bun.Terminal({ cols, rows })`
  throws `Error: PTY not supported on this platform`. (`typeof Bun.Terminal` is `"function"`,
  so presence is not capability; the probe opens and closes one terminal to know.)
- Consequently ConPTY, `\r` translation and mouse-on-Windows-10 never arise: the exact
  failure is "no pseudo-console in the runtime", and `probePtySupport` answers it on
  `win32` before touching Bun. Getting there needs Bun to ship ConPTY (or a native
  `node-pty` style binding), neither of which keywork takes on.

So on Windows the shell pane is the pipe shell, exactly as below, and says so.

### Pipe shell (both hosts when the pty is unavailable)

OpenTUI renders the child's bytes as sanitized text lines the way the transcript tail does:
ANSI sequences stripped, `\r` rewriting the current line, CRLF treated as one newline, other
control bytes dropped, 2000 lines of scrollback per pane.

| | Linux (fallback only) | Windows |
|---|---|---|
| Shell | `openInteractiveShell` spawns the detected shell over pipes (`bash` from `PATH`, else `sh`) | `bash` when Git Bash is on `PATH`, else `powershell.exe -NoProfile -NonInteractive -Command -`; smoke-tested 2026-09-07 for `cd` persistence and stderr capture on both |
| Prompt | keywork draws `❯ ` and the typed line; the child's own prompt is not requested (non-interactive stdin) | same |
| Ctrl+C, job control, tab completion, history | not available: stdin is a pipe, so no signals reach the child and readline is not running | same |
| Full-screen programs (`vim`, `htop`, `less`) | not in this backend: no window size, no cursor addressing, no alternate screen | same, plus programs that query the console see a redirected handle |
| Exit | `· shell exited (code)` marker; `enter` starts a fresh shell in the workspace root | same |

Shell mode opens only in a trusted workspace (`/init`); typed lines are the user's own and
never pass through the agent's permission gate. The mirror mode carries the agent's
workflow on its own; the shell mode is a convenience scoped to the project.
