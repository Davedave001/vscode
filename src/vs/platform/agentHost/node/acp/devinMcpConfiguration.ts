/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { deepClone, equals } from '../../../../base/common/objects.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { AgentHostMcpServersConfigKey, platformRootSchema } from '../../common/agentHostSchema.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';
import { IAgentHostCustomizationEnablementService, targetForUnownedMcpServer } from '../agentHostCustomizationEnablementService.js';
import { isAcpRecord } from './acpClient.js';

export type AcpMcpServer = {
	readonly name: string;
	readonly type?: undefined;
	readonly command: string;
	readonly args: readonly string[];
	readonly env: readonly { readonly name: string; readonly value: string }[];
} | {
	readonly name: string;
	readonly type: 'http' | 'sse';
	readonly url: string;
	readonly headers: readonly { readonly name: string; readonly value: string }[];
};

export interface IDevinMcpConfiguration {
	/** Undefined means host configuration changed; otherwise only the listed owner scopes changed. */
	readonly onDidChange: Event<readonly string[] | undefined>;
	getServers(owner: URI): Promise<readonly AcpMcpServer[]>;
}

/** Map explicit host configuration only; never copy another application's private configuration. */
export function toAcpMcpServer(name: string, value: unknown): AcpMcpServer {
	const invalid = () => new Error(localize('devin.mcp.invalid', "MCP server {0} has a configuration that Devin ACP cannot apply. Use an explicit stdio command or an HTTP/SSE URL with resolved string values.", name));
	if (!name.trim() || !isAcpRecord(value)) { throw invalid(); }
	// ACP cannot enforce these launch settings. Refuse them instead of silently removing a restriction.
	if (value.cwd !== undefined || value.envFile !== undefined || value.sandboxEnabled === true || value.sandbox !== undefined || value.oauth !== undefined) {
		throw invalid();
	}
	const stringValue = (entry: unknown): entry is string => typeof entry === 'string' && !/\$\{[^}]+\}/.test(entry);
	const entries = (dictionary: unknown, numeric: boolean): { name: string; value: string }[] => {
		if (dictionary === undefined) { return []; }
		if (!isAcpRecord(dictionary)) { throw invalid(); }
		return Object.entries(dictionary).map(([key, entry]) => {
			if (!key || !stringValue(entry) && !(numeric && typeof entry === 'number' && Number.isFinite(entry))) { throw invalid(); }
			return { name: key, value: String(entry) };
		});
	};
	if (value.type === 'stdio') {
		const args = value.args ?? [];
		if (!stringValue(value.command) || !value.command.trim() || !Array.isArray(args) || !args.every(stringValue)) { throw invalid(); }
		const env = entries(value.env, true);
		// MCP child processes must not inherit the browser account injected into the Devin process.
		if (!env.some(entry => (isWindows ? entry.name.toUpperCase() : entry.name) === 'WINDSURF_API_KEY')) { env.push({ name: 'WINDSURF_API_KEY', value: '' }); }
		return { name, command: value.command, args, env };
	}
	if (value.type === 'http') {
		if (!stringValue(value.url) || value.transport !== undefined && value.transport !== 'http' && value.transport !== 'sse') { throw invalid(); }
		let url: URL;
		try { url = new URL(value.url); } catch { throw invalid(); }
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) { throw invalid(); }
		return { name, type: value.transport === 'sse' ? 'sse' : 'http', url: value.url, headers: entries(value.headers, false) };
	}
	throw invalid();
}

/** Match the transport negotiated by this exact ACP process before sending its server list. */
export function validateAcpMcpCapabilities(servers: readonly AcpMcpServer[], capabilities: unknown): void {
	for (const server of servers) {
		if (server.type !== undefined && (!isAcpRecord(capabilities) || capabilities[server.type] !== true)) {
			throw new Error(localize('devin.mcp.transportUnsupported', "The Devin client did not advertise the {0} MCP transport required by {1}. Update the client or change this server's transport.", server.type, server.name));
		}
	}
}

/** Applies the host's existing global, workspace, and session decisions before native startup. */
export class DevinMcpConfiguration extends Disposable implements IDevinMcpConfiguration {
	private readonly changed = this._register(new Emitter<readonly string[] | undefined>());
	readonly onDidChange = this.changed.event;
	private previous: unknown;

	constructor(
		@IAgentConfigurationService private readonly configuration: IAgentConfigurationService,
		@IAgentHostCustomizationEnablementService private readonly enablement: IAgentHostCustomizationEnablementService,
	) {
		super();
		this.previous = deepClone(this.read());
		this._register(configuration.onDidRootConfigChange(() => {
			const current = this.read();
			if (!equals(this.previous, current)) {
				this.previous = deepClone(current);
				this.changed.fire(undefined);
			}
		}));
		this._register(enablement.onDidChange(event => this.changed.fire(event.sessions)));
	}

	private read() { return this.configuration.getRootValue(platformRootSchema, AgentHostMcpServersConfigKey); }

	async getServers(owner: URI): Promise<readonly AcpMcpServer[]> {
		const current = this.read();
		if (current === undefined || isAcpRecord(current) && Object.keys(current).length === 0) { return []; }
		await this.enablement.initializeSession(owner.toString());
		const servers = this.read();
		if (servers === undefined) { return []; }
		if (!isAcpRecord(servers)) { throw new Error(localize('devin.mcp.invalidMap', "The agent host MCP server configuration is invalid.")); }
		const result: AcpMcpServer[] = [];
		for (const [name, value] of Object.entries(servers)) {
			const decision = this.enablement.resolve(owner.toString(), targetForUnownedMcpServer(name));
			if (decision.kind !== 'resolved') { throw new Error(localize('devin.mcp.pending', "MCP server enablement is still being resolved for this workspace. Try the message again when the workspace is ready.")); }
			if (decision.enabled) { result.push(toAcpMcpServer(name, value)); }
		}
		return result;
	}
}
