/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async function () {
	const extension = vscode.extensions.getExtension('agent-workspace.devin-subscription');
	assert.ok(extension, 'Devin Subscription extension was not discovered');
	const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
	assert.strictEqual(normalize(extension.extensionPath), normalize(path.join(__dirname, '..')));
	await extension.activate();
	assert.ok(extension.isActive, 'Devin Subscription extension did not activate');
	const session = await vscode.authentication.getSession('devin-subscription', [], { silent: true });
	assert.strictEqual(session, undefined, 'Run this smoke test only in an empty isolated profile');
	console.log('[Devin Subscription] Extension activated and authentication provider registered. No browser or CLI was started.');
};
