# Plan: Fix edit diffs/permissions + tool call titles/kinds in agentic.nvim (pi-acp side)

> You are an agent starting with a fresh context window. Read this file top to bottom before doing anything else. It is your complete brief. Do not re-derive the plan from the codebase — follow the steps below. If a step is ambiguous, ask the user rather than guessing.

## Goal
When agentic.nvim is used with pi-acp, three UX problems must be fixed, entirely within pi-acp:
1. Gated edits render as an `other`-kind tool call with raw JSON and no inspectable diff/permission flow.
2. Read tool calls show `read(read)` with only a line count — the file path is invisible.
3. pi's native `grep`/`find`/`ls` tools show as `other(grep)` with a raw-JSON body to unfold, instead of a search block titled with the actual pattern/path. (Commands run through the `bash` tool already render as `execute(<command>)` because pi-acp sets `title: bashCommand(args)` and `kind: 'execute'` for bash only.)

## Context
Diagnosis (verified by capturing real traffic between `dist/index.js` and pi 0.84.4, plus reading agentic.nvim @ commit 81628c1):

### Part 1 — edit diffs/permissions
- pi-acp already emits a spec-compliant structured diff at completion (`src/acp/session.ts:764-798`): `{type:'diff', path, oldText, newText}` — matches ACP SDK 0.26 schema and agentic.nvim's parser (`acp_client.lua:556-571`). No `newString`/field-name mismatch exists anywhere.
- The user's pi config (`~/.pi/agent/extensions/permissions/`, `permissions.json` with `"edits": "manual"`) gates edits via an extension UI request. pi-acp converts this to an ACP `session/request_permission` whose `toolCall` is a synthetic `pi-ui-<id>` call with `kind:'other'` and `rawInput` = `{method:'select', title:'🔒 edit: hello.txt', options:[...]}` (`src/acp/session.ts:904-1035`, `extensionUiToolCall()`). agentic.nvim renders this as the raw-JSON "other" block — the visible symptom.
- agentic.nvim's "look closer" diff preview (`ui/diff_coordinator.lua`) fires ONLY from `on_request_permission` (`session_manager.lua:740`) and requires a tracker with `kind=='edit'`, `diff ~= nil`, `file_path` — keyed by the request's `toolCallId`. Both fail today: the id is the synthetic `pi-ui-...` one, and the edit tracker has no diff until completion (completion triggers `clear`, not `show`).
- Event order over pi RPC (verified in capture): `tool_execution_start` (args + pre-mutation snapshot available) → extension permission request → `tool_execution_end`. So at permission time pi-acp knows the real tool call and can project the edit.
- pi edit args: `{path, edits: [{oldText, newText}]}`; write args: `{path, content}` (pi `dist/core/tools/edit.js`, `write.js`). pi-acp already parses these (`getParsedEdits`, `getToolPath` in `src/acp/session.ts:78-120`).
- Existing deliberate decision not to emit start-time diffs is encoded in `test/component/session-diff.test.ts:69` ("does not turn requested edit args into finalized ACP diffs at tool start"). This plan intentionally reverses it: emit a *projected* diff while `in_progress`, superseded by the realized diff at completion.
- agentic.nvim quirks this must satisfy (do NOT modify agentic.nvim):
  - Option rejection detection compares optionId literally to `"reject_once"`/`"reject_always"` (`session_manager.lua:728-733`), so deny-ish options should carry those optionIds.
  - `DiffPreview.show_diff` uses `extract_diff_blocks(..., strict=true)`, but at permission time the file on disk still equals `oldText`, so full-file old/new matches exactly and minimizes correctly via `vim.diff`.
  - `content.path` on the diff sets the tracker's `file_path` (needed by `_edit_tracker`).

