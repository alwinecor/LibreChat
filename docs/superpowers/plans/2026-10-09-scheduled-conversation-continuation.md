# Scheduled Conversation Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Let an opted-in schedule append context-aware Agent turns to its dedicated conversation, including user replies between occurrences.

**Architecture:** Keep the existing scheduler, durable trigger delivery, and generation admission. Add an atomic schedule-owned conversation binding and a trusted continuation adapter; waiting work reserves no generation capacity. Keep occurrence identity separate from conversation identity throughout cancellation, recovery, and reconciliation.

**Tech Stack:** TypeScript, Zod, Mongoose/MongoDB, existing Agent trigger host, React/React Query, Jest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-09-scheduled-conversation-continuation-design.md` (user approved 2026-10-09).

**Execution record (2026-10-10):** The user authorized inline implementation and self-review.
The six work areas are implemented; the original checklist below records the planned breakdown.
Actual test coverage, implementation refinements and the Windows Lighthouse cleanup limitation are
recorded in [the verification report](2026-10-10-scheduled-conversation-verification.md).
Implementation is delivered as a single reviewed feature commit rather than per-task commits.

## Global Constraints

- Branch `codex/scheduled-conversation-continuation`, based on `upstream/dev` at `908ff5162`.
- Absent target remains `new`; new target is `same`. Existing schedules remain unchanged.
- New configuration: `interface.schedules.continueConversation`, default `false`.
- First run creates a dedicated conversation; arbitrary existing-conversation selection is excluded.
- At most one waiting/active occurrence per schedule. Busy conversations queue rather than interrupt.
- All new behavior is TypeScript under packages; legacy `/api` receives wiring only.
- Preserve owner/tenant/Agent/MCP/project authorization at admission and revision fencing.
- Use existing UI primitives, feature-owned Jotai if new state is needed, React Query invalidation, and English localization keys only.
- No production deployment or paid provider calls during development. Use the controlled mock model.
- Install locked dependencies with `npm ci`; no lockfile upgrades. Lighthouse requires Node 24 and Chrome.

## Review Focus

1. Compaction or user replies between queueing and execution must not silently fork or lose history (Tasks 3, 6).
2. A crash after reservation but before the first message must not look like user deletion (Tasks 2, 4).
3. A late cancellation/cleanup from an older run must not abort a newer user turn in the same conversation (Task 4).
4. Removing authorization or changing project policy while queued must prevent model admission (Tasks 3, 4).
5. A disabled feature or stale dialog must not erase binding state or change existing schedule behavior (Tasks 1, 5).

## Task 1: Shared contracts, opt-in config, and safe status codes

**Files:** Modify `packages/data-provider/src/types/schedules.ts`, its `schedules.spec.ts`, `packages/data-provider/src/config.ts`, `packages/api/src/schedules/types.ts`, `packages/api/src/schedules/service.ts`, and `librechat.example.yaml`. Extend owning config tests alongside the existing config schema tests.

**Interfaces:**
- `ScheduleTarget = 'new' | 'same'`.
- `TScheduleLimits.continueConversation: boolean`; `ScheduleLimits.continueConversation: boolean` defaults false.
- Server response `TSchedule.conversationId?: string` exposes a materialized binding only.
- `ScheduleRunStatus` adds `waiting`; Run Now's response permits `started | waiting`.
- Safe disabled reasons: `conversation_deleted`, `conversation_conflict`, `conversation_project_conflict`, `continuation_disabled`.
- Request errors: `SCHEDULE_CONTINUATION_DISABLED`, `SCHEDULE_BINDING_IMMUTABLE`, `SCHEDULE_ALREADY_PENDING`; expose no raw diagnostic text.

- [ ] Add schema tests: omitted target parses to `new`; `same` parses; unknown targets fail; client-supplied binding fields are rejected without changing historical handling of unrelated fields.
- [ ] Run `npx jest src/types/schedules.spec.ts --runInBand --coverage=false` in `packages/data-provider`; confirm new expectations fail before implementation.
- [ ] Implement these contracts and map the new config flag through effective per-user limits. Document enablement and mixed-version rollout in the example YAML.
- [ ] Run the schema/config focused suites, `npm run build:data-provider` from root, and `npx tsc --noEmit` in changed packages. Expected: pass, no new diagnostics.
- [ ] Commit `feat: define persistent schedule conversation contracts` with only Task 1 files.

## Task 2: Atomic binding, waiting reservation, and branch selection

**Files:** Modify `packages/data-schemas/src/types/schedule.ts`, `schema/schedule.ts`, `methods/schedule.ts`, `methods/schedule.spec.ts`; add `methods/scheduleBinding.ts` and `methods/scheduleBinding.spec.ts`; export through the existing data-schemas methods barrel.

**Interfaces (plain exported inputs/results):**
- `ScheduleBindingScope = { scheduleId: string; userId: string; tenantId?: string; configRevision: number }`.
- `ScheduleConversationBinding = { conversationId: string; materialized: boolean; parentMessageId?: string; revision: number }`.
- `reserveScheduleConversation(scope, candidateConversationId: string): Promise<ScheduleConversationBinding | null>`; null means inactive/stale/inaccessible schedule, never a query failure.
- `markScheduleConversationMaterialized(scope, conversationId: string, parentMessageId: string): Promise<boolean>`; idempotent, fenced to the existing binding.
- `resolveScheduleConversationBranch(scope): Promise<{ status: 'ready'; conversationId: string; parentMessageId: string; bindingRevision: number } | { status: 'unmaterialized' | 'missing' | 'conflict' | 'project_conflict' }>`.
- Persist the binding as a nested server-owned field on Schedule. Add exact `generationCreatedAt?: number` to occurrence records; keep existing `deliveryKey`.
- Extend occurrence reservation to permit `waiting` without `capacitySlot`; the single-pending uniqueness rule covers waiting and started rows. Paused approvals block persistent-mode reentry; preserve old `new` behavior.

- [ ] Add real Mongo tests: two concurrent reservations return one ID; stale revision and wrong owner/tenant cannot reserve; unmaterialized state survives process recreation; materialization is idempotent.
- [ ] Add branch tests: unique descendant chain includes manual replies; multiple competing children cause conflict; missing materialized conversation is deletion; a project mismatch never moves it implicitly.
- [ ] Add waiting tests: duplicate occurrence cannot reserve twice; second pending occurrence is overlap; waiting has no global capacity slot; querying errors reject rather than return absence.
- [ ] Run `npx jest src/methods/scheduleBinding.spec.ts src/methods/schedule.spec.ts --runInBand --coverage=false` in `packages/data-schemas`; confirm relevant failures.
- [ ] Implement methods via injected Mongoose models with conditional atomic writes. Use bounded branch queries and preserve tenant context. Do not convert existing public methods to Mongoose-dependent inputs.
- [ ] Rerun tests and `npx tsc --noEmit`; inspect index behavior against legacy fixtures before committing `feat: persist schedule conversation bindings`.

## Task 3: Trusted continuation admission and durable busy deferral

**Files:** Add `packages/api/src/schedules/continuation.ts`, `continuation.spec.ts`; modify `agents/triggers/continuation.ts`, its `continuation.spec.ts`, `agents/triggers/host.ts` and `host.spec.ts` only where the existing contract needs extension; update package exports and `api/server/services/Agents/triggers.js` wiring.

**Interfaces:**
- Export `createScheduleContinuationResolver(deps): NonNullable<AgentTriggerExecutionHostDeps['prepareContinue']>`.
- Its typed deps receive Task 2 methods, current policy/access resolution, authoritative generation lookup/admission evidence, and existing capacity allocation. No app singleton reads inside the resolver.
- Add an explicitly injected schedule resolver selected only for trusted `event.source.type === 'schedule'`; verify the persisted occurrence and delivery identity before accepting it.
- Reuse `AgentTriggerExecutionError` with `retryable: true, deferWithoutAttempt: true` for busy state. Use the existing polling/settlement wakeup configuration, not another hard-coded retry interval.
- Return the current authoritative parent and existing `scheduleMCPIdentity` to the normal Agent host. Bind the selected parent and idempotency identity once admission starts; an ambiguous retry cannot select a new parent.

- [ ] Add resolver tests for non-schedule spoofing, missing occurrence, wrong principal, stale configuration, changed Agent/MCP permission, deleted conversation, project conflict, and disabled feature.
- [ ] Add busy-then-idle test: first preparation defers with no capacity/model admission, user finishes a turn, next preparation selects its leaf; repeat dispatch uses the same accepted parent and delivery ID.
- [ ] Run `npx jest src/schedules/continuation.spec.ts src/agents/triggers/continuation.spec.ts src/agents/triggers/host.spec.ts --runInBand --coverage=false` in `packages/api`; verify expected failures.
- [ ] Implement the adapter, retaining normal authentication and enrollment checks. Resolve branch/config data before transport, reuse loaded results, and start independent reads together.
- [ ] Rerun tests and API typecheck; verify legacy trigger adapters retain behavior; commit `feat: admit scheduled turns into persistent conversations`.

## Task 4: Connect scheduler, queue lifecycle, and generation-safe cleanup

**Files:** Modify `packages/api/src/schedules/fire.ts`, `handlers.ts`, `engine.ts`, `service.ts`, `erasure.ts` and their focused specs; update Task 2 methods/tests where settlement and index handling need integration. Adjust receipt/integration tests in `packages/api/src/schedules`.

**Interfaces:**
- `fireSchedule` returns the existing result plus optional `waiting: true`; HTTP Run Now exposes the corresponding waiting status.
- `same` first dispatch recovers its Task 2 reservation and uses fire; later dispatch uses continue with the trusted schedule source.
- Enforce stable occurrence delivery identity and existing revision fence. Waiting-to-started promotion acquires global capacity atomically immediately before admission; compensation uses evidence of definite non-admission only.
- First accepted conversation persistence marks materialization; accepted generation and terminal cursor writes include exact occurrence/generation identity.
- Once bound, reject Agent/target changes with `SCHEDULE_BINDING_IMMUTABLE`; cadence/prompt edits remain available and fence old waiting work.

- [ ] Add integration fixtures for two occurrences returning one conversation ID, no history loss, first-run crash/retry, same occurrence retry, and one pending slot across manual/automatic triggers.
- [ ] Add queue tests: waiting appears in list; later ticks skip overlap; Run Now conflicts; pause/delete/edit retires waiting work; restart rediscovers it; no capacity is held while busy.
- [ ] Add regression test: run A settles late after run B or a manual turn takes over the same conversation; A cannot cancel B, delete B's checkpoints, release B's slot, or overwrite the binding cursor.
- [ ] Add paused-approval, permission-revocation, account-deletion, feature-disable, project-policy-change, and conversation-deletion tests. Deleting a schedule preserves its conversation.
- [ ] Run focused fire/handler/engine/erasure/service suites in `packages/api` to establish failures; implement the lifecycle changes and audit all conversation-ID lookups by occurrence and generation.
- [ ] Run `npx jest src/schedules --runInBand --coverage=false` and changed data-schema tests, then both workspace typechecks. Commit `feat: dispatch and reconcile persistent scheduled conversations` only after they pass.

## Task 5: Schedule dialog and observable waiting/recovery states

**Files:** Modify `client/src/components/SidePanel/Schedules/ScheduleDialog.tsx`, `ScheduleCard.tsx`, `SchedulePanel.tsx`, `errors.ts`, their colocated tests, `client/src/locales/en/translation.json`, and existing schedule data-provider mutation hooks if their response types require it.

**Interfaces:**
- Dialog includes target in form values, populated from stored schedule and defaulting to `new`.
- Show `same` as available only when effective limits allow it. Existing disabled bindings remain visible and cannot silently revert on submit.
- Bound schedule Agent/target controls explain their immutability; prompt/cadence edits remain usable.
- Card uses the materialized `conversationId` for Open conversation, independent of last-run success, and distinguishes waiting/running/paused/error.

- [ ] Add tests for mode selection, reload/edit preservation, flag-off stale dialog, immutable binding, waiting status, failed run retaining the conversation link, create error/retry, and keyboard navigation.
- [ ] Run `npx jest src/components/SidePanel/Schedules/__tests__ --runInBand --coverage=false` in `client`; confirm missing behavior fails.
- [ ] Implement with existing primitives and `useLocalize`, preserving dialog focus and scroll behavior. Invalidate schedules and relevant conversations through existing React Query paths after mutation/run results.
- [ ] Rerun component tests and `npx tsc --noEmit` in client; commit `feat: expose persistent schedule mode and waiting state`.

## Task 6: E2E, rollout documentation, and full branch verification

**Files:** Extend `e2e/specs/mock/schedules-execution.spec.ts` and `schedules.spec.ts`, existing mock-server fixtures/config as needed, and `packages/api/src/schedules/FOLLOWUPS.md`. Update the approved spec with implementation decisions only if they preserve its behavior.

- [ ] Add controlled-model E2E: create same-mode schedule in the UI, Run Now, send a manual message in its conversation, Run Now again, and assert one conversation containing both scheduled turns and the manual turn. Assert actual model input contains prior context, not just visible DOM text.
- [ ] Add controlled busy-generation E2E: hold a manual response open, trigger the schedule, observe waiting, release the response, and verify exactly one queued turn after it; reload preserves mode/link/status.
- [ ] Add backend compaction regression asserting canonical parent persistence across history reduction, followed by a manual turn and another scheduled turn with continuous history.
- [ ] Prepare Node 24/locked dependencies/local browser and disposable Mongo in the execution checkout. Use the worktree skill before execution if isolation is needed. Never run the harness against production.
- [ ] Build once with `npm run e2e:prepare`; run `npx playwright test --config=e2e/playwright.config.mock.ts schedules-execution.spec.ts schedules.spec.ts`. Expected: all selected tests pass against mock inference.
- [ ] Run focused owning-workspace Jest suites and `npx tsc --noEmit` in data-provider, data-schemas, API, and client. Build output alone does not count as typechecking.
- [ ] Run `npm run sort-imports -- <touched source paths>`, scoped formatting/lint, `npm run static-checks -- --against upstream/dev`, and `git diff --check`; fix changed-code issues and rerun affected tests.
- [ ] Run `npm run lighthouse` under its documented local environment. Require the existing LCP/CLS/TBT budgets; report environment blockers instead of claiming a pass.
- [ ] Document same/new semantics, queue bound, ambiguity/deletion behavior, token-history cost, feature flag, compatible-replica rollout, and disable/drain-before-rollback. No new dependency on OpenAI persistent storage.
- [ ] Commit `test: verify scheduled conversation continuity end to end`; conduct a whole-branch review covering identity, authorization, persistence, retries, cancellation, cleanup, and old rows.
- [ ] Report final commit, tests, any unavailable checks, and review findings. Do not claim production behavior was tested or deploy as part of this source-development task.

## Execution choice and review

Recommended: native execution in the current session, task by task, because these
changes share the same occurrence/admission contracts and benefit from one owner
carrying the invariants across layers. A fresh whole-branch review follows implementation.
Subagent-driven execution is an alternative if the user prefers independent review
after each task; it introduces more review/context overhead.

Self-review completed: the plan covers all approved spec sections, defines the shared
names used by later tasks, and assigns each Review Focus condition to a regression.
The user approved execution and requested that the implementer perform final review.
