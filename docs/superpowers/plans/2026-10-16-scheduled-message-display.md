# Scheduled message display

Scheduled runs keep their instruction as the persisted user-side parent of the reply. The chat
view hides that row and puts a small task disclosure on the assistant reply. Ordinary messages
are unchanged. This is a presentation change; model context and conversation ancestry remain intact.

## Data and trust

- `scheduleRun` is optional message metadata: schedule ID, name at dispatch, occurrence time,
  and whether the owner explicitly used Run Now.
- Only the authenticated schedule trigger supplies this metadata. A normal chat body copying
  trigger fields cannot opt into the display behavior.
- The disclosure reads the original parent message when expanded. It never fetches the task's
  current prompt, duplicates instruction text in metadata, or bypasses private-text protection.
- Preliminary messages, created events, resume snapshots, disconnect saves, paused/resumed
  responses, errors and stopped responses preserve the provenance.
- Ordinary regeneration of an old task reply is not a new schedule execution.
- Existing messages without metadata remain unchanged. No heuristic migration is performed.

## Verification

The focused suites cover trusted provenance, database round trips, historical instructions,
ordinary message visibility, streaming creation, resume snapshots and stopped replies.
The mock-browser schedule suite covers persistent history in idle, busy and compacted chats,
manual and automatic execution, task edits and deletion. A separate run of the deletion case
also checks the badge during generation, after reload and after cancellation.

All tests use the isolated local mock provider; no VPS deployment or upstream repository changes
are part of this feature. Detailed local verification output is kept in the ignored
`.superpowers/sdd/schedule-badge-*` files.

Lighthouse was run with `npm run lighthouse` against the isolated server. Windows Chrome
cleanup failed with `EPERM` in `chrome-launcher` after writing reports for two runs, so the
full three-run performance gate did not pass. This is an environment limitation, not a green
Lighthouse result; the available reports must not be presented as a completed median check.
