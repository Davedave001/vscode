# Signal-C — Signal-Connections

Signal-C is this fork's product name. Signal-Connections is the expanded name. Product identity is configured in `product.json`; the CLI and URL scheme are `signal-c`. Packaged application storage uses `.signal-c`, `.signal-c-shared`, and `.signal-c-server`. Windows installers have separate application IDs, mutexes, registry names, and an application user model ID. macOS and Linux also have distinct product identifiers. Debian package installation and removal do not manage Microsoft's apt repository or signing key for Signal-C.

## Artwork and theme behavior

The artwork is the existing transparent SimpleRAG icon, copied from `D:/PyMu/work_on_rag-main/assets/branding/simple-rag/simplerag-icon-master.png` into `resources/branding/simple-rag-icon.png`. The original image remains unchanged. `scripts/generate-signal-c-brand.mts` renders that artwork into transparent in-app assets and blue desktop, web, and installer icons. Run it with `node scripts/generate-signal-c-brand.mts` using the existing Playwright installation and Edge browser. It preserves the existing installer bitmap dimensions and generates Windows ICO, macOS ICNS, Linux PNG, and browser icon assets.

In-app logo plates use `var(--vscode-focusBorder, #007acc)`, so changing a theme or `workbench.colorCustomizations.focusBorder` updates the logo background through CSS. The artwork retains its original colors. Aquarium logos have alpha transparency and no plate; all species use the same icon while swimming, turning, feeding, and growth keep their existing behavior. The image is shared per document by the existing SVG strip renderer.

Desktop shortcuts, installer graphics, and installed web app icons use the default blue `#007acc`. These assets are loaded by the operating system or browser outside the themed workbench, so editor theme changes do not recolor them.

## Development and existing data

Launch with `node scripts/code-agent-workspace.ts`. The launcher prefers `.build/electron/Signal-C.exe`; it also supports an existing `.build/electron/Code - OSS.exe` runtime until native preparation is repeated. It retains the established isolated `.build/agent-workspace-*` paths so existing development sessions, provider sign-ins, drafts, and preferences remain available. It does not migrate, rename, or delete installed editor profiles. Packaged builds use Signal-C's own product storage defaults.

For a per-user Start menu entry, run `./scripts/install-signal-c-shortcut.ps1` in PowerShell. Search Start for **Signal-C (Development)**. The shortcut uses the blue Signal-C icon and a generated `.build/signal-c-shortcut.vbs` helper to start the existing Node launcher without a console window. It retains all launcher environment isolation and existing development-profile paths. The helper is stored as Unicode so paths with non-ASCII characters are preserved. Repeating the command updates this checkout's shortcut; an unrelated shortcut or helper with the same name is preserved and reported as a conflict. Rerun it if the checkout or Node installation moves. Delete the Start menu entry to remove it; no installed application is replaced.

The shortcut was created in the current user's Programs folder, read back through Windows Script Host to verify its target, working directory, and icon, and used to open the development Agents window. Repeating installation succeeded. PowerShell syntax parsing passed. The `.lnk` and generated helper are local runtime artifacts and are not committed.

Upstream copyright and license notices, extension IDs, `vscode` API imports, compatibility protocols, and the names of third-party providers remain their actual identities. No repository rename, public release, or installed application replacement is performed by this source branding change.

## Validation

The client build, source type check, layer import and environment checks, targeted TypeScript lint, and CSS lint passed. The asset generator also passed its own strict TypeScript check and ran successfully. The CSS checker reported existing design-token suggestions in the large titlebar and mobile stylesheets, with no lint errors. Four launcher tests passed. The current worktree's 136 focused browser tests passed, including aquarium behavior, feeding streaks, session navigation, accessibility, and the pending Session Overview increment. Debian installation/removal templates passed Bash syntax checks; neither installer script was executed against system paths.

A separate headless browser check imported the actual compiled `Fish` class, rendered eight logos through 64 SVG strips, decoded the shared 512px image, verified alpha zero at its transparent corner, and reported no page errors. It verified the in-app logo background changing from blue to green by updating the theme's `focusBorder` variable. Captures are `.build/signal-c-blue.png` and `.build/signal-c-green.png`; they are component previews, not screenshots of an installed native package. PNG, ICO, ICNS, and BMP assets were opened successfully by an independent image reader. SWE-2 reviewed the supplied branding source through the official Devin CLI; findings were checked against the actual development launch contract and rendered assets.

No Windows installer, signed Appx, macOS package, Linux package, or hosted provider request was run for this change. Appx packaging requires a signing certificate matching the Signal-C publisher identity. The running development editor has not been restarted.

Manual check: launch the isolated fork, open the aquarium, and change **Workbench: Color Customizations → `focusBorder`**. Confirm the app's logo plate follows the new accent while the swimming SimpleRAG logos retain transparent backgrounds.
