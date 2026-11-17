/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
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
export type DevinSubscriptionStatus = { readonly kind: 'checking' | 'signedOut' | 'signingIn' | 'connecting' | 'unavailable' | 'failed' } | { readonly kind: 'ready'; readonly modelCount: number };
export interface IDevinSubscriptionConnection {
	readonly _serviceBrand: undefined;
	readonly status: IObservable<DevinSubscriptionStatus>;
	connect(): Promise<void>;
}

export class DevinSubscriptionConnection extends Disposable implements IDevinSubscriptionConnection {
	declare readonly _serviceBrand: undefined;
	private readonly _status = observableValue<DevinSubscriptionStatus>(this, { kind: 'checking' });
	readonly status: IObservable<DevinSubscriptionStatus> = this._status;
	// Undefined means the current host has not acknowledged a credential (including revocation).
	private forwardedToken: string | undefined;
	private accountToken: string | undefined;
	private revision = 0;
	private signingIn = false;
	private failed = false;
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
			if (event.providerId === DevinSubscriptionProviderId) {
				this.invalidate();
				this.accountToken = undefined;
				this.updateStatus();
				this.syncInBackground();
			}
		}));
		const bindRoot = () => {
			this.rootListeners.clear();
			this.providerAvailable = false;
			const update = () => {
				const available = this.hasProvider();
				const changed = available !== this.providerAvailable;
				this.providerAvailable = available;
				if (changed) { this.invalidate(); }
				this.updateStatus();
				if (available && changed) { this.syncInBackground(); }
			};
			this.rootListeners.add(agentHost.rootState.onDidChange(update));
			update();
		};
		this._register(agentHost.onAgentHostStart(() => { this.invalidate(); bindRoot(); }));
		bindRoot();
		this.syncInBackground();
	}

	async connect(): Promise<void> {
		await this.extensions.whenInstalledExtensionsRegistered();
		const sessions = await this.authentication.getSessions(DevinSubscriptionProviderId, [], undefined, true);
		if (!sessions.length) {
			this.signingIn = true;
			this.updateStatus();
			try { await this.authentication.createSession(DevinSubscriptionProviderId, [], { activateImmediate: true }); }
			finally { this.signingIn = false; this.updateStatus(); }
		}
		await this.sync(true);
	}

	private syncInBackground(): void {
		void this.sync().catch(() => this.log.warn('Devin Subscription account has not been connected to the agent host.'));
	}

	private getProvider() {
		const state = this.agentHost.rootState.value;
		return state && !(state instanceof Error) ? state.agents.find(agent => agent.provider === DevinSubscriptionProviderId && agent.protectedResources?.some(resource => resource.resource === DevinSubscriptionResource)) : undefined;
	}

	private hasProvider(): boolean { return !!this.getProvider(); }

	private invalidate(): void {
		this.revision++;
		this.forwardedToken = undefined;
		this.failed = false;
	}

	private updateStatus(): void {
		if (this._store.isDisposed) { return; }
		const modelCount = this.getProvider()?.models.length ?? 0;
		let status: DevinSubscriptionStatus;
		if (this.signingIn) { status = { kind: 'signingIn' }; }
		else if (this.failed) { status = { kind: 'failed' }; }
		else if (this.accountToken === undefined) { status = { kind: 'checking' }; }
		else if (!this.accountToken) { status = { kind: 'signedOut' }; }
		else if (!this.hasProvider()) { status = { kind: 'unavailable' }; }
		else if (this.forwardedToken === this.accountToken && modelCount > 0) { status = { kind: 'ready', modelCount }; }
		else { status = { kind: 'connecting' }; }
		const previous = this._status.get();
		if (previous.kind !== status.kind || (previous.kind === 'ready' && status.kind === 'ready' && previous.modelCount !== status.modelCount)) {
			this._status.set(status, undefined);
		}
	}

	private sync(refreshModels = false): Promise<void> {
		const result = this.queue.then(async () => {
			const revision = this.revision;
			const isCurrent = () => !this._store.isDisposed && revision === this.revision;
			try {
				await this.extensions.whenInstalledExtensionsRegistered();
				const sessions = await this.authentication.getSessions(DevinSubscriptionProviderId, [], undefined, true);
				if (!isCurrent()) { return; }
				const token = sessions[0]?.accessToken ?? '';
				this.accountToken = token;
				this.failed = false;
				this.updateStatus();
				if (token === this.forwardedToken && !(refreshModels && token && !this.getProvider()?.models.length)) { return; }
				if (!token && !this.hasProvider()) { return; }
				if (!this.hasProvider()) { throw new Error(localize('devin.providerMissing', "The agent host has not loaded Devin Subscription. Check the Devin executable setting and restart the local agent host after updating the fork. Your saved sign-in will be reused.")); }
				const result = await this.agentHost.authenticate({ resource: DevinSubscriptionResource, scopes: [], token });
				if (!isCurrent()) { return; }
				if (!result.authenticated) { throw new Error(localize('devin.restartHost', "The agent host has not loaded Devin Subscription. Restart the agent host after updating the fork, then connect again; your saved sign-in will be reused.")); }
				this.forwardedToken = token;
				this.updateStatus();
			} catch (error) {
				if (!isCurrent()) { return; }
				this.failed = this.hasProvider();
				this.updateStatus();
				throw error;
			}
		});
		this.queue = result.catch(() => { });
		return result;
	}

	override dispose(): void { this.invalidate(); this.accountToken = undefined; super.dispose(); }
}

registerSingleton(IDevinSubscriptionConnection, DevinSubscriptionConnection, InstantiationType.Delayed);
if (!isWeb) {
	class DevinSubscriptionConnectionContribution {
		constructor(@IDevinSubscriptionConnection connection: IDevinSubscriptionConnection) { void connection; }
	}
	registerWorkbenchContribution2('sessions.devinSubscriptionConnection', DevinSubscriptionConnectionContribution, WorkbenchPhase.AfterRestored);
}
