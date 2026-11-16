/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IndexedDB } from '../../../base/browser/indexedDB.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { IndexedDBFileSystemProvider } from '../../../platform/files/browser/indexedDBFileSystemProvider.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { PreviewRepositoryFileSystemProvider } from './previewRepositoryFileSystemProvider.js';

export const PREVIEW_WORKSPACE_URI = URI.from({ scheme: 'mock-fs', authority: 'mock-repo', path: '/mock-repo' });
export const PREVIEW_REPOSITORY_URI = URI.from({ scheme: 'github-remote-file', authority: 'github', path: '/mock-owner/mock-repo/HEAD' });

export const MOCK_WORKSPACE_FILES: Readonly<Record<string, string>> = {
	'/mock-repo/src/index.ts': 'export function main() {\n\tconsole.log("Hello from mock repo");\n}\n',
	'/mock-repo/src/utils.ts': 'export function add(a: number, b: number): number {\n\treturn a + b;\n}\n',
	'/mock-repo/package.json': '{\n\t"name": "mock-repo",\n\t"version": "1.0.0"\n}\n',
	'/mock-repo/README.md': '# Mock Repository\n\nThis is a mock repository for E2E testing.\n',
};

/** Registers a shared browser-only demo workspace without accessing desktop files or credentials. */
export async function registerPreviewWorkspace(fileService: IFileService, databaseName = 'code-oss-agent-workspace-preview-v1'): Promise<IDisposable> {
	const store = new DisposableStore();
	const database = await IndexedDB.create(databaseName, 1, ['files']);
	store.add(toDisposable(() => database.close()));
	try {
		// The marker lives outside /mock-repo. Keep it even if the user removes every
		// sample file, so a later reload never recreates intentionally deleted content.
		await database.runInTransaction('files', 'readwrite', objectStore => {
			const initialized = objectStore.get('/.preview-initialized');
			initialized.onsuccess = () => {
				if (initialized.result === undefined) {
					for (const [path, content] of Object.entries(MOCK_WORKSPACE_FILES)) {
						objectStore.put(VSBuffer.fromString(content).buffer, path);
					}
					objectStore.put(VSBuffer.fromString('1').buffer, '/.preview-initialized');
				}
			};
			return initialized;
		});
		const provider = store.add(new IndexedDBFileSystemProvider(PREVIEW_WORKSPACE_URI.scheme, database, 'files', true));
		store.add(fileService.registerProvider(PREVIEW_WORKSPACE_URI.scheme, provider));
		// The existing Cloud-session demo picker uses this GitHub-shaped URI. Resolve
		// that one sample repository locally, without calling GitHub or using credentials.
		store.add(fileService.registerProvider(PREVIEW_REPOSITORY_URI.scheme, new PreviewRepositoryFileSystemProvider(provider, PREVIEW_REPOSITORY_URI, PREVIEW_WORKSPACE_URI)));
		return store;
	} catch (error) {
		store.dispose();
		throw error;
	}
}
