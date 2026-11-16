/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

const http = require('http');
const fs = require('fs');
const path = require('path');
const open = require('open');
const minimist = require('minimist');

const APP_ROOT = path.join(__dirname, '..');

async function main() {
	const args = minimist(process.argv.slice(2), {
		boolean: ['help', 'no-open', 'skip-welcome', 'mock', 'mobile', 'workspace-preview'],
		string: ['host', 'port'],
	});

	if (args.help) {
		console.log(
			'./scripts/code-sessions-web.sh [options]\n' +
			'  --host <host>   Host to bind to (default: localhost)\n' +
			'  --port <port>   Port to bind to (default: 8081)\n' +
			'  --no-open       Do not open browser automatically\n' +
			'  --skip-welcome  Skip the sessions welcome overlay\n' +
			'  --mock          Load mock extension for E2E testing\n' +
			'  --workspace-preview  Include the persistent Agents/IDE preview shell\n' +
			'  --mobile        Serve the mobile (phone) workbench entry point\n'
		);
		return;
	}

	const HOST = args['host'] ?? 'localhost';
	const PORT = parseInt(args['port'] ?? '8081', 10);

	const server = http.createServer((req, res) => {
		const url = new URL(req.url, `http://${HOST}:${PORT}`);

		// Serve the sessions workbench HTML at the root
		if (url.pathname === '/' || url.pathname === '/index.html') {
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end(args['workspace-preview'] ? getWorkspaceHTML() : getSessionsHTML(HOST, PORT, collectCssFiles(path.join(APP_ROOT, 'out'), ''), args['mock'], args['mobile'], false, false));
			return;
		}

		if (url.pathname === '/agents' || url.pathname === '/ide') {
			// Refresh the import map on each page load to include newly compiled stylesheets.
			const cssModules = collectCssFiles(path.join(APP_ROOT, 'out'), '');
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end(getSessionsHTML(HOST, PORT, cssModules, args['mock'], args['mobile'], url.pathname === '/ide', args['workspace-preview']));
			return;
		}

		// Serve static files from the repo root (out/, src/, node_modules/, etc.)
		const filePath = path.join(APP_ROOT, url.pathname);
		if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
			const ext = path.extname(filePath);
			const contentType = {
				'.js': 'application/javascript',
				'.mjs': 'application/javascript',
				'.css': 'text/css',
				'.html': 'text/html',
				'.json': 'application/json',
				'.svg': 'image/svg+xml',
				'.png': 'image/png',
				'.ttf': 'font/ttf',
				'.woff': 'font/woff',
				'.woff2': 'font/woff2',
			}[ext] || 'application/octet-stream';

			res.writeHead(200, {
				'Content-Type': contentType,
				'Access-Control-Allow-Origin': '*',
			});
			fs.createReadStream(filePath).pipe(res);
			return;
		}

		res.writeHead(404);
		res.end('Not found');
	});

	server.listen(PORT, HOST, () => {
		console.log(`\n  Sessions Web${args['mobile'] ? ' (mobile)' : ''} running at: http://${HOST}:${PORT}/\n`);
		if (!args['no-open'] && args.open !== false) {
			const query = args['skip-welcome'] ? '?skip-sessions-welcome' : '';
			open.default(`http://${HOST}:${PORT}/${query}`);
		}
	});

	process.on('SIGINT', () => { server.close(); process.exit(0); });
	process.on('SIGTERM', () => { server.close(); process.exit(0); });
}

