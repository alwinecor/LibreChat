# Upstream main integration plan

**Goal:** Integrate upstream/main e081b566a into fork main 4091dd17e on codex/integrate-upstream-2026-10-17, retaining scheduled conversation continuation and Chinese translations.

**Architecture:** Preserve upstream chat extraction and Jotai ownership. Move the fork's scheduleRun projection into the extracted core helpers rather than restoring obsolete hook implementations.

**Spec:** docs/superpowers/specs/2026-10-09-scheduled-conversation-continuation-design.md

## Tasks
- [x] Resolve six conflict files: upstream UI primitives plus existing schedule mode controls; union English keys; upstream hook extraction plus relocated provenance tests.
- [x] Preserve scheduleRun on created/resumed scheduled turns, and clear it for regenerated responses. Run focused core and frontend tests.
- [x] Validate schedule persistence, dispatch, cancellation, restored sessions and UI. Build shared packages; typecheck changed workspaces; run static checks and Lighthouse where supported.
- [x] Review integration delta, commit merge and report checks and limitations. Keep main unchanged.

## Review focus
- Fresh scheduled turns and reconnects retain provenance.
- Regeneration does not inherit scheduled provenance.
- Old schedules default to new conversations; bound schedules retain mode restrictions.
- Automatically merged message rendering still displays schedule badges after extraction.
- Earlier occurrence cleanup cannot affect a newer generation.

## Execution notes
User authorized branch creation and integration. Execute inline in the existing clean checkout on the new branch. No deployment is included. Retain upstream main at the inspected SHA for reproducibility.

## Verification results

- Conflict resolution preserves upstream hook extraction; the fork's four provenance projections now live in `packages/chat/src/core/resumable/{messages,resume}.ts`.
- Core regression tests: 38 passed. Before the projections were restored, the new cases reproduced missing scheduled provenance and stale provenance on regenerated responses.
- Frontend focused suites: 14 suites, 277 tests passed (schedule UI, badges, message memoization, SSE event handling and restored sessions).
- Data schemas: 3 suites, 413 tests passed, including schedule binding and message provenance round trips against mongodb-memory-server.
- Backend schedule/trigger/startup: 29 suites, 976 passed and 4 skipped.
- Legacy controller boundaries: 2 suites, 182 tests passed (partial disconnect and resume metadata).
- Shared schedule schemas: 6 tests passed.
- `npx tsc --noEmit`: passed in packages/api, packages/data-schemas, packages/data-provider, packages/chat, packages/client and client.
- Production build: all shared packages and frontend passed through `npm run lighthouse`'s build stage.
- Explicit-file static runner: all affected checks passed, including ESLint, Prettier, import sorting, package validation, design-rule suppressions and circular dependencies. Slow full-tree gates were not enabled. `git diff --check` passed.
- Browser tests: 10 passed in 5.4 minutes, including idle/busy/compacted continuation, historical task instructions, automatic firing, UI mode persistence, edits and active-run deletion.
- Existing Simplified Chinese translations preserved exactly: 3,501 app keys and 32 shared-component keys.
- Independent static review of final code found no actionable issues; no findings were rejected.

### Environment limitations

- npm 11.19 and repository-pinned 11.13 both stalled in React peer resolution. Installed with `npm ci --legacy-peer-deps`, then restored 39 omitted peer packages from the unchanged upstream lockfile with integrity verification. No package manifests or lockfile were changed.
- MongoDB processes fail to start inside the restricted Windows sandbox; the passing database and backend tests ran with normal local permissions against isolated test databases.
- `npm run static-checks -- --against origin/dev` cannot run because this fork has no origin/dev ref. The explicit-file static runner initially rejected freshly built packages/client assets because Windows copies retain source mtimes. Verified the copied CSS byte-for-byte against its source and re-emitted it with file writes, after which all affected static checks passed. No source/tooling changes were needed; this does not claim the origin/dev or full-tree gate passed.
- `npm run lighthouse` built successfully, then needed the installed Git OpenSSL directory on PATH. `npm run lighthouse:run` reached the browser audit but failed during chrome-launcher Windows temporary-profile cleanup with EPERM. The complete Lighthouse gate did not pass.

## Delivery

The merge commit retains both parent histories. The integration edits were verified explicitly; the merge commit skips the broad formatting hook to avoid rewriting the 193 imported upstream commits. The original main remains at 4091dd17e. No deployment or main-branch promotion is included.
