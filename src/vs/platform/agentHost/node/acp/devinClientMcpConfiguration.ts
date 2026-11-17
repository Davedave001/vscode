/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse } from '../../../../base/common/jsonc.js';
import { SequencerByKey } from '../../../../base/common/async.js';
import { equals } from '../../../../base/common/objects.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { makeMcpServerCustomization, resolveMcpServersMap } from '../../../agentPlugins/common/pluginParsers.js';
import { IFileService } from '../../../files/common/files.js';
import { IAgentPluginManager } from '../../common/agentPluginManager.js';
import { isCustomizationEnabled } from '../../common/customizationEnablement.js';
import { readClientPluginMcpDefaultCwd } from '../../common/meta/clientPluginCustomizationMeta.js';
import { CustomizationType, type ClientPluginCustomization, type PluginCustomization } from '../../common/state/sessionState.js';
import { IAgentHostCustomizationEnablementService } from '../agentHostCustomizationEnablementService.js';
import { getSdkMcpServerEnablement, isCustomizationSdkEligible, resolveCustomizationEnablement } from '../shared/customizationEnablementGate.js';
import { isAcpRecord } from './acpClient.js';
import { type AcpMcpServer, type IDevinMcpClient, type IDevinMcpConfiguration, toAcpMcpServer } from './devinMcpConfiguration.js';

/** Consumes explicit client-bundled MCP definitions through the host's existing Open Plugins transport. */
export class DevinClientMcpConfiguration implements IDevinMcpConfiguration {
	readonly onDidChange: IDevinMcpConfiguration['onDidChange'];
	private readonly reads = new SequencerByKey<string>();

	constructor(
		private readonly root: IDevinMcpConfiguration,
		@IAgentPluginManager private readonly plugins: IAgentPluginManager,
		@IFileService private readonly files: IFileService,
		@IAgentHostCustomizationEnablementService private readonly enablement: IAgentHostCustomizationEnablementService,
	) {
		this.onDidChange = root.onDidChange;
	}

	getServers(owner: URI, clients: readonly IDevinMcpClient[] = [], workingDirectory?: URI): Promise<readonly AcpMcpServer[]> {
		return this.reads.queue(owner.toString(), () => this.resolveServers(owner, clients, workingDirectory));
	}

	private async resolveServers(owner: URI, clients: readonly IDevinMcpClient[], workingDirectory: URI | undefined): Promise<readonly AcpMcpServer[]> {
		const result = new Map((await this.root.getServers(owner)).map(server => [server.name, server]));
		for (const client of clients) {
			// childEnablement is the existing discriminator for children explicitly bundled by this client.
			const unique = new Map<string, ClientPluginCustomization>();
			for (const ref of client.customizations) {
				if (!ref.childEnablement || Object.keys(ref.childEnablement).length === 0) { continue; }
				const previous = unique.get(ref.uri);
				if (previous && !equals(previous, ref)) { throw this.invalid(ref.name); }
				unique.set(ref.uri, ref);
			}
			const refs = [...unique.values()];
			if (refs.length === 0) { continue; }
			await this.enablement.initializeSession(owner.toString());
			const inputs = new Map(refs.map(ref => [ref.uri, ref]));
			const childEnablement = new Map(refs.map(ref => [ref.uri, ref.childEnablement!]));
			const parents = resolveCustomizationEnablement(this.enablement, owner, refs, childEnablement, inputs);
			if (parents.pending) { throw this.pending(); }
			const enabled = parents.customizations.filter((ref): ref is PluginCustomization => ref.type === CustomizationType.Plugin && isCustomizationSdkEligible(parents, ref) && isCustomizationEnabled(ref));
			if (enabled.length === 0) { continue; }
			const enabledInputs = refs.filter(ref => enabled.some(parent => parent.uri === ref.uri));
			const synced = await this.plugins.syncCustomizations(client.clientId, enabledInputs).catch(() => { throw this.invalid(enabledInputs[0].name); });
			if (synced.length !== enabledInputs.length) { throw this.invalid(enabledInputs[0].name); }
			for (const item of synced) {
				const input = inputs.get(item.customization.uri);
				if (!input || !item.pluginDir) { throw this.invalid(input?.name ?? item.customization.name); }
				const declared = Object.keys(input.childEnablement!);
				const source = URI.joinPath(URI.parse(input.uri), '.mcp.json');
				const children = declared.map(name => makeMcpServerCustomization(source, name));
				const candidate = { ...item.customization, children };
				const resolved = resolveCustomizationEnablement(this.enablement, owner, [candidate], childEnablement, inputs);
				if (resolved.pending) { throw this.pending(); }
				const eligibility = getSdkMcpServerEnablement(resolved);
				const enabledChildren = children.filter(child => eligibility.get(child.id) === true);
				if (enabledChildren.length === 0) { continue; }
				// Read the raw configuration so unsupported launch restrictions cannot be normalized away.
				let raw: unknown;
				try {
					const content = await this.files.readFile(URI.joinPath(item.pluginDir, '.mcp.json'));
					raw = parse(content.value.toString());
				} catch { throw this.invalid(input.name); }
				const definitions = resolveMcpServersMap(raw);
				if (!isAcpRecord(definitions)) { throw this.invalid(input.name); }
				for (const child of enabledChildren) {
					if (!Object.hasOwn(definitions, child.name)) { throw this.invalid(input.name); }
					const server = toAcpMcpServer(child.name, definitions[child.name]);
					this.validateWorkingDirectory(input, server, workingDirectory);
					const previous = result.get(server.name);
					if (previous && !equals(previous, server)) {
						throw new Error(localize('devin.mcp.conflict', "MCP server {0} has conflicting enabled definitions. Give the servers distinct names before starting Devin.", server.name));
					}
					result.set(server.name, server);
				}
			}
		}
		return [...result.values()];
	}

	private validateWorkingDirectory(input: ClientPluginCustomization, server: AcpMcpServer, workingDirectory: URI | undefined): void {
		if (server.type !== undefined) { return; }
		const declared = readClientPluginMcpDefaultCwd(input, server.name, workingDirectory);
		if (declared && (!workingDirectory || !isEqual(declared, workingDirectory))) {
			throw new Error(localize('devin.mcp.cwdUnsupported', "MCP server {0} requires a different working directory than this Devin chat supports. Open a chat in that workspace or add a compatible server configuration.", server.name));
		}
	}

	private invalid(name: string): Error {
		return new Error(localize('devin.mcp.clientBundleInvalid', "The MCP configuration bundle {0} is unavailable or invalid. Reconnect the client and try again.", name));
	}

	private pending(): Error {
		return new Error(localize('devin.mcp.clientBundlePending', "MCP customization enablement is still being resolved for this workspace. Try the message again when the workspace is ready."));
	}
}
