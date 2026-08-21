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
