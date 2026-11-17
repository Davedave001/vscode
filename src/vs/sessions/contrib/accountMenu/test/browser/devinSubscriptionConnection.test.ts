/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { DevinSubscriptionProviderId, DevinSubscriptionResource } from '../../../../../platform/agentHost/common/devinAgentConfiguration.js';
import { RootState } from '../../../../../platform/agentHost/common/state/sessionState.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { AuthenticationSession, AuthenticationSessionsChangeEvent, IAuthenticationService } from '../../../../../workbench/services/authentication/common/authentication.js';
import { IExtensionService } from '../../../../../workbench/services/extensions/common/extensions.js';
import { DevinSubscriptionConnection } from '../../browser/devinSubscriptionConnection.js';

suite('Devin Subscription Connection', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	function fixture(registered = true) {
		const changes = store.add(new Emitter<{ providerId: string; label: string; event: AuthenticationSessionsChangeEvent }>());
		const starts = store.add(new Emitter<void>());
		const rootChanges = store.add(new Emitter<RootState>());
		const forwarded = store.add(new Emitter<string>());
		let sessions: AuthenticationSession[] = [{ id: 'browser-session', accessToken: 'browser-token', scopes: [], account: { id: 'account', label: 'Devin account' } }];
		let signIns = 0;
		const tokens: string[] = [];
		const root: RootState = { agents: registered ? [{ provider: DevinSubscriptionProviderId, displayName: 'Devin Subscription', description: '', models: [], protectedResources: [{ resource: DevinSubscriptionResource }] }] : [] };
		const authentication = upcastPartial<IAuthenticationService>({
			onDidChangeSessions: changes.event,
			getSessions: async () => sessions,
			createSession: async () => { signIns++; throw new Error('Sign-in should not be needed'); },
		});
		const host = upcastPartial<IAgentHostService>({
			onAgentHostStart: starts.event,
			rootState: upcastPartial<IAgentHostService['rootState']>({ value: root, onDidChange: rootChanges.event }),
			authenticate: async request => { assert.strictEqual(request.resource, DevinSubscriptionResource); tokens.push(request.token); forwarded.fire(request.token); return { authenticated: true }; },
		});
		const connection = store.add(new DevinSubscriptionConnection(authentication, host, upcastPartial<IExtensionService>({ whenInstalledExtensionsRegistered: async () => true }), new NullLogService()));
		return { connection, tokens, forwarded, starts, get signIns() { return signIns; }, signOut: () => { const removed = sessions; sessions = []; changes.fire({ providerId: DevinSubscriptionProviderId, label: 'Devin Subscription', event: { removed, added: [], changed: [] } }); } };
	}

	test('reuses the saved browser account and publishes it to the native provider once', async () => {
		const f = fixture();
		await f.connection.connect();
		await f.connection.connect();
		assert.strictEqual(f.signIns, 0);
		assert.deepStrictEqual(f.tokens, ['browser-token']);
	});

	test('does not forward a token to a host that has not advertised the Devin provider', async () => {
		const f = fixture(false);
		await assert.rejects(f.connection.connect(), /has not loaded Devin Subscription/);
		assert.deepStrictEqual(f.tokens, []);
	});

	test('withdraws credentials on sign-out and forwards a saved account after host restart', async () => {
		const f = fixture();
		await f.connection.connect();
		const restarted = Event.toPromise(f.forwarded.event);
		f.starts.fire();
		assert.strictEqual(await restarted, 'browser-token');
		const signedOut = Event.toPromise(f.forwarded.event);
		f.signOut();
		assert.strictEqual(await signedOut, '');
		assert.deepStrictEqual(f.tokens, ['browser-token', 'browser-token', '']);
	});
});
