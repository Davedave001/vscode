# Signal-C Assistant — Agent Capabilities

The Assistant view (`Assistant` in the Sessions sidebar, `OPEN_ASSISTANT_ACTION_ID`) is a conversational
agent backed by the user's REACH Subscription. Inference, account identity, subscription entitlement,
model catalog, and request allowance all stay on the existing SignalREACH path — the agent loop only
extends *what* a single prompt can accomplish.

Inspired by Town's assistant (town.com), the following agent capabilities are implemented on Signal-C
substrate:

## Multi-turn threads

- One root conversation per verified REACH account, plus linked **task** conversations
  (New task button, `/task <description>`, or a task row click).
- Turns are persisted per account (`AssistantConversationStore`), including per-thread model choice,
  draft text, permission mode, and always-allowed tools.
- Task rows can be pinned, renamed, and deleted (with confirmation); running tasks show live status
  and a one-line completion update on the parent thread. Tasks interrupted by a restart show a
  resume button that replays their last prompt. When a background task finishes (or fails) while
  you're on another thread, a status-line nudge announces it so completed work isn't missed.
- Turns carry timestamps (relative display, exact time on hover) and record their run
  duration, shown in the turn meta as "worked 12s" (minutes/hours when longer). Sending
  while a run is in flight
  queues the message — several can stack (position is announced); they send FIFO as each reply
  finishes. The "Queued: …" preview shows the head message plus a "(+N more)" count with edit
  (pull head into composer) and remove actions. Stop or Escape clears the queue and cancels the run.
- The pending card shows the live status with elapsed seconds ("Working (step 2)… · 12s"), streamed
  reply text, and per-tool activity chips (kind icon, label, colored status icon). Completed
  calls ≥1s show an inline duration ("2m 5s" via the same formatter as turn duration), and every
  chip's tooltip carries `label — status · duration`; durations persist on saved turns.
