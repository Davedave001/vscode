/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { raceTimeout } from '../../../base/common/async.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { Event } from '../../../base/common/event.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { FileService } from '../../../platform/files/common/fileService.js';
import { FileChangeType } from '../../../platform/files/common/files.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { PREVIEW_REPOSITORY_URI, PREVIEW_WORKSPACE_URI, registerPreviewWorkspace } from './previewWorkspace.js';

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

	test('reads the demo repository from shared storage and refuses unrelated repositories and writes', async () => {
		const preview = await open();
		const local = PREVIEW_WORKSPACE_URI.with({ path: '/mock-repo/src/index.ts' });
		const repository = PREVIEW_REPOSITORY_URI.with({ path: PREVIEW_REPOSITORY_URI.path + '/src/index.ts' });
		await preview.files.writeFile(local, VSBuffer.fromString('saved from IDE'));
		assert.strictEqual((await preview.files.readFile(repository)).value.toString(), 'saved from IDE');
		assert.strictEqual(await preview.files.exists(PREVIEW_REPOSITORY_URI.with({ path: '/another-owner/mock-repo/HEAD/src/index.ts' })), false);
		assert.strictEqual(await preview.files.exists(PREVIEW_REPOSITORY_URI.with({ path: PREVIEW_REPOSITORY_URI.path + '-other/src/index.ts' })), false);
		assert.strictEqual(await preview.files.exists(repository.with({ authority: 'unrelated' })), false);
		assert.strictEqual(await preview.files.exists(repository.with({ query: 'ref=another' })), false);
		await assert.rejects(() => preview.files.writeFile(repository, VSBuffer.fromString('forbidden')));
		assert.strictEqual((await preview.files.readFile(local)).value.toString(), 'saved from IDE');
	});

	test('notifies the Agents repository view when IDE creates a file', async () => {
		const agents = await open();
		const ide = await open();
		await agents.files.resolve(PREVIEW_REPOSITORY_URI);
		const file = PREVIEW_WORKSPACE_URI.with({ path: '/mock-repo/new-file.ts' });
		const repositoryFile = PREVIEW_REPOSITORY_URI.with({ path: PREVIEW_REPOSITORY_URI.path + '/new-file.ts' });
		const added = Event.toPromise(Event.filter(agents.files.onDidFilesChange, event => event.contains(repositoryFile, FileChangeType.ADDED)), store);
		await ide.files.writeFile(file, VSBuffer.fromString('export const created = true;'));
		assert.ok(await raceTimeout(added, 5000), 'Agents must receive the new repository file notification');
		const folder = await agents.files.resolve(PREVIEW_REPOSITORY_URI);
		assert.ok(folder.children?.some(child => child.name === 'new-file.ts'));
	});
});
