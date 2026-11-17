/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { isWeb } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { DevinSubscriptionProviderId, DevinSubscriptionResource } from '../../../../platform/agentHost/common/devinAgentConfiguration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IAuthenticationService } from '../../../../workbench/services/authentication/common/authentication.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';

export const IDevinSubscriptionConnection = createDecorator<IDevinSubscriptionConnection>('devinSubscriptionConnection');
export interface IDevinSubscriptionConnection {
	readonly _serviceBrand: undefined;
	connect(): Promise<void>;
}

export class DevinSubscriptionConnection extends Disposable implements IDevinSubscriptionConnection {
	declare readonly _serviceBrand: undefined;
	private forwardedToken = '';
	private queue: Promise<void> = Promise.resolve();
	private readonly rootListeners = this._register(new DisposableStore());
	private providerAvailable = false;

	constructor(
		@IAuthenticationService private readonly authentication: IAuthenticationService,
		@IAgentHostService private readonly agentHost: IAgentHostService,
		@IExtensionService private readonly extensions: IExtensionService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this._register(authentication.onDidChangeSessions(event => {
			if (event.providerId === DevinSubscriptionProviderId) { this.syncInBackground(); }
		}));
		const bindRoot = () => {
			this.rootListeners.clear();
			this.providerAvailable = false;
			const update = () => {
				const available = this.hasProvider();
				if (available && !this.providerAvailable) { this.syncInBackground(); }
				this.providerAvailable = available;
			};
			this.rootListeners.add(agentHost.rootState.onDidChange(update));
			update();
		};
		this._register(agentHost.onAgentHostStart(() => { this.forwardedToken = ''; bindRoot(); }));
		bindRoot();
		this.syncInBackground();
	}

	async connect(): Promise<void> {
		await this.extensions.whenInstalledExtensionsRegistered();
		const sessions = await this.authentication.getSessions(DevinSubscriptionProviderId, [], undefined, true);
		if (!sessions.length) { await this.authentication.createSession(DevinSubscriptionProviderId, [], { activateImmediate: true }); }
		await this.sync();
	}

	private syncInBackground(): void {
		void this.sync().catch(() => this.log.warn('Devin Subscription account has not been connected to the agent host.'));
	}

	private hasProvider(): boolean {
		const state = this.agentHost.rootState.value;
		return !!state && !(state instanceof Error) && state.agents.some(agent => agent.provider === DevinSubscriptionProviderId && agent.protectedResources?.some(resource => resource.resource === DevinSubscriptionResource));
	}

	private sync(): Promise<void> {
		const result = this.queue.then(async () => {
			await this.extensions.whenInstalledExtensionsRegistered();
			const sessions = await this.authentication.getSessions(DevinSubscriptionProviderId, [], undefined, true);
			const token = sessions[0]?.accessToken ?? '';
			if (this._store.isDisposed || token === this.forwardedToken) { return; }
			if (!this.hasProvider()) { throw new Error(localize('devin.providerMissing', "The agent host has not loaded Devin Subscription. Check the Devin executable setting and restart the local agent host after updating the fork. Your saved sign-in will be reused.")); }
			const result = await this.agentHost.authenticate({ resource: DevinSubscriptionResource, scopes: [], token });
			if (!result.authenticated) { throw new Error(localize('devin.restartHost', "The agent host has not loaded Devin Subscription. Restart the agent host after updating the fork, then connect again; your saved sign-in will be reused.")); }
			this.forwardedToken = token;
		});
		this.queue = result.catch(() => { });
		return result;
	}

	override dispose(): void { this.forwardedToken = ''; super.dispose(); }
}

registerSingleton(IDevinSubscriptionConnection, DevinSubscriptionConnection, InstantiationType.Delayed);
if (!isWeb) {
	class DevinSubscriptionConnectionContribution {
		constructor(@IDevinSubscriptionConnection connection: IDevinSubscriptionConnection) { void connection; }
	}
	registerWorkbenchContribution2('sessions.devinSubscriptionConnection', DevinSubscriptionConnectionContribution, WorkbenchPhase.AfterRestored);
}
