# github-core-clone-01-entry

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/zalana28/github-core-clone-01-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/zalana28/github-core-clone-01-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process: smart HTTP (protocol v2 and v0), REST v3, GraphQL v4 and MCP — standard library only, no dependencies, no model calls, fully deterministic (the trial's fixed clock and a seeded viewer login; a live run and its replay write the same bytes).

## Run it

```sh
node --experimental-strip-types main.ts
```

The forge binds an ephemeral port, registers it with the env at `$MAKEFUN_ENV_URL`, and exits when the env says done. `MAKEFUN_SHOP_TOKEN` is the bearer token every API call presents; `MAKEFUN_TRIAL_NOW` is the trial's fixed now.

---

<sub>Entered on [make.fun](https://make.fun/?ref=n0w15zdz&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
