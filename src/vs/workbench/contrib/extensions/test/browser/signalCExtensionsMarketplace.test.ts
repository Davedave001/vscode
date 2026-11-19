/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { ILocalExtension } from '../../../../../platform/extensionManagement/common/extensionManagement.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { installSignalCExtension, SignalCExtensionsMarketplace } from '../../browser/signalCExtensionsMarketplace.js';
import { IExtension, IExtensionsWorkbenchService } from '../../common/extensions.js';
import { getSignalCExtensionDownload, ISignalCExtensionDownloadService, matchesSignalCExtension, signalCExtensionCatalog } from '../../../../../platform/extensionManagement/common/signalCExtensionCatalog.js';

suite('Signal-C Marketplace', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const logService = new NullLogService();
	const cacheHome = URI.file('/signal-c-test-cache');
	// SHA-256 of the download fixture "abc".
	const listing = { ...signalCExtensionCatalog[0], sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' };

	function createServices(content = 'abc', installError?: Error, installedVersion = listing.version) {
		const fileService = store.add(new FileService(logService));
		store.add(fileService.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		const installs: { uri: URI; enable: boolean | undefined }[] = [];
		const downloads: string[] = [];
		const installed = new class extends mock<IExtension>() {
			override readonly identifier = { id: listing.id };
			override readonly version = installedVersion;
			override readonly local = new class extends mock<ILocalExtension>() { }();
		}();
		const extensionsWorkbenchService = new class extends mock<IExtensionsWorkbenchService>() {
			override readonly local: IExtension[] = [];
			override readonly onChange = Event.None;
			override readonly whenInitialized = Promise.resolve();
			override async install(arg: string | URI | IExtension, options?: { enable?: boolean }): Promise<IExtension> {
				assert.ok(URI.isUri(arg));
				installs.push({ uri: arg, enable: options?.enable });
				assert.strictEqual((await fileService.readFile(arg)).value.toString(), content);
				if (installError) {
					throw installError;
				}
				return installed;
			}
		}();
		const downloadService = new class extends mock<ISignalCExtensionDownloadService>() {
			override async download(id: string): Promise<URI> {
				downloads.push(id);
				const target = URI.joinPath(cacheHome, 'signal-c-marketplace', 'fixture.vsix');
				await fileService.createFolder(URI.joinPath(cacheHome, 'signal-c-marketplace'));
				await fileService.writeFile(target, VSBuffer.fromString(content));
				return target;
			}
		}();
		return { fileService, extensionsWorkbenchService, downloadService, logService, cacheHome, installs, downloads, installed };
	}

	test('catalog pins distinct released extensions to HTTPS GitHub assets and SHA-256 digests', () => {
		assert.strictEqual(new Set(signalCExtensionCatalog.map(entry => entry.id)).size, signalCExtensionCatalog.length);
		assert.strictEqual(signalCExtensionCatalog.length, 3);
		for (const entry of signalCExtensionCatalog) {
			assert.match(entry.sha256, /^[a-f0-9]{64}$/);
			assert.ok(getSignalCExtensionDownload(entry).startsWith(`https://github.com/falabellamichael/${entry.repository}/releases/download/v${entry.version}/`));
			assert.ok(entry.asset.endsWith('.vsix'));
		}
	});

	test('search matches names, IDs and keywords without case sensitivity', () => {
		assert.ok(matchesSignalCExtension(signalCExtensionCatalog[0], ' LOCAL ai '));
		assert.ok(matchesSignalCExtension(signalCExtensionCatalog[1], 'falabella.simpletheme'));
		assert.ok(matchesSignalCExtension(signalCExtensionCatalog[2], 'gradient color'));
		assert.ok(matchesSignalCExtension(signalCExtensionCatalog[2], ''));
		assert.ok(!matchesSignalCExtension(signalCExtensionCatalog[1], 'nonexistent'));
	});

	test('verified release installs through VSIX with Agents enablement and removes its download', async () => {
		const services = createServices();
		assert.strictEqual(await installSignalCExtension(listing, services, true), services.installed);
		assert.strictEqual(services.downloads[0], listing.id);
		assert.strictEqual(services.installs.length, 1);
		assert.strictEqual(services.installs[0].enable, true);
		assert.strictEqual(await services.fileService.exists(services.installs[0].uri), false);
	});

	test('mismatched bytes never reach the extension installer', async () => {
		const services = createServices('tampered');
		await assert.rejects(installSignalCExtension(listing, services, false), /checksum/);
		assert.strictEqual(services.installs.length, 0);
		assert.strictEqual((await services.fileService.resolve(URI.joinPath(cacheHome, 'signal-c-marketplace'))).children?.length, 0);
	});

	test('failed installs remove their temporary package and preserve the original error', async () => {
		const error = new Error('Incompatible extension');
		const services = createServices('abc', error);
		await assert.rejects(installSignalCExtension(listing, services, false), failure => failure === error);
		assert.strictEqual(services.installs[0].enable, undefined);
		assert.strictEqual(await services.fileService.exists(services.installs[0].uri), false);
	});

	test('renders our catalog without an external gallery and filters visible listings', async () => {
		const services = createServices();
		const container = document.createElement('div');
		document.body.appendChild(container);
		store.add(toDisposable(() => container.remove()));
		const instantiation = new class extends mock<IInstantiationService>() { }();
		const opener = new class extends mock<IOpenerService>() { }();
		const contextView = new class extends mock<IContextViewService>() { }();
		const widget = store.add(new SignalCExtensionsMarketplace(container, { showSearch: false, enableInAgents: true }, services.extensionsWorkbenchService, instantiation, services.fileService, logService, opener, contextView));
		await services.extensionsWorkbenchService.whenInitialized;
		const rows = () => Array.from(container.querySelectorAll<HTMLElement>('.signal-c-extension-listing')).filter(row => !row.hidden);
		assert.strictEqual(rows().length, 3);
		widget.setQuery('gradient');
		assert.strictEqual(rows().length, 1);
		assert.ok(rows()[0].textContent?.includes('SimpleGradient Studio'));
		widget.setQuery('nonexistent');
		assert.strictEqual(rows().length, 0);
		assert.strictEqual(container.querySelector<HTMLElement>('.signal-c-marketplace-empty')?.hidden, false);
	});

	test('a newer installed extension is recognized and never offered a downgrade', async () => {
		const services = createServices('abc', undefined, '9.0.0');
		services.extensionsWorkbenchService.local.push(services.installed);
		const container = document.createElement('div');
		const widget = store.add(new SignalCExtensionsMarketplace(container, { showSearch: false, enableInAgents: true }, services.extensionsWorkbenchService, new class extends mock<IInstantiationService>() { }(), services.fileService, logService, new class extends mock<IOpenerService>() { }(), new class extends mock<IContextViewService>() { }()));
		await services.extensionsWorkbenchService.whenInitialized;
		const button = widget.element.querySelector<HTMLElement>('.monaco-button');
		assert.strictEqual(button?.textContent, 'Installed');
		assert.strictEqual(button?.getAttribute('aria-disabled'), 'true');
		assert.ok(button?.getAttribute('aria-label')?.startsWith('Installed:'));
	});
});
