/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/signalCExtensionsMarketplace.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isWeb } from '../../../../base/common/platform.js';
import { gte } from '../../../../base/common/semver/semver.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IExtension, IExtensionsWorkbenchService } from '../common/extensions.js';
import { getSignalCExtensionRepository, ISignalCExtensionDownloadService, ISignalCExtensionListing, matchesSignalCExtension, signalCExtensionCatalog } from '../../../../platform/extensionManagement/common/signalCExtensionCatalog.js';

interface ISignalCExtensionInstallServices {
	readonly downloadService: ISignalCExtensionDownloadService;
	readonly fileService: IFileService;
	readonly extensionsWorkbenchService: IExtensionsWorkbenchService;
	readonly logService: ILogService;
}

/** Downloads an exact release, checks its pinned digest, and uses the normal VSIX installation path. */
export async function installSignalCExtension(listing: ISignalCExtensionListing, services: ISignalCExtensionInstallServices, enableInAgents: boolean): Promise<IExtension> {
	const vsix = await services.downloadService.download(listing.id);
	try {
		const contents = await services.fileService.readFile(vsix);
		const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(contents.value.buffer));
		const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
		if (actual !== listing.sha256) {
			throw new Error(localize('signalC.catalog.integrityError', "The downloaded package for {0} did not match its published catalog checksum. Installation was stopped.", listing.name));
		}
		return await services.extensionsWorkbenchService.install(vsix, enableInAgents ? { enable: true } : undefined);
	} finally {
		try {
			if (await services.fileService.exists(vsix)) {
				await services.fileService.del(vsix);
			}
		} catch (error) {
			services.logService.warn('Unable to remove Signal-C Marketplace download', error);
		}
	}
}

interface ISignalCExtensionsMarketplaceOptions {
	readonly showSearch: boolean;
	readonly enableInAgents: boolean;
	readonly onDidInstall?: (extension: IExtension) => void;
}

interface IListingRow {
	readonly listing: ISignalCExtensionListing;
	readonly element: HTMLElement;
	readonly button: Button;
	readonly error: HTMLElement;
}

/** Shared first-party catalog for the Extensions sidebar and the Agents window. */
export class SignalCExtensionsMarketplace extends Disposable {
	readonly element: HTMLElement;
	private readonly rows: IListingRow[] = [];
	private readonly installing = new Set<string>();
	private readonly empty: HTMLElement;

	constructor(
		container: HTMLElement,
		private readonly options: ISignalCExtensionsMarketplaceOptions,
		@IExtensionsWorkbenchService private readonly extensionsWorkbenchService: IExtensionsWorkbenchService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IOpenerService openerService: IOpenerService,
		@IContextViewService contextViewService: IContextViewService,
	) {
		super();
		this.element = DOM.append(container, DOM.$('section.signal-c-extensions-marketplace'));
		this.element.setAttribute('aria-label', localize('signalC.catalog.title', "Signal-C Marketplace"));
		DOM.append(this.element, DOM.$('h3')).textContent = localize('signalC.catalog.title', "Signal-C Marketplace");
		DOM.append(this.element, DOM.$('p.signal-c-marketplace-description')).textContent = localize('signalC.catalog.description', "Extensions from Signal-C, installed directly from our GitHub releases.");
		if (options.showSearch) {
			const search = this._register(new InputBox(this.element, contextViewService, {
				inputBoxStyles: defaultInputBoxStyles,
				placeholder: localize('signalC.catalog.search', "Search Signal-C extensions..."),
				ariaLabel: localize('signalC.catalog.search', "Search Signal-C extensions..."),
			}));
			this._register(search.onDidChange(query => this.setQuery(query)));
		}
		const list = DOM.append(this.element, DOM.$('div.signal-c-marketplace-list'));
		for (const listing of signalCExtensionCatalog) {
			const element = DOM.append(list, DOM.$('article.signal-c-extension-listing'));
			const title = DOM.append(element, DOM.$('div.signal-c-extension-title'));
			const name = DOM.append(title, DOM.$('strong'));
			name.textContent = listing.name;
			const button = this._register(new Button(title, { ...defaultButtonStyles, small: true }));
			button.element.setAttribute('aria-label', localize('signalC.catalog.installLabel', "Install {0}", listing.name));
			DOM.append(element, DOM.$('p.signal-c-extension-description')).textContent = listing.description;
			const details = DOM.append(element, DOM.$('div.signal-c-extension-details'));
			DOM.append(details, DOM.$('span')).textContent = `${listing.id} · v${listing.version}`;
			const source = DOM.append(details, DOM.$('a', { href: getSignalCExtensionRepository(listing) }));
			source.textContent = localize('signalC.catalog.source', "Source on GitHub");
			this._register(DOM.addDisposableListener(source, DOM.EventType.CLICK, event => {
				event.preventDefault();
				void openerService.open(URI.parse(getSignalCExtensionRepository(listing))).catch(error => logService.error(error));
			}));
			const error = DOM.append(element, DOM.$('p.signal-c-extension-error', { role: 'status' }));
			error.hidden = true;
			const row = { listing, element, button, error };
			this.rows.push(row);
			this._register(button.onDidClick(() => { void this.install(row); }));
		}
		this.empty = DOM.append(list, DOM.$('p.signal-c-marketplace-empty', { role: 'status' }));
		this.empty.textContent = localize('signalC.catalog.empty', "No Signal-C extensions match your search.");
		this.empty.hidden = true;
		this._register(extensionsWorkbenchService.onChange(() => this.refresh()));
		void extensionsWorkbenchService.whenInitialized.then(() => {
			if (!this._store.isDisposed) {
				this.refresh();
			}
		}).catch(error => logService.error(error));
		this.refresh();
	}

