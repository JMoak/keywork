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
