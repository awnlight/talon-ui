# Installing talon

Requirements: Node >= 22.19, pnpm, a checkout of `deepseek-harness` as a sibling directory, an interactive terminal.

`deepseek-harness` must be built before talon-ui's own typecheck/build (its `tsconfig.json` resolves `@deepseek-ai/dsh-agent`/`@deepseek-ai/dsh-session` to the harness checkout's compiled declarations) and before the profile install below (the profile resolves `@deepseek-ai/dsh-base` and every other dsh package from the same checkout):

    cd deepseek-harness && pnpm install && pnpm run build:lib:host

Then build talon-ui and install it into a profile:

    cd ../talon-ui && pnpm install && pnpm build
    cd ../deepseek-harness
    pnpm dsh plugin --profile talon add link:../talon-ui
    pnpm dsh --profile talon

`dsh plugin` seeds `$DSH_HOME/profiles/talon` with `@deepseek-ai/dsh-base` and appends `talon-ui` as a bundle layer (it declares `dsh.bundle.patch`). No dsh code changes are involved.

Uninstall: remove `$DSH_HOME/profiles/talon` (`$DSH_HOME` defaults to `~/.dsh` when unset, e.g. `rm -rf ~/.dsh/profiles/talon`).

> 为什么是 `link:` 而不是 `file:`:pnpm 的 `file:` 协议会把包**拷贝**进 profile(安装时快照,之后改代码不生效);`link:` 是真符号链接,`pnpm build` 后立即生效。已装成 file: 的话:`pnpm dsh plugin --profile talon remove talon-ui` 再用 link: 重装。

End-to-end smoke: `pnpm test:e2e` drives a live `pnpm dsh --profile talon` session on a real PTY (boot, a model roundtrip, a sandbox-escalation approval, `/exit`). It needs the built harness checkout and the `link:`-installed talon profile from the steps above (rebuild with `pnpm build` after any src change so the linked profile sees it), plus `DEEPSEEK_API_KEY` in the environment and `python3` on PATH — when anything is missing the suite skips itself, and the default `pnpm test` never runs it. The approval phase creates `~/.talon-e2e-<pid>` outside the workspace to force a sandbox denial and removes it when done.

## The recorded-replay acceptance fixture

`tests/replay/coding-session/session.jsonl` is a real `dsh --profile talon` session — a complete prefix of one, ending on a `turn/end` — replayed through the production `translateSessionEvent` → `Transcript.apply` path in `tests/replay/replay.spec.ts`. Nothing below the event boundary is mocked, and the terminal golden is checked LAST: the exact ordered tool-call sequence, turn-lifecycle completeness, zero scrollback wipes and zero theme violations are all asserted first, so a pretty frame can never cover a broken path.

The spec's three snapshot modes map onto this as:

- **replay** (the default) — `pnpm test`. Nothing to set up; the fixture is committed.
- **refresh** — `pnpm vitest run tests/replay -u`. Regenerates `terminal.expected.txt` from the committed fixture. Use it when a deliberate rendering change should move the golden; the hard-reject assertions still have to pass first.
- **record** — harvest a NEW session by hand, when the fixture should describe a different flow:

      # 1. run a real session that exercises the cards you want covered
      cd deepseek-harness && pnpm dsh --profile talon
      # 2. find its log (newest first) and decompress it
      ls -t ~/.dsh/sessions/*/*/session.jsonl.zstd | head -1
      zstd -dc <that path> > tests/replay/coding-session/session.jsonl
      # 3. optionally trim to a complete prefix — the file must start with the
      #    `{"type":"session"}` header row and end on a `turn/end` row
      # 4. update EXPECTED_CALLS in tests/replay/replay.spec.ts to the new
      #    sequence, then refresh the golden

  Read the harvested log before committing it: it contains the real prompts, file contents and command output of that session.
