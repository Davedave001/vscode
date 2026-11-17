/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../base/common/event.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { upcastPartial } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DevinMcpConfiguration, toAcpMcpServer, validateAcpMcpCapabilities } from '../../node/acp/devinMcpConfiguration.js';
import { IAgentConfigurationService } from '../../node/agentConfigurationService.js';
import { IAgentHostCustomizationEnablementService, ICustomizationEnablementChangeEvent } from '../../node/agentHostCustomizationEnablementService.js';

suite('Devin MCP configuration', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('does not load enablement or session data when the host has no MCP configuration', async () => {
		const service = store.add(new DevinMcpConfiguration(
			upcastPartial<IAgentConfigurationService>({ onDidRootConfigChange: Event.None, getRootValue: () => undefined }),
			upcastPartial<IAgentHostCustomizationEnablementService>({ onDidChange: Event.None, initializeSession: async () => { assert.fail('No MCP configuration should require loading session data.'); } }),
		));
		assert.deepStrictEqual(await service.getServers(URI.parse('host:/opaque-owner')), []);
	});

	test('preserves stdio command arguments and environment as structured ACP fields', () => {
		assert.deepStrictEqual(toAcpMcpServer('local tools', { type: 'stdio', command: 'C:\\Program Files\\Tools\\mcp.exe', args: ['--label', 'value with spaces'], env: { MODE: 'read', COUNT: 0 } }), {
			name: 'local tools', command: 'C:\\Program Files\\Tools\\mcp.exe', args: ['--label', 'value with spaces'], env: [{ name: 'MODE', value: 'read' }, { name: 'COUNT', value: '0' }, { name: 'WINDSURF_API_KEY', value: '' }],
		});
		assert.deepStrictEqual(toAcpMcpServer('defaults', { type: 'stdio', command: 'mcp' }), { name: 'defaults', command: 'mcp', args: [], env: [{ name: 'WINDSURF_API_KEY', value: '' }] });
	});

	test('maps HTTP and SSE only when their exact transport was advertised', () => {
		const http = toAcpMcpServer('remote', { type: 'http', url: 'https://tools.example/mcp', headers: { Authorization: 'test-only-secret' } });
		const sse = toAcpMcpServer('legacy', { type: 'http', transport: 'sse', url: 'http://127.0.0.1:8080/sse' });
		assert.deepStrictEqual(http, { name: 'remote', type: 'http', url: 'https://tools.example/mcp', headers: [{ name: 'Authorization', value: 'test-only-secret' }] });
		assert.strictEqual(sse.type, 'sse');
		validateAcpMcpCapabilities([http, sse], { http: true, sse: true });
		assert.throws(() => validateAcpMcpCapabilities([http], undefined), /did not advertise/);
		assert.throws(() => validateAcpMcpCapabilities([sse], { http: true }), /did not advertise/);
		validateAcpMcpCapabilities([toAcpMcpServer('local', { type: 'stdio', command: 'mcp' })], undefined);
	});

	test('preserves explicit environment overrides with platform-specific key casing', () => {
		const server = toAcpMcpServer('explicit environment', { type: 'stdio', command: 'mcp', env: { windsurf_api_key: 'explicit-test-value' } });
		assert.ok(server.type === undefined);
		assert.deepStrictEqual(server.env, [
			{ name: 'windsurf_api_key', value: 'explicit-test-value' },
			...isWindows ? [] : [{ name: 'WINDSURF_API_KEY', value: '' }],
		]);
	});

	test('rejects unsupported launch restrictions, unresolved variables, and invalid values without exposing secrets', () => {
		const secret = 'private-value-for-test';
		for (const value of [
			{ type: 'stdio', command: 'mcp', cwd: secret },
			{ type: 'stdio', command: 'mcp', envFile: secret },
			{ type: 'stdio', command: 'mcp', sandboxEnabled: true },
			{ type: 'stdio', command: 'mcp', env: { TOKEN: null } },
			{ type: 'stdio', command: 'mcp', args: [3] },
			{ type: 'stdio', command: 'mcp', env: { TOKEN: '${input:token}' } },
			{ type: 'http', url: `https://user:${secret}@tools.example/mcp` },
			{ type: 'http', url: `file:///${secret}` },
			{ type: 'http', url: 'https://tools.example/mcp', headers: { Token: { secret } } },
			{ type: 'http', url: 'https://tools.example/mcp', oauth: { clientId: secret } },
		]) {
			assert.throws(() => toAcpMcpServer('configured-server', value), error => error instanceof Error && error.message.includes('cannot apply') && !error.message.includes(secret));
		}
	});

	test('uses authoritative owner-scoped enablement and signals only changed root MCP values', async () => {
		const rootChanged = store.add(new Emitter<void>());
		const enablementChanged = store.add(new Emitter<ICustomizationEnablementChangeEvent>());
		let root: Record<string, unknown> = { enabled: { type: 'stdio', command: 'mcp' }, disabled: { type: 'stdio', command: 'mcp', sandboxEnabled: true } };
		let pending = false;
		const seenOwners: string[] = [];
		const owner = URI.parse('other-host:/opaque-owner');
		const service = store.add(new DevinMcpConfiguration(
			upcastPartial<IAgentConfigurationService>({ onDidRootConfigChange: rootChanged.event, getRootValue: () => root as never }),
			upcastPartial<IAgentHostCustomizationEnablementService>({
				onDidChange: enablementChanged.event,
				initializeSession: async resource => { seenOwners.push(resource); },
				resolve: (resource, target) => {
					seenOwners.push(resource);
					return pending ? { kind: 'pending', reason: 'workingDirectory' } : { kind: 'resolved', enabled: target.name === 'enabled', enablement: [], workingDirectory: { kind: 'directory', uri: URI.file('/workspace') } };
				},
			}),
		));
		const changes: (readonly string[] | undefined)[] = [];
		store.add(service.onDidChange(event => changes.push(event)));
		assert.deepStrictEqual((await service.getServers(owner)).map(server => server.name), ['enabled']);
		assert.ok(seenOwners.every(resource => resource === owner.toString()));
		rootChanged.fire();
		assert.deepStrictEqual(changes, []);
		root = { ...root, enabled: { type: 'stdio', command: 'updated-mcp' } };
		rootChanged.fire();
		enablementChanged.fire({ sessions: [owner.toString()] });
		assert.deepStrictEqual(changes, [undefined, [owner.toString()]]);
		pending = true;
		await assert.rejects(service.getServers(owner), /still being resolved/);
	});
});
