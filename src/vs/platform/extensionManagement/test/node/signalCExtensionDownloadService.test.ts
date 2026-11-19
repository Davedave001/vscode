/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IDownloadService } from '../../../download/common/download.js';
import { IEnvironmentService } from '../../../environment/common/environment.js';
import { FileService } from '../../../files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../log/common/log.js';
import { getSignalCExtensionDownload, signalCExtensionCatalog } from '../../common/signalCExtensionCatalog.js';
import { SignalCExtensionDownloadService } from '../../node/signalCExtensionDownloadService.js';

suite('Signal-C Marketplace native downloads', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const cacheHome = URI.file('/signal-c-download-test');
	function createService(failure?: Error) {
		const log = new NullLogService();
		const files = store.add(new FileService(log));
		store.add(files.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		const requests: URI[] = [];
		const downloader = new class extends mock<IDownloadService>() {
			override async download(uri: URI, target: URI): Promise<void> {
				requests.push(uri);
				await files.writeFile(target, VSBuffer.fromString('release bytes'));
				if (failure) {
					throw failure;
				}
			}
		}();
		const environment = new class extends mock<IEnvironmentService>() { override readonly cacheHome = cacheHome; }();
		return { service: new SignalCExtensionDownloadService(downloader, files, environment, log), files, requests };
	}

	test('only catalog IDs can download and all URLs are resolved on the trusted side', async () => {
		const { service, requests } = createService();
		await assert.rejects(service.download('https://example.com/arbitrary.vsix'), /not in/);
		assert.strictEqual(requests.length, 0);
		const first = await service.download(signalCExtensionCatalog[0].id);
		const second = await service.download(signalCExtensionCatalog[0].id);
		assert.strictEqual(requests[0].toString(), getSignalCExtensionDownload(signalCExtensionCatalog[0]));
		assert.notStrictEqual(first.toString(), second.toString());
		assert.ok(first.path.startsWith(cacheHome.path + '/signal-c-marketplace/'));
	});

	test('failed downloads remove partial bytes and preserve the original network error', async () => {
		const failure = new Error('Network interrupted');
		const { service, files } = createService(failure);
		await assert.rejects(service.download(signalCExtensionCatalog[0].id), error => error === failure);
		assert.strictEqual((await files.resolve(URI.joinPath(cacheHome, 'signal-c-marketplace'))).children?.length, 0);
	});
});
