# Scheduled conversation continuation

Status: design approved by the user on 2026-10-09. Implementation plan awaits review; no runtime implementation yet.

## Intent and acceptance

The user wants repeated scheduled Agent executions to appear in the same LibreChat
conversation and use its previous messages as context. They may continue chatting
in that conversation between scheduled runs. Keep the existing new-conversation
behavior available and preserve all existing schedules.

The first version adds an optional per-schedule persistent conversation. The first
accepted occurrence creates it; later occurrences append normal Agent turns. It
does not require OpenAI Conversations API support from the user's New API upstream.
This branch develops the feature; production deployment is a separate step.

## Baseline and existing mechanisms

- Branch: `codex/scheduled-conversation-continuation`.
- Base: `upstream/dev`, commit `908ff5162a6efcf70e86a643bee05b1bdf6610c1`.
- The user's deployment baseline remains `664b67408`; the source branch is newer.
- Shared schedule schemas currently admit only `target: 'new'`.
- `schedules/fire.ts` reserves a random conversation ID per occurrence and sends a
  durable `fire` trigger. Occurrence identity already supports idempotent delivery.
- The Agent trigger host already supports `continue`, authoritative parent-message
  preparation, generation admission, retry deferral, and durable delivery receipts.
- Its continuation resolver currently distinguishes authenticated event bindings
  and registered internal sources. Scheduled continuations need an explicit trusted
  adapter; they must not bypass these checks by manufacturing an event binding.
- Reconciliation and cancellation currently identify work through conversation IDs
  and generation identity. Reusing a conversation requires auditing every such use.

## Alternatives and choice

1. Extend LibreChat schedules and reuse its durable Agent continuation machinery
   (chosen). This preserves the UI, local history, permissions, and provider choices.
2. Run an external OpenClaw/LangGraph scheduler. This duplicates scheduling, auth,
   failure handling, and UI integration; it does not deliver a native LibreChat feature.
3. Delegate history to OpenAI Conversations API. This adds upstream compatibility
   requirements and still needs local message persistence and concurrency control.

Reference behavior comes from OpenClaw's persistent session targets and LangGraph's
thread-bound crons. Reimplement the relevant concepts within LibreChat's contracts;
do not copy either project's runtime or introduce those services as dependencies.

## User experience

- The schedule dialog offers “New conversation each run” (existing default) and
  “Continue in the same conversation”. The choice survives editing and reloads.
- Persistent mode creates a dedicated conversation on its first accepted run and
  then exposes an Open conversation action even if the latest occurrence failed.
- Scheduled prompts and replies appear as ordinary persisted turns. Background
  updates use the existing conversation/query refresh and unread mechanisms.
- A queued occurrence is visibly waiting rather than incorrectly shown as running.
- Users can pause, edit, delete, or run now through the existing actions. Pausing
  cancels queued work; already admitted work follows the existing stop contract.
- Once a persistent conversation is bound, changing its Agent or target mode is
  rejected with actionable localized copy. Create another schedule to start a new
  binding. Cadence and prompt remain editable with revision conflict protection.
- Deleting a schedule leaves its conversation intact. Deleting the bound conversation
  disables the schedule; it does not silently recreate a conversation.
- Arbitrary existing-conversation selection is outside the first version. This keeps
  the initial change focused on repeated runs of one task in its dedicated conversation.

## Contract and storage

- Extend target with a persistent mode (`same`); absent values remain `new`.
- Add server-owned binding fields for conversation ID and authoritative branch
  position. Reject client attempts to supply or replace server-owned binding state.
- Persist binding reservation atomically under owner, tenant, schedule ID, and
  configuration revision. A crash before first generation must reuse the reservation,
  not create a second conversation or confuse an unmaterialized reservation with a
  user-deleted conversation. Track materialization explicitly.
- Store per-occurrence dispatch/generation identity separately from the durable
  conversation ID. Never use conversation ID alone to cancel or settle a run.
- Expose the bound conversation and waiting state in shared API types. Preserve
  existing request defaults, idempotency keys, limits, and old rows without migration.
- Add a config-schema option under `interface.schedules` for enabling this mode,
  default false, and expose the resolved capability to the dialog. Disabled mode
  rejects new bindings and pauses persistent dispatch while keeping definitions.
- Public data-schemas methods use plain typed contracts; database types remain in
  data-schemas. Errors use stable safe codes, localized by the client.

## Dispatch and history

1. Revalidate the owner, tenant, current schedule revision, feature permission,
   Agent access, project policy, files, and unattended MCP credentials.