function getSessionsHTML(host, port, cssModules, useMock, useMobile, useIDE, useModeSwitch) {
	const baseUrl = `http://${host}:${port}`;
	const fileRoot = `${baseUrl}/out`;

	// Build the import map server-side. Each CSS file gets mapped to a
	// data: URI containing a JS module that injects the stylesheet via
	// a global helper function. This must be a static <script type="importmap">
	// declared before any <script type="module"> tags.
	const imports = {};
	for (const cssModule of cssModules) {
		const cssUrl = `${fileRoot}/${cssModule}`;
		const jsSrc = `globalThis._VSCODE_CSS_LOAD('${cssUrl}');\n`;
		const encoded = Buffer.from(jsSrc).toString('base64');
		imports[cssUrl] = `data:application/javascript;base64,${encoded}`;
	}
	const importMapJson = JSON.stringify({ imports }, null, 2);

	// When --mock is passed, load the E2E mock extension
	const additionalBuiltinExtensions = useMock
		? `additionalBuiltinExtensions: [{ scheme: 'http', authority: '${host}:${port}', path: '/src/vs/sessions/test/e2e/extensions/sessions-e2e-mock' }],`
		: '';

	// The mobile entry point is a separate, allow-listed bundle with its own
	// workbench. The mock variant swaps in the same mock services as desktop.
	const entryModule = useMobile
		? (useMock ? 'test/agents.web.mobile.test.internal' : 'agents.web.mobile.main.internal')
		: (useMock ? 'test/sessions.web.test.internal' : 'sessions.web.main.internal');
	const sharedPreview = useModeSwitch && useMock && !useMobile;
	const entryPath = sharedPreview
		? `sessions/test/preview/${useIDE ? 'ide' : 'agents'}.web.preview.internal`
		: useIDE ? 'workbench/workbench.web.main.internal' : `sessions/${entryModule}`;

	// Expose safe-area insets without disabling browser zoom.
	const viewportMeta = useMobile
		? `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
	<meta name="apple-mobile-web-app-capable" content="yes" />
	<meta name="mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />`
		: `<meta name="viewport" content="width=device-width, initial-scale=1" />`;

	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8" />
	${viewportMeta}
	<title>${useMobile ? 'Agents' : 'Sessions'}</title>
	<style id="vscode-css-modules"></style>
	<script>
		globalThis._VSCODE_FILE_ROOT = '${fileRoot}';
		const sheet = document.getElementById('vscode-css-modules').sheet;
		// Append so the cascade follows load order (later stylesheet wins), matching
		// the bundled build and the Electron dev loader. The default index prepends
		// and inverts precedence, which makes dev styling diverge from production.
		globalThis._VSCODE_CSS_LOAD = function (url) { sheet.insertRule(\`@import url(\${url});\`, sheet.cssRules.length); };
	</script>
	<script type="importmap">
${importMapJson}
	</script>
</head>
<body aria-label="">
	<script type="module">
		import { create, URI } from '${fileRoot}/vs/${entryPath}.js';
		create(document.body, {
			productConfiguration: {
				nameShort: '${useMobile ? 'Agents' : 'Sessions (Web)'}',
				nameLong: '${useMobile ? 'Agents' : 'Sessions (Web)'}',
				enableTelemetry: false,
			},
			${additionalBuiltinExtensions}
			${useModeSwitch ? `commands: [{
				id: '${useIDE ? 'preview.switchToAgents' : 'sessions.openInVSCode'}',
				label: '${useIDE ? 'Switch to Agents' : 'Switch to IDE'}',
				handler: () => parent.postMessage({ type: 'agent-workspace.switch-mode', mode: '${useIDE ? 'agents' : 'ide'}' }, location.origin),
			}],` : ''}
			workspaceProvider: {
				workspace: ${useMock && (!useIDE || sharedPreview)
			? `{ folderUri: URI.parse('mock-fs://mock-repo/mock-repo') }`
			: 'undefined'},
				open: async () => false,
				payload: [['isSessionsWindow', '${useIDE ? 'false' : 'true'}']],
			},
		});
	</script>
</body>
</html>`;
}

/** Keeps both workbenches mounted so mode changes preserve conversations and unsaved editor buffers. */
function getWorkspaceHTML() {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Workspace — Local Demo</title>
	<style>
		html, body { margin: 0; height: 100%; background: #181818; color: #eee; font: 13px system-ui; }
		body { display: flex; flex-direction: column; }
		header { display: flex; align-items: center; gap: 16px; padding: 6px 12px; border-bottom: 1px solid #444; }
		header[hidden], iframe[hidden] { display: none; }
		button { background: #222; color: #aaa; border: 1px solid #555; border-radius: 8px; padding: 3px; cursor: pointer; }
		button span { display: inline-block; padding: 4px 10px; border-radius: 6px; }
		button .selected { background: #444; color: white; }
		button:focus-visible { outline: 2px solid #75beff; outline-offset: 2px; }
		iframe { flex: 1; width: 100%; border: 0; min-height: 0; }
		.demo-label { color: #aaa; }
	</style></head><body>
	<header hidden><button type="button" role="switch" aria-label="IDE mode" aria-checked="true"><span>Agents</span><span class="selected">IDE</span></button><span class="demo-label">Local demo · Agents stay open while you edit</span></header>
	<iframe id="agents" title="Agents workspace" src="/agents?skip-sessions-welcome"></iframe>
	<script>
		const agents = document.getElementById('agents');
		const header = document.querySelector('header');
		let ide;
		function switchMode(mode) {
			if (mode === 'ide' && !ide) {
				ide = document.createElement('iframe'); ide.id = 'ide'; ide.title = 'IDE workspace'; ide.src = '/ide'; document.body.appendChild(ide);
			}
			agents.hidden = mode === 'ide'; header.hidden = mode !== 'ide';
			if (ide) { ide.hidden = mode !== 'ide'; }
			history.replaceState(null, '', mode === 'ide' ? '/?mode=ide' : '/?skip-sessions-welcome');
			(mode === 'ide' ? ide : agents).focus();
		}
		header.querySelector('button').addEventListener('click', () => switchMode('agents'));
		window.addEventListener('message', event => {
			if (event.origin !== location.origin || ![agents.contentWindow, ide?.contentWindow].includes(event.source)) { return; }
			if (event.data?.type === 'agent-workspace.switch-mode' && ['agents', 'ide'].includes(event.data.mode)) { switchMode(event.data.mode); }
		});
		if (new URLSearchParams(location.search).get('mode') === 'ide') { switchMode('ide'); }
	</script></body></html>`;
}

/** Recursively collect *.css paths relative to `dir`. */
function collectCssFiles(dir, prefix) {
	let results = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? prefix + '/' + entry.name : entry.name;
		if (entry.isDirectory()) {
			results = results.concat(collectCssFiles(path.join(dir, entry.name), rel));
		} else if (entry.name.endsWith('.css')) {
			results.push(rel);
		}
	}
	return results;
}

main();
