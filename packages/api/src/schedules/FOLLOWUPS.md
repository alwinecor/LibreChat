# Scheduled chats: deferred scope

Scheduled chats remain experimental and default-off.

## Must-have product follow-ups

- Add one-time and monthly schedules; current cadences are hourly, daily, weekdays, and weekly.
- Add non-agent chat targets and binding to a user-selected existing conversation. Persistent
  schedules currently create their own dedicated conversation on the first run.

## Persistent conversations

Enable `interface.schedules.continueConversation: true` to offer **Continue the same conversation**.
The default remains a new conversation per run. Persistent runs include previous turns and manual
replies, through the normal message-loading and compaction path; longer history can cost more tokens.
No OpenAI-hosted conversation storage or new provider dependency is required.

A busy conversation holds at most one waiting occurrence per schedule, without holding a generation
capacity slot. Additional automatic ticks skip; another Run Now returns a conflict. Pausing or editing
the schedule fences waiting work using the configuration revision. Once allocated, the conversation,
agent and project are fixed. Prompt and cadence remain editable. Ambiguous branches, failed or
unfinished final messages, a deleted conversation, or a changed project pin stop automatic continuation
instead of silently choosing another branch or recreating the conversation. Deleting the schedule
keeps its conversation.

Deploy compatible code to every replica before enabling the flag. Keep the existing shared-store /
single-process topology requirements. Before rolling back, disable the flag, pause persistent schedules,
and drain their waiting/running occurrences; older replicas cannot process persistent targets safely.

## Client/API parity

- Return `minIntervalMinutes` in schedule limits and surface it in the dialog.
- Add active-run and run-history discovery. The list response currently projects only `lastRun`,
  which is written on pause, skip, or terminal outcomes, so the client's `started` chip is
  unreachable.
- Add multi-day weekly, timezone, and attachment controls. The API supports these, but the dialog
  does not. NOTE: the dialog cannot scroll from `md` up (`md:overflow-visible` exists because the
  Ariakit popovers cannot portal out of the focus-trapping Radix dialog), so its content must fit
  the viewport — roughly 30px of slack remain at 1280x720. Each of these controls adds a row and
  will push the footer's Save button out of reach. Adding them needs the height problem solved
  first: give `ControlCombobox` the `portalElement` prop `Dropdown` already has, portal the
  popovers into the dialog content element, and let the form scroll again.

## Known gaps: project scope

- A project deleted inside the window between the resume controller's
  `isScheduleLive(..., { policy: true })` check and `claimScheduleResume` is not caught:
  deletion bumps no revision, so the lease fence cannot see it and the continuation
  starts against a conversation that was just unscoped. Sub-second, and self-correcting
  at the next fire (which auto-disables the schedule). Closing it needs a distinct
  policy conflict returned from the claim that the controller routes through
  abort-and-settle, rather than the bare 409 an `inactive` conflict produces today.
- The stored project converges on an operator pin only when the schedule actually
  FIRES. A schedule that has not fired since the pin moved still carries its old id,
  which the wire projection already papers over but a direct read of the row does not.
  Resume validation is unaffected — it reads the occurrence's own record.

## Runtime scope

- The standard server supports multi-replica scheduling only with a confirmed Redis-backed
  `GenerationJobManager`; in-memory mode requires `SCHEDULES_SINGLE_PROCESS`. The legacy
  `experimental.js` clustered entrypoint does not arm the engine and rejects schedule writes.
- Deferred account deletion blocks new remote API admission but cannot yet drain already-admitted
  OpenAI-compatible or Responses requests; see
  [#14594](https://github.com/LibreChat-AI/LibreChat/issues/14594).

## Test debt

- Add Playwright coverage for creating a schedule through the UI. The execution E2E currently
  seeds schedules through the API.
