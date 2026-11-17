# Agent workspace direction

## Reference and scope

The reference is the installed Devin desktop Agents view inspected on November 16, 2026 through its visible interface and accessibility tree. The source fork is Microsoft's MIT-licensed Code - OSS repository. No proprietary application code, assets, account data, or private service protocols are copied into this project.

The reference has a persistent session sidebar, a central conversation and composer, and a resizable tools area. Session rows show a title, provider, workspace context, activity state, and recency. The tools area offers Progress, Files, Browser, and additional tools. The composer exposes attachment, model, reasoning, and agent controls. These are observations of the open screen; behavior behind unopened controls has not been verified.

## Improvements for this fork

1. Prioritize decisions: separate sessions waiting for input from failed sessions instead of making the user scan a chronological list. Show running work as a count without mixing it into the attention queue.
2. Make tools searchable: offer the active session's existing tool and canvas actions in one keyboard-accessible picker. Read the native menu so provider capabilities and policy remain authoritative.
3. Keep navigation honest: opening the attention queue does not clear notifications or mark sessions read. Only opening a selected session uses the normal navigation path.
4. Preserve context: retain native session persistence, drafts, working sets, file changes, and provider routing. Reuse the upstream Agents Window rather than building another session store or editor shell.

## First implementation

- `Sessions: Attention Queue` is available from the Command Palette and the sessions sidebar toolbar. It groups live waiting and failed chats, including actionable child chats when their parent has completed. Rows show the chat's title and workspace with parent-session context, and search includes all three. The working count counts each session once, even when it also has a chat waiting for input. Archived sessions and unsent session/chat drafts are excluded. Aggregate alerts without matching chat metadata keep a session-level row. Selection resolves current session membership and chat identity again before opening that exact chat through native navigation; stale completed, removed, or archived selections do nothing. Showing or cancelling the queue does not mark sessions read or change composer navigation.
- `Sessions: Session Tools` is available from the Command Palette and the session toolbar. It searches enabled actions from the native Session Activity Bar, including nested canvas actions. Availability is checked again before execution.
- Both actions reuse the native Quick Input control for keyboard navigation and screen-reader support. The Agents Window accessibility help describes them.

This increment adds navigation and discoverability. It does not introduce an agent backend or connect to Devin's hosted service. Existing provider integration remains upstream functionality; no paid provider calls are needed to inspect the new commands.

## Next visual increment

Build a compact, session-scoped overview in the tools area: current task and last verified result, pending decisions, changed files, and tool shortcuts. Use one quiet surface with explicit status text and progressive disclosure. Keep conversation width adjustable and collapse tools on narrow windows. Reuse provider-reported state; never manufacture progress, verification results, costs, or elapsed time.

## Verification

See `VALIDATION.md` for checks actually run, limitations, and the manual workflow. A source change or passing type check does not establish a packaged desktop build or a live provider run.
