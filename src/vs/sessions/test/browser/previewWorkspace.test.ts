/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../base/common/buffer.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { FileService } from '../../../platform/files/common/fileService.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { PREVIEW_WORKSPACE_URI, registerPreviewWorkspace } from './previewWorkspace.js';

suite('Shared preview workspace', () => {
	const tracked = ensureNoDisposablesAreLeakedInTestSuite();
	let store: DisposableStore;
	let databaseName: string;

	setup(() => {
		store = tracked.add(new DisposableStore());
		databaseName = `preview-workspace-test-${generateUuid()}`;
	});
	teardown(async () => {
		store.dispose();
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.deleteDatabase(databaseName);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	});

	async function open() {
		const files = store.add(new FileService(new NullLogService()));
		const registration = store.add(await registerPreviewWorkspace(files, databaseName));
		return { files, registration };
	}

	test('retains saved edits after reopening and exposes them to the other view', async () => {
		const agents = await open();
		const file = PREVIEW_WORKSPACE_URI.with({ path: '/mock-repo/src/index.ts' });
		await agents.files.writeFile(file, VSBuffer.fromString('export const editedInAgents = true;'));
		const ide = await open();
		assert.strictEqual((await ide.files.readFile(file)).value.toString(), 'export const editedInAgents = true;');
		await ide.files.writeFile(file, VSBuffer.fromString('export const editedInIDE = true;'));
		assert.strictEqual((await agents.files.readFile(file)).value.toString(), 'export const editedInIDE = true;');
		agents.registration.dispose();
		ide.registration.dispose();
		const reopened = await open();
		assert.strictEqual((await reopened.files.readFile(file)).value.toString(), 'export const editedInIDE = true;');
	});

	test('does not restore intentionally deleted sample files on reload', async () => {
		const first = await open();
		assert.ok(await first.files.exists(PREVIEW_WORKSPACE_URI.with({ path: '/mock-repo/README.md' })));
		await first.files.del(PREVIEW_WORKSPACE_URI, { recursive: true });
		first.registration.dispose();
		const reopened = await open();
		assert.strictEqual(await reopened.files.exists(PREVIEW_WORKSPACE_URI.with({ path: '/mock-repo/README.md' })), false);
	});
});