2. Reserve or recover the binding. For the first turn use the existing `fire` path.
   For subsequent turns create a trusted schedule continuation delivery.
3. Immediately before admission, reload authoritative conversation/branch state.
   Continue along the bound branch, including intervening user turns on that branch.
   If edits or forks make the continuation ambiguous, pause with a clear conflict
   instead of guessing another branch or using a stale parent message.
4. Reuse normal Agent history loading, attachments, tool messages, and context-window
   management. Do not concatenate visible text or use the memory tool as a substitute
   for the transcript. Model/API credentials follow the existing Agent path.
5. On admission, persist the exact generation identity. On completion, update the
   branch cursor from canonical persisted messages, including after compaction.
   Ambiguous transport outcomes retry the same delivery and cannot append twice.

No parallel generation may write to the same conversation. Check the authoritative
generation admission mechanism for interactive and scheduled runs alike; checking
only another occurrence of the same schedule is insufficient.

## Queue and lifecycle policy

- If the conversation is busy, persist one waiting occurrence and retry through the
  durable delivery mechanism. Resolve its parent at admission, after the active turn
  has settled. Do not interrupt or inject into the user's current generation.
- Keep at most one waiting/active occurrence per schedule. Later ticks follow the
  existing overlap-skip policy, preventing an unlimited backlog. Run now while work
  is already pending returns a stable conflict and does not add another delivery.
- Busy deferral does not consume generation capacity, model tokens, or the ordinary
  failure threshold. It remains recoverable after a server restart.
- Edit, disable, delete, permission revocation, and binding deletion fence pending
  deliveries using the current revision and ownership rules before model admission.
- Project policy changes may not silently move a conversation containing user turns.
  A conflict disables further dispatch with an actionable reason.
- Cleanup for an older occurrence may never delete checkpoints, release a lease, or
  abort a newer manual/scheduled generation that happens to share the conversation.
- Deploy all API replicas on compatible code before enabling the new mode; old
  binaries do not understand the new target. Disable and drain it before rollback.

## Ownership of changes

- `packages/data-provider`: payload/response schemas, config switch, safe error codes.
- `packages/data-schemas`: binding and occurrence storage, atomic methods, indexes.
- `packages/api/src/schedules`: admission, first-run reservation, lifecycle and status.
- `packages/api/src/agents/triggers`: explicitly authorized schedule continuation
  adapter and integration with existing delivery/admission contracts.
- `client/src/components/SidePanel/Schedules`: mode picker, binding link, waiting and
  conflict states using existing primitives and React Query invalidation.
- `client/src/locales/en/translation.json`: new visible strings, per contributor rules.
- Legacy `api` files receive wiring only if needed; new behavior remains TypeScript.

## Verification and completion criteria

- Schema tests preserve old defaults and reject invalid or client-owned bindings.
- Real database tests cover competing first runs, crash/retry reservation recovery,
  owner/tenant isolation, one waiting occurrence, and stale-revision cancellation.
- Focused schedule/trigger tests cover two runs in one conversation, preserved
  history, manual interaction between runs, busy admission, restart, retry without
  duplicate turns, changed branches, deletion, and permission/project changes.
- Cancellation/reconciliation tests prove an old occurrence cannot affect a newer
  generation in the same conversation, including paused approvals and compaction.
- Component tests cover selecting/editing the mode, waiting, errors, and opening the
  bound conversation, with keyboard access and localized copy.
- Run owning-workspace TypeScript checks and focused Jest suites, scoped formatting
  and lint, static checks against upstream/dev, and Lighthouse as required for the
  config/message-loading changes. Report any unavailable checks explicitly.
- Add an isolated E2E using a controlled model endpoint: create a persistent schedule,
  execute twice, insert a user turn between runs, and assert one conversation with
  correct history. No production paid model calls are needed for this test.

## References

- OpenClaw targets: https://github.com/openclaw/openclaw/blob/main/docs/cli/cron.md
- OpenClaw session resolution: https://github.com/openclaw/openclaw/blob/main/src/cron/isolated-agent/session.ts
- OpenClaw continuity regression: https://github.com/openclaw/openclaw/pull/82200
- LangGraph thread-bound cron: https://docs.langchain.com/langsmith/cron-jobs
- LangGraph SDK: https://github.com/langchain-ai/langgraph/blob/main/libs/sdk-py/langgraph_sdk/_async/cron.py

The user approved this written spec on 2026-10-09. The implementation plan is in
`docs/superpowers/plans/2026-10-09-scheduled-conversation-continuation.md`.
