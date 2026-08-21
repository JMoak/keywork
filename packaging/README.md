# packaging

Desktop entries that launch keywork in a well-configured terminal. None of these are
required: `keywork` on your PATH is the product. They exist so the harness can live in an
app launcher or a terminal's profile menu (G3, `docs/backlog/80-p2-reach.md`).

| file | install location | what it does |
|---|---|---|
| `windows-terminal/keywork.json` | `%LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\keywork\keywork.json` | adds a **keywork** profile to Windows Terminal's dropdown |
| `linux/keywork.desktop` | `~/.local/share/applications/keywork.desktop` | app-launcher entry; `Terminal=true` lets the desktop pick your default terminal |
| `macos/keywork.app` | `/Applications` or `~/Applications` | a Finder/Spotlight app that opens `keywork` in Terminal.app |

Windows Terminal needs a restart to read a new fragment. On Linux run
`update-desktop-database ~/.local/share/applications` if your desktop doesn't pick the entry
up. On macOS the app is unsigned: the first launch needs right-click → Open, and the
launcher inside (`Contents/MacOS/keywork`) must stay executable (`chmod +x`).

The installers (`scripts/install.sh`, `scripts/install.ps1`) install only the binary; copy
whichever entry you want by hand.
