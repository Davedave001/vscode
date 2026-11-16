# Agents and IDE mode switch

The title bar now offers a persistent, labelled Agents / IDE switch. Agents highlights the orchestration view; IDE highlights the code editor. The switch uses the existing workspace-aware actions, so folder, remote-host, chat-session, and draft handoff rules remain owned by the existing implementation.

In the Agents Window the control appears at the start of the title bar, before sidebar navigation. The native IDE's existing return-to-Agents title-bar action uses the same control. The setting `workbench.titleBar.workspaceModeSwitch` defaults to true; setting it to false and reloading restores the existing icon-style controls.

The control exposes a single keyboard focus target and a switch role with IDE mode on/off state. Click, Enter, and Space activate the existing action. Disabled actions remain disabled and cannot execute. Theme colors, spacing, radii, and focus outlines use existing tokens. The Agents accessibility help documents the control.

## Browser preview

Start the existing server with `--workspace-preview` to enable the development preview shell:

```powershell
node scripts/code-sessions-web.js --mock --workspace-preview --skip-welcome --no-open --host 127.0.0.1 --port 8096
```

The ordinary server and E2E routes retain their existing behavior when this flag is absent. With the flag enabled, Agents and the real web IDE run in separate same-origin frames. The IDE loads lazily, and switching only hides or reveals the frames, preserving their in-page conversations and unsaved buffers. Reloading or closing the browser page still follows the underlying workbenches' persistence behavior.

The Agents title-bar action invokes the preview host instead of an installed editor protocol. The IDE provides a return control at the top-left. Host messages are accepted only from the known workbench frames and the exact local origin. The mock Sessions factory now honors and disposes embedder command registrations, matching the production factory's command contract.

This is a local demo. The web IDE initially opens without a local folder; it does not establish access to an agent's desktop filesystem. Native workspace handoff uses the existing desktop action, independently of the preview shell.

## Verification

- Client build and native TypeScript source check passed.
- Targeted lint, CSS lint, and import-layer checks passed.
- 81 focused browser tests passed, including mode state, toolbar focus, mouse/Enter/Space activation, disabled-action behavior, existing web workspace routing, and accessibility help.
- The refreshed browser preview was observed rendering the actual IDE workbench, including Explorer, editor tabs, layout controls, and the return switch. A full interactive return-and-buffer-preservation workflow has not yet been verified.
- Native Electron test invocation did not produce a usable completion report and was stopped. It is not counted as a pass. Desktop native dependencies are being prepared separately; browser evidence does not establish a packaged native build.

Manual smoke test: in the local demo, click IDE, create an untitled buffer, return to Agents, and switch to IDE again. Confirm the same buffer remains and that Agents returns to its previous conversation.
