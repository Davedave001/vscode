# First agent workspace increment: validation

Base: upstream `598b0f1b4e1`. Development branch: `feat/agent-workspace`.

## Chat-specific attention queue update

The queue now reads each session's chat membership and chat statuses, so blocked or failed child chats remain visible even when their parent is completed. It opens the selected chat with its own workspace context, retains session-level alerts when chat metadata has not arrived, and counts working sessions once. Accept-time checks use current resource identities and membership, including providers that replace chat objects or reuse the session URI for a legacy main chat. Showing or cancelling the picker does not clear read state or notify the draft composer of navigation.

Ninety focused browser tests passed for `sessionAttentionQueue`, `sessionWorkspaceActions`, `sessionsPicker`, and `sessionsChatAccessibilityHelp`. The checks cover per-chat reactivity and ordering, archive/draft exclusion, aggregate fallback, live title/workspace changes, exact chat navigation, replacement objects, stale selections, legacy identity collisions, and cancellation. Source type checking, targeted lint, and incremental client compilation passed. These tests use controlled provider and navigation services. The updated queue has not been inspected in the native window because desktop automation remains stopped. The sections below preserve the first increment's historical build evidence; current native-build and layer-check status is also documented in `NATIVE_BUILD.md` and `MODE_SWITCH.md`.

## Checks run

| Check | Result |
| --- | --- |
| TypeScript native compiler, `src/tsconfig.json`, no emit, skip library checks | Passed with no diagnostics |
| Additional JavaScript TypeScript 6 compiler check | Incomplete: process reached the default Node heap limit |
| `node build/next/build-fast.ts --client-only` | Passed, including an incremental rebuild after the final source edits |
| Targeted `node build/oxlint.ts` on changed TypeScript files | Passed |
| `node build/checker/layersChecker.ts` | Passed |
| `node build/checker/layersTypeCheck.ts` | Could not pass: Electron environment targets lack `electron` and `original-fs` declarations in this installation |
| Browser unit tests in Chromium using the installed Edge channel | 76 passed |
| `git diff --check` | Passed |

The browser test command was:

```powershell
node test/unit/browser/index.js --browser chromium-msedge --runGlob '**/{sessionAttentionQueue,sessionWorkspaceActions,sessionsPicker,sessionsChatAccessibilityHelp}.test.js' --reporter spec
```

The tests cover attention classification, archived/draft exclusion, provider-state transitions, preserving source order, native enabled tool selection, availability changes between selection and execution, existing session-picker behavior, and existing accessibility help. The action tests use controlled service implementations; they do not prove a live provider connection or the final desktop layout.

## Build environment and limits

Dependencies were installed with the pinned pnpm 12.16.0 using `--ignore-scripts --frozen-lockfile` at the repository root and in `build/`. This prepares compilation and browser unit testing; native Electron dependencies and the desktop application have not been built or packaged. The current shell uses Node 24.20.0, while `.nvmrc` requests 24.22.1 or newer in the same major series for a full supported build. The local pnpm launcher needed its actual installed JavaScript entry point because its global shim failed; no global tool or application configuration was changed.

The stricter environment-specific layer type check reported missing Electron declarations and resulting errors in upstream Electron sources. It reported no diagnostics in the changed files. The general source type check, layer import checker, client build, and focused browser tests passed; this does not establish a complete desktop build.

The new commands have not been inspected in a running fork. No installed application was replaced. No provider request or hosted Devin service integration was exercised. Devin's open Agents view was inspected as the reference; the initial Antigravity window did not expose a usable screen during inspection.

## Manual smoke test after native build prerequisites are ready

Launch an isolated development profile, then use the Command Palette to open `Sessions: Attention Queue` and `Sessions: Session Tools`. Verify waiting and failed sessions appear in separate groups, title/workspace search works, Escape returns focus, and selecting Files opens the active session's native file view. Use actual provider-reported statuses rather than manually changing persisted session data.

```powershell
.\scripts\code.bat --agents --user-data-dir .build/agent-workspace-profile
```

This command can trigger upstream prelaunch preparation; it was not run during this increment.
