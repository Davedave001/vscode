/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { upcastPartial } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IFileContent, IFileService } from '../../../files/common/files.js';
import { IAgentPluginManager } from '../../common/agentPluginManager.js';
import { toClientPluginMcpDefaultCwdsMeta } from '../../common/meta/clientPluginCustomizationMeta.js';
import { CustomizationEnablementKind, CustomizationType, type ClientPluginCustomization, type CustomizationEnablement } from '../../common/state/protocol/state.js';
import { DevinClientMcpConfiguration } from '../../node/acp/devinClientMcpConfiguration.js';
import { type AcpMcpServer, toAcpMcpServer } from '../../node/acp/devinMcpConfiguration.js';
import { type CustomizationEnablementResolution, type ICustomizationEnablementTarget, IAgentHostCustomizationEnablementService } from '../../node/agentHostCustomizationEnablementService.js';

suite('Devin client MCP configuration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const owner = URI.parse('another-host:/opaque-owner');
	const cwd = URI.file('/chosen workspace');
	const global = (enabled: boolean): CustomizationEnablement[] => [{ kind: CustomizationEnablementKind.Global, enabled }];
	const bundle = (): ClientPluginCustomization => ({ type: CustomizationType.Plugin, id: 'client-bundle', name: 'Client MCP', uri: 'client-files://window/bundle', nonce: 'revision', childEnablement: { tools: global(true) } });

	function fixture() {
		let content = JSON.stringify({ mcpServers: { tools: { type: 'http', url: 'http://127.0.0.1:43123/opaque-gateway' } } });
		let root: readonly AcpMcpServer[] = [];
		let pending: string | undefined;
		let syncFailure = false;
		let missingDirectory = false;
		let reads = 0;
		const syncedClients: string[] = [];
		const decisions: { owner: string; target: ICustomizationEnablementTarget }[] = [];
		const overrides = new Map<string, boolean>();
		const resolve = (resource: string, target: ICustomizationEnablementTarget, entries: readonly CustomizationEnablement[] = []): CustomizationEnablementResolution => {
			decisions.push({ owner: resource, target });
			if (pending === target.name) { return { kind: 'pending', reason: 'workingDirectory' }; }
			const enabled = overrides.get(target.name) ?? entries[0]?.enabled ?? true;
			return { kind: 'resolved', enabled, enablement: global(enabled), workingDirectory: { kind: 'directory', uri: cwd } };
		};
		const service = new DevinClientMcpConfiguration(
			{ onDidChange: Event.None, getServers: async () => root },
			upcastPartial<IAgentPluginManager>({ syncCustomizations: async (clientId, inputs) => {
				syncedClients.push(clientId);
				if (syncFailure) { throw new Error('synthetic-private-token'); }
				return inputs.map(customization => ({ customization, pluginDir: missingDirectory ? undefined : URI.file('/materialized/client-bundle') }));
			} }),
			upcastPartial<IFileService>({ readFile: async resource => { reads++; return upcastPartial<IFileContent>({ resource, value: VSBuffer.fromString(content) }); } }),
			upcastPartial<IAgentHostCustomizationEnablementService>({ initializeSession: async () => { }, resolve, applyClientGlobalEnablement: resolve }),
		);
		return { service, syncedClients, decisions, overrides, get reads() { return reads; }, set content(value: string) { content = value; }, set root(value: readonly AcpMcpServer[]) { root = value; }, set pending(value: string | undefined) { pending = value; }, set syncFailure(value: boolean) { syncFailure = value; }, set missingDirectory(value: boolean) { missingDirectory = value; } };
	}

	test('preserves root configuration and ignores clients that declare no bundled MCP children', async () => {
		const f = fixture();
		const server = toAcpMcpServer('root', { type: 'stdio', command: 'root-mcp' });
		f.root = [server];
		const unrelated = { ...bundle(), childEnablement: undefined };
		assert.deepStrictEqual(await f.service.getServers(owner, [{ clientId: 'editor', customizations: [unrelated] }], cwd), [server]);
		assert.deepStrictEqual(f.syncedClients, []);
		assert.strictEqual(f.reads, 0);
	});

	test('serializes reads for the same owner without blocking another opaque owner', async () => {
		const first = new DeferredPromise<void>();
		const started = new DeferredPromise<void>();
		let calls = 0;
		const service = new DevinClientMcpConfiguration(
			{ onDidChange: Event.None, getServers: async () => { if (++calls === 1) { void started.complete(); await first.p; } return []; } },
			upcastPartial<IAgentPluginManager>({}), upcastPartial<IFileService>({}), upcastPartial<IAgentHostCustomizationEnablementService>({}),
		);
		const reading = service.getServers(owner);
		const queued = service.getServers(owner);
		await started.p;
		assert.strictEqual(calls, 1);
		await service.getServers(URI.parse('other-host:/different-owner'));
		assert.strictEqual(calls, 2);
		void first.complete();
		await Promise.all([reading, queued]);
		assert.strictEqual(calls, 3);
	});

	test('coalesces identical duplicate bundle references and rejects conflicting revisions', async () => {
		const f = fixture();
		const input = bundle();
		assert.strictEqual((await f.service.getServers(owner, [{ clientId: 'editor', customizations: [input, { ...input }] }], cwd)).length, 1);
		await assert.rejects(f.service.getServers(owner, [{ clientId: 'editor', customizations: [input, { ...input, nonce: 'different-revision' }] }], cwd), /unavailable or invalid/);
	});

	test('forwards only declared enabled MCP children with the exact client and live owner scope', async () => {
		const f = fixture();
		f.content = JSON.stringify({ mcpServers: { tools: { type: 'http', url: 'http://127.0.0.1:43123/opaque-gateway' }, undeclared: { type: 'stdio', command: 'must-not-run' } } });
		const result = await f.service.getServers(owner, [{ clientId: 'opaque-client', customizations: [bundle()] }], cwd);
		assert.deepStrictEqual(result, [toAcpMcpServer('tools', { type: 'http', url: 'http://127.0.0.1:43123/opaque-gateway' })]);
		assert.deepStrictEqual(f.syncedClients, ['opaque-client']);
		assert.ok(f.decisions.every(decision => decision.owner === owner.toString()));
		const child = f.decisions.find(decision => decision.target.type === CustomizationType.McpServer);
		assert.strictEqual(child?.target.isClientBundled, true);
		assert.strictEqual(child?.target.owningPluginSource?.toString(), bundle().uri);
	});

	test('applies client Global and authoritative host overrides before reading or forwarding definitions', async () => {
		const f = fixture();
		const input = bundle();
		input.childEnablement = { tools: global(false) };
		assert.deepStrictEqual(await f.service.getServers(owner, [{ clientId: 'editor', customizations: [input] }], cwd), []);
		assert.strictEqual(f.reads, 0);
		f.overrides.set('tools', true);
		assert.strictEqual((await f.service.getServers(owner, [{ clientId: 'editor', customizations: [input] }], cwd)).length, 1);
		input.enablement = global(false);
		const copies = f.syncedClients.length;
		assert.deepStrictEqual(await f.service.getServers(owner, [{ clientId: 'editor', customizations: [input] }], cwd), []);
		assert.strictEqual(f.syncedClients.length, copies);
	});

	test('fails closed while parent or child enablement is pending', async () => {
		for (const name of ['Client MCP', 'tools']) {
			const f = fixture();
			f.pending = name;
			await assert.rejects(f.service.getServers(owner, [{ clientId: 'editor', customizations: [bundle()] }], cwd), /still being resolved/);
			assert.strictEqual(f.reads, 0);
		}
	});

	test('rejects invalid bundles and unsupported restrictions without exposing configuration values', async () => {
		for (const content of ['{ invalid JSON', '{}', JSON.stringify({ mcpServers: { tools: { type: 'stdio', command: 'mcp', sandboxEnabled: true, env: { TOKEN: 'synthetic-private-token' } } } })]) {
			const f = fixture();
			f.content = content;
			await assert.rejects(f.service.getServers(owner, [{ clientId: 'editor', customizations: [bundle()] }], cwd), error => error instanceof Error && !error.message.includes('synthetic-private-token'));
		}
		for (const missingDirectory of [false, true]) {
			const f = fixture();
			f.syncFailure = !missingDirectory;
			f.missingDirectory = missingDirectory;
			await assert.rejects(f.service.getServers(owner, [{ clientId: 'editor', customizations: [bundle()] }], cwd), /bundle Client MCP is unavailable or invalid/);
		}
	});

	test('checks a stdio bundle default working directory before native startup', async () => {
		const f = fixture();
		f.content = JSON.stringify({ mcpServers: { tools: { type: 'stdio', command: 'mcp' } } });
		const input = { ...bundle(), _meta: toClientPluginMcpDefaultCwdsMeta({ tools: cwd }) };
		assert.strictEqual((await f.service.getServers(owner, [{ clientId: 'editor', customizations: [input] }], cwd)).length, 1);
		await assert.rejects(f.service.getServers(owner, [{ clientId: 'editor', customizations: [input] }], URI.file('/other workspace')), /different working directory/);
	});

	test('rejects conflicting root and client names while coalescing an identical definition', async () => {
		const f = fixture();
		f.root = [toAcpMcpServer('tools', { type: 'http', url: 'https://different.example/mcp' })];
		await assert.rejects(f.service.getServers(owner, [{ clientId: 'editor', customizations: [bundle()] }], cwd), /conflicting enabled definitions/);
		f.root = [toAcpMcpServer('tools', { type: 'http', url: 'http://127.0.0.1:43123/opaque-gateway' })];
		assert.strictEqual((await f.service.getServers(owner, [{ clientId: 'editor', customizations: [bundle()] }], cwd)).length, 1);
	});
});
