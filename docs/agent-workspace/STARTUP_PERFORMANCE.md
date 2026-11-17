# Signal-C desktop startup

The Start menu development entry launches the unbundled source tree. On this Windows machine, loading its workbench modules took approximately four seconds before the workbench could start. The optimized desktop build combines and minifies those modules, packages built-in extensions and native dependencies, and enables the normal production renderer code-cache path.

## Opening the optimized build

Run `node scripts/code-agent-workspace.ts --optimized`, or install its Start menu entry with `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-signal-c-shortcut.ps1 -Optimized`. The new entry is **Signal-C**. **Signal-C (Development)** remains available for source development.

Close existing Signal-C windows before switching launchers: the editor's single-instance handoff otherwise reuses the already-running process. The optimized launcher retains the existing isolated user-data, shared-data, extension, Codex and Claude paths. It does not reset settings, migrate accounts or copy credentials. The saved account and tool configuration still belong to their existing services.

The optimized build is a snapshot. Source changes require rebuilding it; reloading a packaged window does not recompile the checkout. The launcher reports a missing packaged runtime rather than silently falling back to source mode.

## Building

Use the repository's `vscode-win32-x64-min` gulp task for the x64 desktop build. Its output is `../VSCode-win32-x64/Signal-C.exe`. The Windows SDK's x64 `signtool.exe` must be on the build process's PATH for the native resource-patching stage. If compilation already completed, `vscode-win32-x64-min-ci` reruns packaging using the existing bundles.

Local packages have no published agent SDK catalog. The optimized checkout launcher supplies the existing explicit SDK-root overrides only when the corresponding Codex or Claude SDK is installed in this checkout. This retains native providers without changing their account homes or starting a download. The packaged app remains dependent on that checkout for these local SDK overrides; this is not a standalone published installer.

Windows packaging excludes node-pty's macOS and Linux prebuilds. They cannot be loaded on Windows and caused `rcedit` to fail on an ELF addon. Windows prebuilds remain packaged. The resulting x64 terminal addon was verified by spawning PowerShell without a profile and checking a completed sentinel command.

## Measurements

On November 17, 2026, a native Playwright fixture launched three separate processes per variant, each variant using its own fresh portable profile and reusing it for its later launches. The workspace was a small throwaway folder. Both variants enabled Codex and disabled Claude, automatic updates and built-in GitHub MCP; all windows remained hidden. No real account was copied or model request submitted. These are local fixture measurements, not guarantees for every workspace, extension set or cold disk cache.

| Checkpoint, median of three launches | Development | Optimized | Reduction |
| --- | ---: | ---: | ---: |
| Mode switch visible | 6.12 s | 1.79 s | 71% |
| Command palette opened and found Connect App | 7.46 s | 2.57 s | 66% |
| Startup contributions settled | 13.30 s | 8.70 s | 35% |

The command-palette checkpoint exercises a real keyboard shortcut and typed search before waiting for background contributions. The last checkpoint uses the smoke driver's `whenWorkbenchRestored`; it includes deferred startup work and does not mean the UI was blocked until then. The initial investigation also retained earlier exploratory runs, including a corrected benchmark assertion about Electron's `app.isPackaged`; development mode is verified through `VSCODE_DEV` and the actual app root instead.

Raw local reports:

- `.build/signal-c-startup/baseline-current-2026-11-17T17-51-06-027Z/summary.json`
- `.build/signal-c-startup/optimized-current-2026-11-17T17-52-17-449Z/summary.json`

The packaged runtime registered both Devin Subscription and Codex in all three optimized launches. This establishes provider registration, not account authorization or a completed model turn.

## Functional verification

Run `node scripts/test-agent-workspace-native.mts --optimized --empty-workspace --keyboard --app-connections`. The packaged runtime passed this check with fresh portable storage: two Agents/IDE round trips retained the editor window, unsaved buffer and Agents draft; four actual keyboard activations dispatched their mode commands; the app picker and MCP page header worked; QuickBooks requirements and Gmail OAuth registration requirements appeared; cancellation returned focus and left MCP configuration unchanged. No model request occurred.

The local report is `.build/agent-workspace-native-smoke/2026-11-17T17-53-24-879Z-62068/report.json`. Launcher tests, targeted lint, strict native-runner type checking and the completed Windows packaging task provide separate source and package evidence.