### Part 2 — tool call titles and kinds
- pi-acp sets `title: toolName` for every non-bash tool call (`src/acp/session.ts:620,702`), so agentic's header — built as `kind(title)` (`message_writer.lua:670-675`) — shows `read(read)`, `edit(edit)`, `other(grep)`.
- `toToolKind` (`src/acp/session.ts:1055`) maps only read/write/edit/bash; pi's native `grep`, `find`, `ls` tools fall to `'other'`.
- agentic's kind-`read` renderer shows only "Read N lines" from the body; the header argument comes from `title`. Setting `title` to the file path fixes visibility; `locations` already carries the resolved path (`toToolCallLocations`).
- Bash is already good: `emitBashToolCall` uses `title: bashCommand(args) ?? toolName`, `kind: 'execute'` — the model sometimes uses bash for ls/grep (→ `execute(ls ...)` with terminal) and sometimes pi's native search tools (→ `other(grep)`). That explains the inconsistency the user sees.
- Tool titles must also be emitted on the `tool_call_update`s sent at `tool_execution_start`, because titles streamed during arg deltas (`toolcall_start`/`toolcall_delta`, where args are partial) are often missing/incomplete; agentic merges later titles into the block tracker (`__build_tool_call_message` picks up `update.title`, `update_tool_call_block` merges it).
- Session-load replay (`src/acp/agent.ts:1058-1070`) also uses `title: toolName` and an ad-hoc kind mapping — reuse the same helpers there.
- pi tool arg shapes (from pi `dist/core/tools/*.js` TypeBox schemas): read `{path, offset?, limit?}`; grep `{pattern, path?, glob?, ignoreCase?, literal?, context?, limit?}`; find `{pattern, path?, limit?}`; ls `{path?, limit?}`; edit `{path, edits:[{oldText,newText}]}`; write `{path, content}`; bash `{command, timeout?}`.

## Steps
1. Track the active file-mutation tool call in `PiAcpSession` (next to `fileSnapshots`, `src/acp/session.ts:287-293`): at `tool_execution_start` for `edit`/`write`, store `{toolCallId, toolName, args, locations}` in a new field (e.g. `activeFileMutation`). Clear it in `cleanupToolCall` when the id matches.
2. Add a projection helper (in `src/acp/session.ts` near `getParsedEdits`): `projectNewContent(oldText: string | null, toolName: string, args: unknown): string | null` —
   - `write`: return `args.content` if it's a string.
   - `edit`: apply each parsed edit's `oldText`→`newText` as an exact-match replacement on the old content (first occurrence, sequential); if no edit applies, return `null`. (Exact match only — pi's fuzzy matching is handled by the realized diff at completion.)
