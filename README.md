# Talon

A terminal UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) agents, shipped as a dsh **plugin bundle**. Talon renders a full interactive session — streaming transcript, tool approvals, user questions, slash commands, and cross-workspace session resume — inside your terminal, on top of an unmodified harness checkout.

> 中文文档见 [README.zh.md](README.zh.md).

## Features

- **Streaming transcript** — role headers with plain, copy-friendly text (drag-select copies exact message text), streamed markdown that settles into cached committed cells, context-injection cards, and zero `ESC[3J` scrollback wipes during normal interaction.
- **Approval panel** — dsh's first terminal approval UI. When a tool asks for escalation (e.g. a bash command denied by the sandbox retrying with `sandbox_permissions`), an inline panel shows the tool, the command preview, the cwd, and the justification. `1` allow once, `2` reject, `Esc` cancel. Every decision leaves a one-line audit entry in the transcript.
- **User questions** — the model can ask you questions through `ask_user_question` (composed into the bundle): single- and multi-select options, custom free-form answers, multi-question requests answered serially, and plan-review intents rendered with the approving option highlighted.
- **Slash commands** — `/help`, `/status`, `/resume`, `/clear`, `/exit`, `/quit`, with fuzzy autocomplete on `/`. Command results render from durable session events, so a resumed session replays them byte-identically.
- **Session resume** — `/resume` opens a selector (type to filter, `Tab` toggles between this workspace and all workspaces, ISO timestamps, live/persisted markers). Resuming rebinds the UI in-process: the working directory moves first (`chdir`-first), the transcript replays from the live session log, and the resumed agent can immediately take new turns.
- **Clean exit** — `/exit` (or `Ctrl+C` / `Ctrl+D` at an empty idle composer) restores the terminal and prints a goodbye line naming the session: `To resume: dsh --profile talon, then /resume — session <id>`.

## Requirements

- Node >= 22.19, pnpm
- A checkout of `deepseek-harness` as a **sibling directory** of this repo
- An interactive terminal (talon fails loud off-TTY; use `dsh --profile headless` for automation)

## Install

Build the harness first (talon's typecheck and the profile both resolve dsh packages from the sibling checkout):

```bash
cd deepseek-harness && pnpm install && pnpm run build:lib:host
```

Then build talon and install it into a dsh profile:

```bash
cd ../talon-ui && pnpm install && pnpm build
cd ../deepseek-harness
pnpm dsh plugin --profile talon add link:../talon-ui
```

`dsh plugin` seeds `$DSH_HOME/profiles/talon` (default `~/.dsh/profiles/talon`) with `@deepseek-ai/dsh-base` and appends `talon-ui` as a bundle layer. The `link:` protocol installs a real symlink to this repo, so after any source change `pnpm build` is all it takes — no profile reinstall. See [docs/INSTALL.md](docs/INSTALL.md) for details, including uninstalling and why `link:` rather than `file:`.

## Usage

```bash
cd deepseek-harness
pnpm dsh --profile talon
```

### Keys

| Key | When | Action |
|---|---|---|
| `Enter` | composing | send |
| `Shift+Enter` | composing | newline |
| `Esc` | turn running | interrupt |
| `Ctrl+C` | turn running | interrupt |
| `Ctrl+C` | idle, text in composer | clear composer |
| `Ctrl+C` / `Ctrl+D` | idle, empty composer | exit |
| `Ctrl+L` | anytime | force full redraw |

### Panels

- **Approval**: `1` allow once · `2` reject · arrows move the highlight · `Enter` picks it · `Esc` cancel.
- **Question**: `↑`/`↓` or `1`–`9` move · `Space` toggles an option (multi-select) · `Tab` (or `c`) switches to a custom free-form answer · `Enter` submit · `Esc` cancel (from custom mode: back to options) · `PgUp`/`PgDn` page long question headers.
- **Resume**: type to filter · `↑`/`↓` move · `Tab` toggles this-workspace / all-workspaces scope · `Enter` resume · `Esc` clears the filter, then closes.

### Try it

- Streaming: `Explain what this repository does.`
- A question: `Use ask_user_question to ask me a multi-select question with options Alpha, Bravo, Charlie.`
- An approval: `Run exactly: touch ~/talon-demo` — the sandbox denies writes outside the workspace, the model escalates, and the approval panel appears.
- Resume: `/exit`, relaunch, `/resume`, pick the session — the transcript replays and the agent continues where it left off, even from a different working directory.

## Development

```bash
pnpm test        # vitest, v8 coverage, per-file 100% thresholds on src/
pnpm typecheck   # tsc strict against the harness checkout's built declarations
pnpm build       # emits lib/ (what the linked profile actually runs)
pnpm test:e2e    # live PTY smoke: boot → stream → approval escalation → goodbye
```

`pnpm test:e2e` drives a real `pnpm dsh --profile talon` session on a PTY against the live model. It needs the built harness, the `link:`-installed talon profile, `DEEPSEEK_API_KEY`, and `python3`; when anything is missing the suite skips itself, and the default `pnpm test` never runs it. The approval phase creates and removes `~/.talon-e2e-<pid>`.

Design documents live under [docs/](docs/): the design spec in [docs/specs/](docs/specs/) and per-milestone implementation plans in [docs/plans/](docs/plans/).

## Architecture

Two cordis plugins plus a bundle patch:

- **`talon-ui/boot`** (`talon-boot`) — host side: creates the root agent with the composition's default model selection. The UI plugin never owns the agent (dedicated-front-door design).
- **`talon-ui`** — the UI: mounts the controller on a real TTY, renders through [pi-tui](https://github.com/earendil-works/pi-tui), and consumes dsh strictly through narrow service facets (approval responder, question provider, command registry, session query, agent registry).
- **`cordis.patch.yml`** — the bundle layer composed on top of `@deepseek-ai/dsh-base`: storage + session-projection cache (cheap session titles for the resume selector), `dsh-tool-ask-user` (the model-facing question tool), and the two talon rows.

Rendering follows an event-driven, replay-identical discipline: everything the transcript shows comes from durable session events, so a live session and its later resume render the same bytes. Untrusted strings (model text, tool output, titles) pass a sanitizer before styling; committed cells cache their rendered lines and only mutating state invalidates them.

## Status

Milestones T0 (skeleton), T1 (core loop), and T2 (rich interaction: approvals, questions, commands, resume) are complete and covered by unit, snapshot, and live PTY tests. Next up: T3 (rich rendering — markdown highlighting, tool cards, diffs) and T4 (polish — model picker, `@file` completion, notifications, image paste, Windows).

## License

MIT
