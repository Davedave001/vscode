# Agents and IDE mode switch

The title bar now offers a persistent, labelled Agents / IDE switch. Agents highlights the orchestration view; IDE highlights the code editor. The switch uses the existing workspace-aware actions, so folder, remote-host, chat-session, and draft handoff rules remain owned by the existing implementation.

In the Agents Window the control appears at the start of the title bar, before sidebar navigation. The native IDE's existing return-to-Agents title-bar action uses the same control. The setting `workbench.titleBar.workspaceModeSwitch` defaults to true; setting it to false and reloading restores the existing icon-style controls.

The control exposes a single keyboard focus target and a switch role with IDE mode on/off state. Click, Enter, and Space activate the existing action. Disabled actions remain disabled and cannot execute. Theme colors, spacing, radii, and focus outlines use existing tokens. The Agents accessibility help documents the control.

Press Ctrl+K followed by Ctrl+Shift+A to switch modes on Windows or Linux; on macOS use Cmd+K followed by Cmd+Shift+A. The shortcut invokes the existing session-workspace action from Agents and the existing current-workspace action from the native IDE. Existing Ctrl+Shift+A commands remain unchanged. The Agents command is also discoverable as Open in Editor in the command palette. Its default shortcut is inactive on phone layouts, while the welcome overlay is visible, and outside Agents windows. The tooltip and accessible description follow later shortcut remapping or removal. The browser preview IDE registers the same chord and a Switch to Agents command-palette entry for its embedder command.

## Browser preview

Start the existing server with `--workspace-preview` to enable the development preview shell:

```powershell
node scripts/code-sessions-web.js --mock --workspace-preview --skip-welcome --no-open --host 127.0.0.1 --port 8096
```

The ordinary server and E2E routes retain their existing behavior when this flag is absent. With the flag enabled, Agents and the real web IDE run in separate same-origin frames. The IDE loads lazily, and switching only hides or reveals the frames, preserving their in-page conversations and unsaved buffers. Reloading or closing the browser page still follows the underlying workbenches' persistence behavior.

The Agents title-bar action invokes the preview host instead of an installed editor protocol. The IDE provides a return control at the top-left. Host messages are accepted only from the known workbench frames and the exact local origin. The mock Sessions factory now honors and disposes embedder command registrations, matching the production factory's command contract.

With both `--mock` and `--workspace-preview`, the two workbenches register the same browser-backed `mock-fs://mock-repo/mock-repo` sample workspace before workspace services initialize. The four sample files are seeded once in an IndexedDB transaction. Saved edits survive reopening; intentionally deleted files are not recreated. Cross-window file notifications invalidate the receiving provider's cached directory metadata, so later directory and file-size queries see committed peer changes. The ordinary mock E2E entry keeps its existing in-memory provider.

This is a local demo and does not establish access to an agent's desktop filesystem. The IDE opens the shared sample folder. The existing Agents mock picker selects a GitHub-shaped Cloud session workspace; the preview registers a read-only repository view that maps precisely that sample repository to the same saved files, without calling GitHub for its file contents. Other repository paths, authorities, and queries cannot use this mapping. Normal Agents windows continue to register the existing GitHub API filesystem when no embedder provider exists. Native workspace handoff uses the existing desktop action, independently of the preview shell.

## Verification

- Client build, source type check with the native TypeScript compiler, targeted lint, CSS lint, and import-layer checks passed.
- 85 focused browser tests passed for the mode switch, web workspace routing, and accessibility help. These include three-platform chord resolution, desktop/welcome/auxiliary-window restrictions, remapping/removal descriptions, mouse/Enter/Space activation, focus, and disabled-action behavior.
- The browser preview was observed rendering the actual IDE workbench with the shared sample workspace. The Agents Files panel was also visually verified listing src, package.json, and README.md without the prior fake-credentials error.
- In the isolated preview on port 8098, the keyboard chord changed the host URL to IDE mode and revealed the return switch. Computer Use then stopped because its URL safety check could not confidently determine the current browser URL. A complete UI edit/save/return/reload workflow remains unverified.
- Native Electron test invocation did not produce a usable completion report and was stopped. It is not counted as a pass. Browser evidence does not establish a packaged native build.
- 33 focused filesystem browser tests passed, including the existing GitHub filesystem suite and checks for cross-provider create/edit/delete cache invalidation, saved-edit persistence across reopening, avoiding reseeding deleted samples, the sample-only read-only repository mapping, and file creation notifications from IDE to Agents. New IndexedDB files emit ADDED rather than UPDATED, allowing Explorer to refresh for creation.

## Native build prerequisite

The pinned Node 24.22.1 archive was downloaded from nodejs.org, verified against its published SHA-256 manifest, and kept inside `.build/node-runtime`. Repository preinstall successfully prepared Node and Electron 43.8.9 headers. Native rebuilding then reached Visual Studio but failed with `MSB8040`: the selected compiler lacks Spectre-mitigated C++ libraries. The installed VS 2026 and VS 2022 toolsets were checked and neither had the required x64 libraries. The browser preview remains usable; completing the native build requires the matching Visual Studio Spectre component. No compiler mitigation was disabled and no global toolchain configuration was changed.

Manual smoke test: in the local demo, click IDE, create an untitled buffer, return to Agents, and switch to IDE again. Confirm the same buffer remains and that Agents returns to its previous conversation.
