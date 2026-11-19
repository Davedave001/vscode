/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';
import { IDownloadService } from '../../download/common/download.js';
import { IEnvironmentService } from '../../environment/common/environment.js';
import { IFileService } from '../../files/common/files.js';
import { ILogService } from '../../log/common/log.js';
import { getSignalCExtensionDownload, ISignalCExtensionDownloadService, signalCExtensionCatalog } from '../common/signalCExtensionCatalog.js';

/** GitHub release redirects are downloaded in the shared Node process, outside renderer CORS. */
export class SignalCExtensionDownloadService implements ISignalCExtensionDownloadService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IDownloadService private readonly downloadService: IDownloadService,
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@ILogService private readonly logService: ILogService,
	) { }

	async download(id: string): Promise<URI> {
		const listing = signalCExtensionCatalog.find(entry => entry.id === id);
		if (!listing) {
			throw new Error(localize('signalC.catalog.unknownExtension', "This extension is not in the Signal-C Marketplace catalog."));
		}
		const directory = joinPath(this.environmentService.cacheHome, 'signal-c-marketplace');
		const target = joinPath(directory, `${generateUuid()}.vsix`);
		await this.fileService.createFolder(directory);
		try {
			await this.downloadService.download(URI.parse(getSignalCExtensionDownload(listing)), target, 'signalCExtensionsMarketplace');
			return target;
		} catch (error) {
			try {
				if (await this.fileService.exists(target)) {
					await this.fileService.del(target);
				}
			} catch (cleanupError) {
				this.logService.warn('Unable to remove incomplete Signal-C Marketplace download', cleanupError);
			}
			throw error;
		}
	}
}
