/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IndexedDB } from '../../../../base/browser/indexedDB.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IndexedDBFileSystemProvider } from '../../browser/indexedDBFileSystemProvider.js';
import { FileChangeType, FileType } from '../../common/files.js';

suite('IndexedDB cross-window file changes', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('refreshes a peer directory cache and file size after create, edit, and delete', async () => {
		const name = `indexeddb-peer-test-${generateUuid()}`;
		const firstDatabase = await IndexedDB.create(name, 1, ['files']);
		const secondDatabase = await IndexedDB.create(name, 1, ['files']);
		const scheme = `peer-${generateUuid()}`;
		const writer = store.add(new IndexedDBFileSystemProvider(scheme, firstDatabase, 'files', true));
		const reader = store.add(new IndexedDBFileSystemProvider(scheme, secondDatabase, 'files', true));
		const root = URI.from({ scheme, path: '/' });
		const file = root.with({ path: '/example.txt' });
		async function change(expected: FileChangeType, operation: () => Promise<void>): Promise<void> {
			const received = Event.toPromise(Event.filter(reader.onDidChangeFile, changes => changes.some(change => change.resource.path === file.path)));
			await operation();
			const changes = await raceTimeout(received, 5000);
			assert.ok(changes, 'peer must receive the committed change');
			assert.strictEqual(changes.find(change => change.resource.path === file.path)?.type, expected);
		}
		try {
			assert.deepStrictEqual(await reader.readdir(root), []);
			await change(FileChangeType.ADDED, () => writer.writeFile(file, VSBuffer.fromString('first').buffer, { create: true, overwrite: true, unlock: false, atomic: false }));
			assert.deepStrictEqual(await reader.readdir(root), [['example.txt', FileType.File]]);
			assert.strictEqual((await reader.stat(file)).size, 5);
			await change(FileChangeType.UPDATED, () => writer.writeFile(file, VSBuffer.fromString('longer replacement').buffer, { create: true, overwrite: true, unlock: false, atomic: false }));
			assert.strictEqual((await reader.stat(file)).size, 18);
			assert.strictEqual(VSBuffer.wrap(await reader.readFile(file)).toString(), 'longer replacement');
			await change(FileChangeType.DELETED, () => writer.delete(file, { recursive: false, useTrash: false, atomic: false }));
			assert.deepStrictEqual(await reader.readdir(root), []);
			await assert.rejects(() => reader.stat(file));
		} finally {
			writer.dispose();
			reader.dispose();
			firstDatabase.close();
			secondDatabase.close();
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.deleteDatabase(name);
				request.onsuccess = () => resolve();
				request.onerror = () => reject(request.error);
			});
		}
	});
});
