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
- `Sessions: Session Tools` is available from the Command Palette and the session toolbar. It searches enabled actions from the native Session Activity Bar menu, including nested canvas actions. The picker uses its originating host's context keys and forwards the existing host command context to the selected native action. Moving focus elsewhere does not retarget it. Before execution it verifies that the original host still exists and shows the same session/chat resource identities, then checks tool availability again. Changed or closed targets prompt the user to reopen the picker; policy and command errors keep their existing handling. A provider may replace its session/chat objects without invalidating an unchanged resource identity.
- Both actions reuse the native Quick Input control for keyboard navigation and screen-reader support. The Agents Window accessibility help describes them.

This increment adds navigation and discoverability. It does not introduce an agent backend or connect to Devin's hosted service. Existing provider integration remains upstream functionality; no paid provider calls are needed to inspect the new commands.

## Session Overview

`Sessions: Session Overview` opens a compact auxiliary panel from the sessions toolbar or Command Palette in the main Agents window on desktop layouts. It follows that window's selected chat and shows its title, parent session, reported status and activity, workspace, known changed-file count, and session attention counts. Native buttons open the chat, the host-bound Session Tools picker, and the Attention Queue. The panel uses the existing resizable side-panel layout and scrolls when its content exceeds the available height.

The overview reads provider observables without opening an agent runtime, fetching changes, or changing read state. A file count of zero appears only after an enabled default changeset has a usable file list; its label states the count's scope. Unknown counts are omitted. Completed remains a chat status and is not a verification claim. Hidden internal chats do not appear, and attention rows exclude archived and hidden chats without reintroducing those known alerts as aggregate fallback rows. Aggregate alerts whose matching metadata has not arrived retain a session-level row.

The panel has keyboard navigation, an accessibility help dialog, a plain-text accessible view, and `accessibility.verbosity.sessionOverview`. Accessibility commands obtain content from the visible view rather than requesting a chat host from root services. Focus state stays scoped to the view, and closing accessible content restores the original control or the open overview if that control has disappeared. Stable DOM controls retain keyboard focus while provider data updates.

## Verification

See `VALIDATION.md` for checks actually run, limitations, and the manual workflow. A source change or passing type check does not establish a packaged desktop build or a live provider run.
