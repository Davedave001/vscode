/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IWorkbench, IWorkbenchConstructionOptions } from '../../workbench/browser/web.api.js';
import { TestSessionsBrowserMain } from './web.test.js';
import { SessionsWorkbenchFactory } from '../browser/workbenchFactory.js';
import { DisposableStore, IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { mark } from '../../base/common/performance.js';
import { DeferredPromise } from '../../base/common/async.js';
import { CommandsRegistry } from '../../platform/commands/common/commands.js';

const workbenchPromise = new DeferredPromise<IWorkbench>();

/**
 * Creates the Sessions workbench with mock services for E2E testing.
 *
 * @param workbenchFactory Optional factory selecting the workbench presentation
 * under test (defaults to the classic desktop workbench).
 */
export function create(domElement: HTMLElement, options: IWorkbenchConstructionOptions, workbenchFactory?: SessionsWorkbenchFactory, browserMain = TestSessionsBrowserMain): IDisposable {

	mark('code/didLoadWorkbenchMain');
	// Honor the same embedder command contract as the production Sessions factory.
	const embedderCommands = new DisposableStore();
	for (const command of options.commands ?? []) {
		embedderCommands.add(CommandsRegistry.registerCommand(command.id, (_accessor, ...args) => command.handler(...args)));
	}

	let instantiatedWorkbench: IWorkbench | undefined = undefined;
	new browserMain(domElement, options, workbenchFactory).open().then(workbench => {
		instantiatedWorkbench = workbench;
		workbenchPromise.complete(workbench);
	});

	return toDisposable(() => {
		embedderCommands.dispose();
		if (instantiatedWorkbench) {
			instantiatedWorkbench.shutdown();
		} else {
			workbenchPromise.p.then(w => w.shutdown());
		}
	});
}