- A completed reply plays `AccessibilitySignal.chatResponseReceived` (stopped and failed
  runs don't), honoring the user's `accessibility.signals.chatResponseReceived`
  sound/announcement setting. A new approval request plays
  `chatUserActionRequired` (deduped per request id — re-renders don't re-signal), and a
  background task ending on a non-open thread plays `taskCompleted` or `taskFailed`
  alongside its status-line nudge.

## Tool calling

Each model request can both reply and request tool calls; `AssistantRuns` loops up to 6 steps,
executing calls and feeding results back until the model produces a final answer.

- **Native function calling**: when the selected REACH model supports `tools`, the catalog is sent as
  OpenAI `tools` specs and `tool_calls` replies are executed directly (echoed back as
  `assistant` + `tool` messages).
- **Text fallback**: every model also sees a fenced-block protocol in the system prompt —
  ```` ```tool_call {"name": "...", "arguments": {...}} ```` — so models without native function
  calling can still use tools. Tool-result blocks are delivered as `<tool_result>` user messages.
- **Loop guards**: max 6 model steps, max 4 calls per step, same-call-signature breaker, and a final
  "summarize without tools" step if the budget is exhausted.

### Tool sources

- **MCP connections**: every enabled `IMcpService` server contributes its model-visible tools
  (`McpToolVisibility.Model`), namespaced by `tool.id` and labeled `Server · Tool`. MCP annotations
  classify safety: `readOnlyHint && !destructiveHint` counts as a read-only action. Each enabled
  server's `serverInstructions` (capped at 2k chars) is injected into the system prompt under
  "Guidance published by connected tools", so app-provided usage hints reach the model.
- **Built-ins** (all workspace access is confined to workspace folders):
  - `assistant.get_current_time` — clock/time-zone.
  - `assistant.ask_user` — pause the run and ask a clarifying question (optional answer
    choices); feeds the answer back as a tool result. Refused inside background tasks.
  - `assistant.update_plan` — post a live checklist (≤8 steps, pending / inProgress /
    done) rendered in the pending card while the run executes, for multi-step work.
    The final plan persists on the completed turn, shown as a collapsed
    "Plan — N/M done" details block, and survives conversation reloads.
  - `assistant.remember` — long-term per-account memory.
  - `assistant.list_tasks` / `assistant.read_task` — list linked tasks and read a task's
    status + latest reply, so the parent thread can orchestrate background work.
  - `assistant.create_task` — start a linked task conversation in the background
    (side-effect: asks in Auto mode).
  - `assistant.rename_task` / `assistant.report_progress` — a running task can retitle itself
    and post one-line progress updates the user sees in the task list.
  - `assistant.list_files`, `assistant.read_file`, `assistant.find_files`,
    `assistant.search_files` — read-only workspace access via `IFileService`/`ISearchService`
    across every workspace folder (multi-root paths use `folderName/path` form).
  - `assistant.write_file`, `assistant.edit_file` — create/overwrite or exact-span replace in
    workspace files (side-effect: asks in Auto mode, refused in Safe-only). Results report
    change stats — "Wrote path: N lines, M characters" / "Edited path: +N −M lines" — which
    also surface on the activity chip's detail line.
  - `assistant.web_fetch` — read-only page fetch via `IRequestService`.
  - `assistant.open_url` — open an http(s) URL in the user's default browser via
    `IOpenerService` (side-effect: asks in Auto mode).
  - `assistant.open_file` — reveal a workspace file in the editor via `IOpenerService`;
    same workspace confinement as the other file tools (side-effect: asks in Auto).
    Optional `line`/`column` args jump to a position (`withSelection` URI fragment).
- The catalog is capped at 32 entries per request; tool results are truncated at 6 000 chars and
  each call times out after 60 s.

## Approvals and permission modes

Per-thread permission mode (shield button):

| Mode | Read-only tools | Side-effect tools |
|---|---|---|
| Auto (default) | run immediately | inline approval card — Allow once / Always allow / Reject / Reject with note… |
| Safe only | run immediately | auto-declined |
| Allow all | run immediately | run immediately |

- "Always allow" records the tool in the thread's `allowedTools` list and skips future prompts;
  the permission picker's "Allowed tools…" lists every side-effect tool in the
  catalog (MCP-tagged) with checkboxes — check to pre-authorize, uncheck to revoke.
- MCP calls also offer **"Always allow {App} tools"** — merges all of that server's
  model-visible tools into `allowedTools` at once (Codex's "trust app"), then allows
  the pending call. Revocable through the same "Allowed tools…" picker or the tile's
  **Trust all tools / Require approval again** toggle in its context menu.
- Every call is rendered as an activity chip under the pending run and on the completed turn
  (pending → awaitingApproval → running → done / rejected / failed).
- Stop cancels the in-flight request *and* any waiting approval; pending approval requests
  survive thread switches (`getPendingApproval` restores the card).

## Connected apps

A tile strip above the thread lists every MCP server (`IMcpService.servers`) with its icon,
tool count and live state (Connected / Connecting / Needs sign-in / Failed / Disabled).
Clicking a tile opens the server's options (`McpCommandIds.ServerOptions`); a trailing
"Connect app" tile opens the app catalog (`McpCommandIds.ConnectApp`). Right-clicking a
tile opens a context menu with Options…, Start/Stop (state-dependent), Restart, Show
Output, and Connect app, plus content actions scoped to that server: **Use prompt…**
(enabled when the server publishes prompts), **Attach resource…**, and **List tools…**
(safety-badged), and **Pin app**/**Unpin app**. Pinned servers float to the front of the
strip (then state rank within the group) and show a pin glyph next to the name; pins
persist in profile storage (`sessions.assistant.pinnedServers`) across sessions and
accounts. The strip updates live as servers start, stop, or are enabled.

## Memory

- `assistant.remember` lets the model persist one-line facts to per-account `instructions`,
  injected into the system prompt of every request.
- `/memory` shows saved memory; `/forget` clears it.

## Attachments and commands

- `/attach <path> [path2 …]` inserts workspace files into the composer as
  `<file path="…">…</file>` blocks (each truncated at 12 000 chars; confined to workspace
  folders). `/attach` alone opens a multi-select workspace file picker (`ISearchService`
  file query, multi-root aware — pick entries are prefixed `rootName/` when more than one
  folder is open).
- Composer attachments (drag-and-drop or the attach control) are accepted on send:
  `URI`-valued entries are read through `IFileService` under the same workspace-folder
  confinement and 12k-char truncation as `/attach` and wrapped in `<file>` blocks;
  string-valued entries (e.g. pasted text) are wrapped in `<attachment>` blocks; other
  kinds (images, tool entries) are skipped and reported. Consumed attachments are
  cleared from the composer; if nothing readable was attached the send aborts with a
  hint to paste the text instead. Sent turns render `<file>`/`<attachment>`/`<resource>`
  blocks as labeled chips (icon + basename, full name on hover) above the message text
  instead of raw markup; "Edit prompt in composer" still replays the full block text so
  attachments stay editable.
- `/task <description>` creates and opens a linked task conversation; `/tasks` opens a
  picker of saved tasks (status, title, latest update) to jump between threads.
  Untitled tasks take their title from the first prompt sent (the model can refine it
  via `assistant.rename_task`).
- `/connect` opens the app catalog (`McpCommandIds.ConnectApp`) — same as the "Connect
  app" tile.
- `/prompts` lists prompt templates published by connected apps (`IMcpServer.prompts`),
  asks for any declared arguments, resolves the template, and drops the result into the
  composer for review before sending.
- `/resources` lists readable content published by connected apps
  (`IMcpServer.resources()`), multi-selects entries, reads them through `IFileService`
  (32KB cap, 12k-char truncation each), and wraps them as `<resource>` blocks in the
  composer — the app-content equivalent of `/attach`.
- `/model` opens the REACH model picker; the active choice is check-marked and
  pre-focused (Auto included), and tool-less models carry a "no tool use" tag. Models
  advertise tool-call support when the
  REACH catalog reports `allow_tools: true`; that flag is also what decides whether the
  request sends native `tools`/`tool_choice` or falls back to the fenced text protocol.
- The approval card shows a collapsible Arguments block (auto-expanded under 200
  chars), so long tool payloads don't flood the card.
- "Reject with note…" asks for an optional reason which is relayed to the model as
  `Reason: <note>` in the tool result and shown on the declined activity chip — the
  run continues with the guidance instead of stopping.
- After a failed run a "What went wrong?" follow-up chip offers to diagnose the
  failure instead of retrying blindly.
- `/tools` lists the current tool catalog with safety hints; `/clear` resets the thread.
- `/forget` opens a picker to keep or remove individual memory lines.
- Failure status lines carry an inline "Retry" action link that resends the failed
  prompt — `/retry` remains the keyboard path. The feedback line supports action
  links generally (message + link).
- `/search <text>` filters the transcript to turns whose prompt or reply contains the
  text (case-insensitive, attachment block contents included); the status line reports
  the match count and `/search` alone clears the filter. `/export` copies the
  transcript as Markdown; `/copy` puts the latest reply on the clipboard;
  `/retry` resends the failed prompt;
  `/regenerate` drops the last turn and replays its prompt; `/undo` drops the last turn
  and restores its prompt to the composer for review without resending; `/context`
  reports how much history the next request carries (turns kept vs total, chars vs the
  60 000-char cap); `/compact` asks the model for a
  summary of the thread so far, then collapses all turns into that single summary turn —
  bounding future context size on long conversations; `/stop` cancels the run (same as
  Escape); `/help` opens a command picker that fills the composer.
- Replies render as streaming markdown while they arrive; each turn offers Copy reply, Copy
  prompt, Edit prompt in composer, **Regenerate from here**, and Quote actions. Regenerate
  truncates the thread at that turn and resends its prompt; editing an earlier prompt shows a
  banner — sending replaces that turn and every turn after it (a conversation branch);
  "Cancel edit" restores normal append.
- Suggested follow-up chips appear under the last reply based on which tools ran
  (file edits → "Summarize the changes", task creation → "Check on my tasks", searches →
  "Find related files").

## Suggestions

The empty home thread shows server-aware suggestion chips (e.g. email summary when a mail MCP
server is connected) plus a "What can you do?" discovery prompt. Servers that publish
prompts also get a "{Server} prompts…" chip that opens the server-scoped template picker.

## Protocol

`ReachAssistantRequest` = `{ messages, modelId?, tools?, isTask? }` where messages may be
`system | user | assistant | tool` and assistant messages may carry `toolCalls`
(`{id, name, arguments}`). `ReachAssistantResponse.reply` may carry parsed `toolCalls`.
The account/subscription/allowance gate in `requestReachAssistant` is unchanged; busy protection
is keyed per `[accountId, conversationId]` and stop aborts by request id per window.

Replies stream (`stream: true` upstream): SSE deltas travel main → renderer through
`INativeHostService.onDidReceiveReachAssistantChunk` (keyed by request id), accumulate in
`IAssistantPendingRun.partial`, and render as live text in the pending card. Streamed
`tool_calls` fragments are reassembled by index. Backends that ignore `stream` fall back
to the normal JSON path automatically (the stream parser only runs on `text/event-stream`
responses).

Not ported from Town: voice, images, @-mentions, the document detail panel, routines
(a different runtime), code sandbox, and shared/team threads.