3. Emit an in-progress projected diff: in the `tool_execution_start` case for `edit`/`write`, after the existing status-transition emission, if a snapshot exists and the projection is non-null and differs from the old text, emit a `tool_call_update` with `status:'in_progress'`, `toolCallId`, and `content: [{type:'diff', path, oldText: snapshot.oldText, newText: projected}]`. Use `oldText: null` for new-file writes.
4. Attribute permission requests to the real tool call: in `handleExtensionSelect` (and `handleExtensionConfirm` for the confirm case), when `activeFileMutation` is set, build the ACP `requestPermission` `toolCall` as `{toolCallId: activeFileMutation.toolCallId, title: <pi's UI request title>, kind: toToolKind(toolName), status:'pending', rawInput: args, locations}` instead of `extensionUiToolCall(...)`. Keep answering pi's extension UI request exactly as today (selected option index / cancelled).
5. Map option names to ACP kinds/optionIds for the attributed case: `/always/i` → `allow_always`, `/allow|approve|yes|ok/i` → `allow_once`, `/deny|reject|no|cancel/i` → `reject_once` (or `reject_always` for "always reject"). If two options would collide on the same optionId, fall back to `choice-N`. Maintain a per-request `optionId → pi option index` map so the extension UI response still sends pi the correct option string. Non-attributed selects keep current behavior (`choice-N`, kind `allow_once`).
6. Add a tool-title helper (e.g. `toolTitle(toolName: string, args: unknown): string` in `src/acp/translate/pi-tools.ts` or `src/acp/session.ts`): `read`/`write`/`edit` → `path` (fall back to toolName when absent); `grep`/`find` → `pattern` (append ` in <path>` when `path`/`glob` is set, if concise); `ls` → `path ?? '.'`; default → toolName. Sanitize newlines out of titles (agentic header is one line).
7. Extend `toToolKind`: `grep`/`find`/`ls` → `'search'`; keep existing mappings. (`search` is in agentic's `KNOWN_ACP_KINDS`; the header becomes `search(<pattern>)` and the body keeps the results text.)
8. Use `toolTitle` + extended `toToolKind` at all emission sites:
   - Streaming path (`toolcall_start`/`toolcall_delta`/`toolcall_end` → `tool_call`, `src/acp/session.ts:617-624`): title from partial args when parseable, else toolName.
   - `tool_execution_start` (`src/acp/session.ts:646-720`): include `title: toolTitle(...)` on both the first `tool_call` and the `tool_call_update` transition, so the title corrects itself once full args are known. (Bash path already sets `bashCommand`; leave it.)
   - Session-load replay in `src/acp/agent.ts:1058-1070`: replace `title: toolName` and the ad-hoc kind mapping with the shared helpers (best-effort args for the title come from the historic message's input/details; if unavailable, keep toolName).
9. Update/extend tests:
   - `test/component/session-diff.test.ts`: replace the "no start-time diff" test with: edit emits a projected in-progress diff at `tool_execution_start`, superseded by the realized diff at `tool_execution_end` (old/new from actual file reads); write projection uses `args.content`; oldText-not-found edits emit no projection.
   - Permission tests (in `test/component/session-events.test.ts` or a new component test file): extension `select` during an in-flight edit produces a request whose toolCallId/kind/rawInput match the real tool call, with `allow_once`/`reject_once` options; answering it maps back to the correct pi option string; unrelated selects (no active file mutation) keep the current synthetic shape.
   - Title/kind tests: `read` call titled with its path and kind `read`; `grep` call kind `search` titled with pattern; `edit`/`write` titled with path.
10. Update `README.md` (the feature bullets around line 20) to describe the in-progress projected diff, attributed permission requests, and tool-kind/title mapping. Run `npm run format` on touched files.

## Files to modify
- `src/acp/session.ts` — active file-mutation tracking, projection helper, in-progress diff emission, permission attribution/option mapping (`handleExtensionSelect`/`handleExtensionConfirm`/`requestExtensionPermission`/`extensionUiToolCall` at lines ~904-1035; `tool_execution_start` case at ~646-720; `cleanupToolCall`), `toToolKind` extension (~1055), `toolTitle` usage at emission sites.
- `src/acp/translate/pi-tools.ts` (or session.ts) — `toolTitle` helper.
- `src/acp/agent.ts` — replay path title/kind (~1058-1070).
- `test/component/session-diff.test.ts` — update start-time expectations, add projection cases.
- `test/component/session-events.test.ts` (or new `test/component/session-permissions.test.ts`) — permission attribution tests; title/kind assertions.
- `README.md` — behavior documentation.

## Verification
1. `npm run build && npm test` (unit + component tests pass).
2. End-to-end capture (pattern from `scripts/smoke-acp.mjs`, run against a temp dir with scratch files): after prompts that read, grep, and edit a file, confirm the JSON stream shows:
   - `read` tool call titled with the file path, `kind:'read'`;
   - `grep` tool call with `kind:'search'` titled with the pattern;
   - `edit` tool call with `kind:'edit'` titled with the path;
   - an `in_progress` `tool_call_update` carrying `{type:'diff', oldText: <pre-edit file>, newText: <projected>}`;
   - a `session/request_permission` whose `toolCallId` equals the edit call id, `kind:'edit'`, and options `allow_once`/`reject_once`;
   - a completed `tool_call_update` with the realized diff.
3. Manual agentic.nvim check: open the agentic chat on a scratch repo, ask pi to edit a file. Expect: the edit tool call block shows a diff during execution (not raw JSON), the Allow/Deny buttons attach to that block, the buffer/split diff preview opens on the file (agentic `diff_preview`), and on completion the realized diff replaces the projection. Deny → preview clears, tool call shows failed. Reads show `read(<path>)`; greps show `search(<pattern>)` with results in the foldable body.

## Open questions
- Keep pi's UI title (e.g. `🔒 edit: hello.txt`) as the permission request title, or use a plain `edit: <path>`? Plan assumes keeping pi's title.
- If an extension `select` unrelated to the in-flight edit arrives while one is executing (pi serializes UI requests, so this should not happen), it would be attributed to the edit. Acceptable; confirm during testing.
- Title truncation for very long paths/patterns: keep titles short (path/pattern only, no flags); agentic already truncates long headers.