	setQuery(query: string): void {
		for (const row of this.rows) {
			row.element.hidden = !matchesSignalCExtension(row.listing, query);
		}
		this.empty.hidden = this.rows.some(row => !row.element.hidden);
	}

	private refresh(): void {
		for (const row of this.rows) {
			const installed = this.extensionsWorkbenchService.local.find(extension => extension.local && extension.identifier.id.toLowerCase() === row.listing.id);
			const busy = this.installing.has(row.listing.id);
			const current = installed && gte(installed.version, row.listing.version);
			row.button.label = isWeb ? localize('signalC.catalog.desktopOnly', "Desktop Only") : busy ? localize('signalC.catalog.installing', "Installing...")
				: current ? localize('signalC.catalog.installed', "Installed")
					: installed ? localize('signalC.catalog.update', "Update") : localize('signalC.catalog.install', "Install");
			row.button.element.setAttribute('aria-label', localize('signalC.catalog.actionLabel', "{0}: {1}", row.button.label, row.listing.name));
			row.button.enabled = !isWeb && !busy && !current;
		}
	}

	private async install(row: IListingRow): Promise<void> {
		if (!row.button.enabled || this.installing.has(row.listing.id)) {
			return;
		}
		this.installing.add(row.listing.id);
		row.error.hidden = true;
		this.refresh();
		try {
			const installed = await installSignalCExtension(row.listing, {
				downloadService: this.instantiationService.invokeFunction(accessor => accessor.get(ISignalCExtensionDownloadService)),
				fileService: this.fileService,
				extensionsWorkbenchService: this.extensionsWorkbenchService,
				logService: this.logService,
			}, this.options.enableInAgents);
			if (!this._store.isDisposed) {
				this.options.onDidInstall?.(installed);
			}
		} catch (error) {
			this.logService.error(error);
			if (!this._store.isDisposed) {
				row.error.textContent = getErrorMessage(error);
				row.error.hidden = false;
			}
		} finally {
			this.installing.delete(row.listing.id);
			if (!this._store.isDisposed) {
				this.refresh();
			}
		}
	}
}

/** The first-party marketplace remains available even when no external gallery is configured. */
export class SignalCExtensionsMarketplaceView extends ViewPane {
	static readonly ID = 'workbench.views.extensions.signalCMarketplace';
	private marketplace: SignalCExtensionsMarketplace | undefined;
	private query = '';

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.marketplace = this._register(this.instantiationService.createInstance(SignalCExtensionsMarketplace, container, { showSearch: false, enableInAgents: false }));
		this.marketplace.setQuery(this.query);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.marketplace) {
			this.marketplace.element.style.height = `${height}px`;
		}
	}

	setQuery(query: string): void {
		this.query = query;
		this.marketplace?.setQuery(query);
	}
}
