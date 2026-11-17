/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { createExternalEditorWindowLinkUri, extractChatSessionToOpen, getMacOSWindowControlsPosition, isValidCopilotCliSessionId, parseExternalAgentsWindowNewSessionLinkUri, parseExternalEditorWindowLinkUri } from '../../common/window.js';

suite('window', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('round-trips folderless editor links with an optional host and conversation', () => {
		const chat = URI.from({ scheme: 'agent-host-copilotcli', path: '/session # 100%/项目', query: 'mode=1&example=2', fragment: 'chat&part=2' });
		for (const remoteAuthority of [undefined, 'ssh-remote+host', 'tunnel+host.region', 'wsl+My Distro', 'dev-container+abcdef@wsl+Ubuntu']) {
			for (const chatSessionToOpen of [undefined, chat]) {
				const link = createExternalEditorWindowLinkUri('signal-c', { remoteAuthority, chatSessionToOpen });
				assert.strictEqual(link.authority, 'editor-window');
				assert.strictEqual(link.path, '/open');
				const params = new URLSearchParams(link.query);
				assert.strictEqual(params.get('remoteAuthority'), remoteAuthority ?? null);
				assert.strictEqual(params.get('session'), chatSessionToOpen?.toString() ?? null);
				const parsed = parseExternalEditorWindowLinkUri(link.toString(), 'signal-c');
				assert.ok(parsed);
				assert.deepStrictEqual({ remoteAuthority: parsed.remoteAuthority, chat: parsed.chatSessionToOpen?.toString() }, { remoteAuthority, chat: chatSessionToOpen?.toString() });
			}
		}
	});

	test('rejects foreign, ambiguous, malformed, and oversized editor links', () => {
		for (const link of [
			'vscode://editor-window/open',
			'signal-c://other/open',
			'signal-c://editor-window/other',
			'signal-c://editor-window/open#fragment',
			'signal-c://editor-window/open?session=',
			'signal-c://editor-window/open?session=not-a-uri',
			'signal-c://editor-window/open?session=empty%3A',
			'signal-c://editor-window/open?session=test%3A%2Fone&session=test%3A%2Ftwo',
			'signal-c://editor-window/open?remoteAuthority=',
			'signal-c://editor-window/open?remoteAuthority=host',
			'signal-c://editor-window/open?remoteAuthority=ssh-remote%2Bhost%2Fpath',
			'signal-c://editor-window/open?remoteAuthority=ssh-remote%2Bhost%5Cpath',
			'signal-c://editor-window/open?remoteAuthority=ssh-remote%2Bhost%0A',
			'signal-c://editor-window/open?remoteAuthority=wsl%2BUbuntu&remoteAuthority=wsl%2BDebian',
			'signal-c://editor-window/open?windowId=_blank',
			`signal-c://editor-window/open?remoteAuthority=ssh-remote%2B${'x'.repeat(4097)}`,
			`signal-c://editor-window/open?session=test%3A%2F${'x'.repeat(8193)}`,
		]) {
			assert.strictEqual(parseExternalEditorWindowLinkUri(link, 'signal-c'), undefined);
		}
	});

	test('preserves every local, network, or remote workspace root and the conversation', () => {
		for (const remoteAuthority of [undefined, 'ssh-remote+host', 'wsl+Ubuntu', 'dev-container+abcdef']) {
			const folders = remoteAuthority
				? ['/project # 100%/项目', '/second project'].map(path => URI.from({ scheme: 'vscode-remote', authority: remoteAuthority, path }))
				: [URI.file('/project # 100%/项目'), URI.from({ scheme: 'file', authority: 'server', path: '/shared projects' })];
			const chatSessionToOpen = URI.parse('agent-host-copilotcli:/created#nested');
			const link = createExternalEditorWindowLinkUri('signal-c', { remoteAuthority, folders, chatSessionToOpen });
			const parsed = parseExternalEditorWindowLinkUri(link.toString(), 'signal-c');
			assert.deepStrictEqual({ remoteAuthority: parsed?.remoteAuthority, folders: parsed?.folders?.map(folder => folder.toString()), chat: parsed?.chatSessionToOpen?.toString() }, { remoteAuthority, folders: folders.map(folder => folder.toString()), chat: chatSessionToOpen.toString() });
		}
	});

	test('rejects malformed, mixed-host, non-folder, or oversized workspace root lists', () => {
		for (const [folders, remoteAuthority] of [
			[null], [42], ['file:///project'], [[]], [[42]], [['not-a-uri']], [['command:/execute']], [['file:relative']],
			[['file:///project?query']], [['file:///project#fragment']], [['file:///project\n']],
			[['vscode-remote://ssh-remote+host/project']],
			[['file:///project'], 'ssh-remote+host'],
			[['vscode-remote://ssh-remote+other/project'], 'ssh-remote+host'],
			[['vscode-remote://ssh-remote+host/project', 'file:///other'], 'ssh-remote+host'],
			[Array.from({ length: 101 }, (_, index) => `file:///project${index}`)],
			[[`file:///${'x'.repeat(8193)}`]],
		] as const) {
			const params = new URLSearchParams({ folders: JSON.stringify(folders) });
			if (remoteAuthority) { params.set('remoteAuthority', remoteAuthority); }
			const link = URI.from({ scheme: 'signal-c', authority: 'editor-window', path: '/open', query: params.toString() });
			assert.strictEqual(parseExternalEditorWindowLinkUri(link, 'signal-c'), undefined);
		}
		for (const query of ['folders=not-json', 'folders=%5B%22file%3A%2F%2F%2Fproject%22%5D&folders=%5B%5D', `folders=${'x'.repeat(65537)}`]) {
			assert.strictEqual(parseExternalEditorWindowLinkUri(`signal-c://editor-window/open?${query}`, 'signal-c'), undefined);
		}
	});

	test('preserves legacy macOS traffic-light positioning without a fixed inset', () => {
		assert.deepStrictEqual({
			beforeTahoe: [35, 44, 16].map(height => getMacOSWindowControlsPosition(height, '24.0.0')),
			tahoe: [35, 44, 14].map(height => getMacOSWindowControlsPosition(height, '25.0.0')),
		}, {
			beforeTahoe: [{ x: 10, y: 9 }, { x: 15, y: 14 }, null],
			tahoe: [{ x: 11, y: 10 }, { x: 16, y: 15 }, null],
		});
	});

	test('keeps macOS traffic lights horizontally fixed while centering different heights', () => {
		assert.deepStrictEqual({
			beforeTahoe: [35, 44, 35].map(height => getMacOSWindowControlsPosition(height, '24.0.0', 10)),
			tahoe: [35, 44, 35].map(height => getMacOSWindowControlsPosition(height, '25.0.0', 11)),
			zoomedBeforeTahoe: [44, 55, 44].map(height => getMacOSWindowControlsPosition(height, '24.0.0', 15)),
			zoomedTahoe: [44, 55, 44].map(height => getMacOSWindowControlsPosition(height, '25.0.0', 16)),
		}, {
			beforeTahoe: [{ x: 10, y: 9 }, { x: 10, y: 14 }, { x: 10, y: 9 }],
			tahoe: [{ x: 11, y: 10 }, { x: 11, y: 15 }, { x: 11, y: 10 }],
			zoomedBeforeTahoe: [{ x: 15, y: 14 }, { x: 15, y: 19 }, { x: 15, y: 14 }],
			zoomedTahoe: [{ x: 16, y: 15 }, { x: 16, y: 20 }, { x: 16, y: 15 }],
		});
	});

	test('parses an external Agents Window new-session link', () => {
		const query = new URLSearchParams({
			workspace: 'file:///Users/example/project',
			prompt: 'Fix the tests & explain why',
		});
		const link = URI.from({
			scheme: 'vscode-insiders',
			authority: 'agents',
			path: '/new',
			query: query.toString(),
		});

		const parsed = parseExternalAgentsWindowNewSessionLinkUri(link, 'vscode-insiders');

		assert.deepStrictEqual(parsed && {
			workspace: parsed.workspaceUri?.toString(),
			draft: parsed.draft,
		}, {
			workspace: 'file:///Users/example/project',
			draft: {
				inputText: 'Fix the tests & explain why',
				attachments: '[]',
			},
		});
	});

	test('parses an external Agents Window new-session link without a workspace', () => {
		const parsed = parseExternalAgentsWindowNewSessionLinkUri('vscode-insiders://agents/new?prompt=Draft%20without%20a%20workspace', 'vscode-insiders');

		assert.deepStrictEqual(parsed, {
			workspaceUri: undefined,
			draft: {
				inputText: 'Draft without a workspace',
				attachments: '[]',
			},
		});
	});

	test('rejects invalid external Agents Window new-session links', () => {
		assert.deepStrictEqual([
			parseExternalAgentsWindowNewSessionLinkUri('vscode://agents/new?workspace=file%3A%2F%2F%2Fproject&prompt=Fix', 'vscode-insiders'),
			parseExternalAgentsWindowNewSessionLinkUri('vscode-insiders://extensions/new?workspace=file%3A%2F%2F%2Fproject&prompt=Fix', 'vscode-insiders'),
			parseExternalAgentsWindowNewSessionLinkUri('vscode-insiders://agents/session?workspace=file%3A%2F%2F%2Fproject&prompt=Fix', 'vscode-insiders'),
			parseExternalAgentsWindowNewSessionLinkUri('vscode-insiders://agents/new?workspace=file%3A%2F%2F%2Fproject', 'vscode-insiders'),
			parseExternalAgentsWindowNewSessionLinkUri('vscode-insiders://agents/new?workspace=&prompt=Fix', 'vscode-insiders'),
			parseExternalAgentsWindowNewSessionLinkUri('vscode-insiders://agents/new?workspace=project&prompt=Fix', 'vscode-insiders'),
		], [undefined, undefined, undefined, undefined, undefined, undefined]);
	});

	test('extracts the chat session to open from a protocol link', () => {
		const extract = (link: string) => {
			const { uri, chatSessionToOpen } = extractChatSessionToOpen(URI.parse(link));
			return { uri: uri.toString(true), chatSessionToOpen };
		};

		assert.deepStrictEqual([
			extract('vscode://file/c:/project?windowId=_blank&copilotCliSession=0b6f9a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'),
			extract('vscode-insiders://file/home/me/project?copilotCliSession=my_session-1'),
			extract('vscode://vscode-remote/wsl+ubuntu/home/me/project?copilotCliSession=abc&gitRef=main'),
			extract('vscode://file/home/me/project?session=copilotcli%3A%2Fabc'),
			extract('vscode://file/home/me/project?session=copilotcli%3A%2Fabc&copilotCliSession=def'),
		], [
			{ uri: 'vscode://file/c:/project?windowId=_blank', chatSessionToOpen: { kind: 'copilotCli', sessionId: '0b6f9a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b' } },
			{ uri: 'vscode-insiders://file/home/me/project', chatSessionToOpen: { kind: 'copilotCli', sessionId: 'my_session-1' } },
			{ uri: 'vscode://vscode-remote/wsl+ubuntu/home/me/project?gitRef=main', chatSessionToOpen: { kind: 'copilotCli', sessionId: 'abc' } },
			{ uri: 'vscode://file/home/me/project', chatSessionToOpen: { kind: 'resource', resource: 'copilotcli:/abc' } },
			{ uri: 'vscode://file/home/me/project', chatSessionToOpen: { kind: 'resource', resource: 'copilotcli:/abc' } },
		]);
	});

	test('removes invalid chat session parameters from a protocol link', () => {
		const extract = (link: string) => {
			const { uri, chatSessionToOpen } = extractChatSessionToOpen(URI.parse(link));
			return { uri: uri.toString(true), chatSessionToOpen };
		};

		assert.deepStrictEqual([
			extract('vscode://file/home/me/project?copilotCliSession=../../etc'),
			extract('vscode://file/home/me/project?copilotCliSession=a%2Fb'),
			extract('vscode://file/home/me/project?copilotCliSession='),
			extract('vscode://file/home/me/project?session='),
		], [
			{ uri: 'vscode://file/home/me/project', chatSessionToOpen: undefined },
			{ uri: 'vscode://file/home/me/project', chatSessionToOpen: undefined },
			{ uri: 'vscode://file/home/me/project', chatSessionToOpen: undefined },
			{ uri: 'vscode://file/home/me/project', chatSessionToOpen: undefined },
		]);
	});

	test('leaves a protocol link without chat session parameters unchanged', () => {
		const link = URI.parse('vscode://vscode-remote/ssh-remote+host/home/me/project?windowId=_blank&a=b%20c');

		assert.strictEqual(extractChatSessionToOpen(link).uri, link);
	});

	test('validates Copilot CLI session ids', () => {
		assert.deepStrictEqual(
			['0b6f9a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', 'my_session-1', '', 'a/b', 'a.b', 'a b', 'é', 'a'.repeat(256), 'a'.repeat(257)].map(isValidCopilotCliSessionId),
			[true, true, false, false, false, false, false, true, false],
		);
	});
});
