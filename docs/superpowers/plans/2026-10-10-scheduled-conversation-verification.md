# Persistent scheduled conversations: implementation and review

Original development branch: `codex/scheduled-conversation-continuation`, based on `upstream/dev` at `908ff5162`.
The PR branch `codex/scheduled-continuation-main` ports only the six feature/localization commits onto
`alwinecor/LibreChat` main at `664b67408`; the 56 intervening upstream dev commits are excluded.
The original implementation and self-review evidence below is retained for context; the PR validation
records the checks repeated on the main-based tree. An independent port review found no missing
upstream dependency or actionable correctness finding.

## Delivered

- Opt-in `interface.schedules.continueConversation`, preserving `new` as the default.
- Atomic owner/tenant-scoped binding, immutable agent/project/target after allocation, and deletion fencing.
- Durable occurrence identity separate from the shared conversation; one waiting occurrence without a capacity slot.
- Trusted continuation through the existing trigger/admission path, including current permissions, MCP preflight, project policy and configuration revision checks.
- Normal message history and compaction loading, including manual turns between occurrences.
- Dialog mode selection, locked identity, waiting state, bound conversation link, and English localization keys.
- Rollout and rollback guidance in `packages/api/src/schedules/FOLLOWUPS.md`.

Implementation refinements to the plan: waiting is represented by `waiting: true` on a `started`
database occurrence, retaining the existing single-active partial unique index. Branch selection
uses a conservative unique complete transcript chain at admission, rather than a mutable cached
cursor. Forks and orphaned/incomplete leaves stop continuation. The normal generation epoch fence
protects replacement turns. Service composition injects trigger functions into the schedule factory
to avoid a circular runtime dependency.

## Evidence

- API schedules: 26 Jest suites, 849 passed, 4 existing skipped.
- Trigger host/router and provider-drain regression: 45 passed.
- Database schedule, binding and conversation suites: 590 passed; binding suite rerun after incomplete-leaf protection: 9 passed.
- Schedule client components: 106 passed; dialog rerun after bound-project display correction: 42 passed.
- Legacy request recovery/replacement: 216 passed; service composition and request wiring rerun: 186 passed.
- Shared schedule contract: 6 passed.
- TypeScript `--noEmit`: data-provider, data-schemas, API and client.
- Mock Playwright schedule execution and UI suites: 10 passed. Includes actual model-input history assertions, busy admission, real context compaction, UI creation/reload, default new-conversation behavior, automatic ticks and deletion.
- Production workspace/client builds passed. Scoped static checks passed, including ESLint, formatting, import sorting, design rules and circular dependencies. Full optional static lanes were not run.

`npm run lighthouse` was run with local Chrome and disposable MongoDB. All three report files
were produced with no runtime navigation error. Median LCP was 3783.726 ms, CLS 0.0169523 and
TBT 171.753 ms (budgets: 4500 ms / 0.1 / 500 ms). The command nevertheless exited nonzero when
Chrome Launcher could not remove its temporary Windows profile (`EPERM`). This is **not a green
Lighthouse gate**; rerun that gate on an environment without the cleanup failure before release.

The local static-check bundle freshness gate needed the copied CSS timestamp refreshed after its
content hash was verified equal to `src/theme/tokens.css`: the build's copy preserved the old source
timestamp. Refreshing the source file's timestamp (without changing its contents) and rebuilding
also allowed the normal pre-commit build to pass the freshness check. No checks were bypassed.

## Review results

The review followed identity, authorization, persistence, retry, cancellation, cleanup and old-row
compatibility through the database methods, scheduler, trigger host, request controller and UI.
Findings fixed and covered by regressions: relative versus absolute MCP deadline, retained scheduled
job cleanup after provider drain, immutable-identity write race, conversation deletion before binding
materialization, failed/unfinished branch leaves, changed project pins, and bound project display.
The provider-drain regression checks that a late callback leaves a replacement manual generation intact.

There is no independent reviewer or remote CI result. This source-development task does not deploy
the feature to the VPS or enable the flag in the deployment repository.
