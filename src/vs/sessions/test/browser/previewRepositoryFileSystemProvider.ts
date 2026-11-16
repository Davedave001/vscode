/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { createFileSystemProviderError, FileSystemProviderCapabilities, FileSystemProviderErrorCode, IFileSystemProviderWithFileReadWriteCapability } from '../../../platform/files/common/files.js';

/** A read-only demo repository view over the same files that the preview IDE edits. */
export class PreviewRepositoryFileSystemProvider implements IFileSystemProviderWithFileReadWriteCapability {
	readonly capabilities = FileSystemProviderCapabilities.Readonly | FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;
	readonly onDidChangeCapabilities = Event.None;
	readonly onDidChangeFile;

	constructor(
		private readonly provider: IFileSystemProviderWithFileReadWriteCapability,
		private readonly repositoryRoot: URI,
		private readonly workspaceRoot: URI,
	) {
		this.onDidChangeFile = Event.map(provider.onDidChangeFile, changes => changes
			.filter(change => this.contains(workspaceRoot, change.resource))
			.map(change => ({ type: change.type, resource: repositoryRoot.with({ path: repositoryRoot.path + change.resource.path.slice(workspaceRoot.path.length) }) })));
	}

	private contains(root: URI, resource: URI): boolean {
		return resource.scheme === root.scheme && resource.authority === root.authority && !resource.query && !resource.fragment
			&& (resource.path === root.path || resource.path.startsWith(root.path + '/'));
	}

	private toWorkspace(resource: URI): URI {
		if (!this.contains(this.repositoryRoot, resource)) {
			throw createFileSystemProviderError('Only the preview sample repository is available.', FileSystemProviderErrorCode.FileNotFound);
		}
		return this.workspaceRoot.with({ path: this.workspaceRoot.path + resource.path.slice(this.repositoryRoot.path.length) });
	}

	stat(resource: URI) { return this.provider.stat(this.toWorkspace(resource)); }
	readdir(resource: URI) { return this.provider.readdir(this.toWorkspace(resource)); }
	readFile(resource: URI) { return this.provider.readFile(this.toWorkspace(resource)); }
	watch() { return Disposable.None; }

	private readonlyError(): never {
		throw createFileSystemProviderError('Edit sample files in IDE mode.', FileSystemProviderErrorCode.NoPermissions);
	}
	async writeFile(): Promise<void> { this.readonlyError(); }
	async mkdir(): Promise<void> { this.readonlyError(); }
	async delete(): Promise<void> { this.readonlyError(); }
	async rename(): Promise<void> { this.readonlyError(); }
	dispose(): void { /* The workspace registration owns the shared provider. */ }
}
