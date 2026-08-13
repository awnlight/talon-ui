# Installing talon

Requirements: Node >= 22.19, pnpm, a checkout of `deepseek-harness` as a sibling directory, an interactive terminal.

`deepseek-harness` must be built before talon-ui's own typecheck/build (its `tsconfig.json` resolves `@deepseek-ai/dsh-agent`/`@deepseek-ai/dsh-session` to the harness checkout's compiled declarations) and before the profile install below (the profile resolves `@deepseek-ai/dsh-base` and every other dsh package from the same checkout):

    cd deepseek-harness && pnpm install && pnpm run build:lib:host

Then build talon-ui and install it into a profile:

    cd ../talon-ui && pnpm install && pnpm build
    cd ../deepseek-harness
    pnpm dsh plugin --profile talon add file:../talon-ui
    pnpm dsh --profile talon

`dsh plugin` seeds `$DSH_HOME/profiles/talon` with `@deepseek-ai/dsh-base` and appends `talon-ui` as a bundle layer (it declares `dsh.bundle.patch`). No dsh code changes are involved.

Uninstall: remove `$DSH_HOME/profiles/talon` (`$DSH_HOME` defaults to `~/.dsh` when unset, e.g. `rm -rf ~/.dsh/profiles/talon`).
