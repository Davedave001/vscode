/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { getWindowsProtocolHandlerArguments } from '../../node/protocolHandlerArguments.js';

suite('Windows protocol handler arguments', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	for (const isBuilt of [false, true]) {
		const environment = {
			isBuilt, appRoot: 'D:\\Signal C\\source',
			userDataPath: 'D:\\Signal C\\profile\\', extensionsPath: 'D:\\Signal C\\extensions',
			appSharedDataHome: URI.file('/Signal C/shared data'), args: { _: [] },
		};
		test(`retains the ordinary ${isBuilt ? 'packaged' : 'development'} launch shape without manual quoting`, () => {
			assert.deepStrictEqual(getWindowsProtocolHandlerArguments(environment), [...(isBuilt ? [] : [environment.appRoot]), '--open-url', '--']);
		});
		test(`preserves explicit storage and agent home paths for ${isBuilt ? 'packaged' : 'development'} launches`, () => {
			assert.deepStrictEqual(getWindowsProtocolHandlerArguments({ ...environment, args: { _: [], 'user-data-dir': 'relative-profile', 'extensions-dir': 'relative-extensions', 'shared-data-dir': 'relative-shared', 'agent-codex-home': '/resolved codex', 'agent-claude-config-dir': '/resolved claude' } }), [
				...(isBuilt ? [] : [environment.appRoot]),
				'--user-data-dir', environment.userDataPath, '--extensions-dir', environment.extensionsPath, '--shared-data-dir', environment.appSharedDataHome.fsPath,
				'--agent-codex-home', '/resolved codex', '--agent-claude-config-dir', '/resolved claude',
				'--open-url', '--',
			]);
		});
	}
	test('excludes startup modes, test flags, and old URL arguments', () => {
		assert.deepStrictEqual(getWindowsProtocolHandlerArguments({ isBuilt: true, appRoot: '/source', userDataPath: '/profile', extensionsPath: '/extensions', appSharedDataHome: URI.file('/shared'), args: { _: ['workspace'], agents: true, 'hidden-window': true, extensionTestsPath: '/runner', 'open-url': true, _urls: ['signal-c://old'], 'user-data-dir': 'relative-profile' } }), ['--user-data-dir', '/profile', '--open-url', '--']);
	});
});
