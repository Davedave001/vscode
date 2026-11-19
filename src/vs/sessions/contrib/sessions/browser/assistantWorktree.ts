/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { resolve } from '../../../../base/common/path.js';
import { dirname, extUriBiasedIgnorePathCase, normalizePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { readFolderGitDirectory } from '../../../../workbench/services/workspaces/common/gitFolderCheckout.js';

export interface IAssistantWorktree {
	readonly uri: URI;
	readonly label: string;
	readonly identity?: IAssistantWorktreeIdentity;
}

interface IAssistantWorktreeIdentity {
	readonly gitDirectory: URI;
	readonly createdAt: number;
}

const gitPathFileLimit = { limits: { size: 8 * 1024 } };

async function readGitPathFile(fileService: IFileService, resource: URI): Promise<string> {
	return (await fileService.readFile(resource, gitPathFileLimit)).value.toString().replace(/\r?\n$/, '');
}

async function realDirectory(fileService: IFileService, resource: URI): Promise<URI> {
	return normalizePath(await fileService.realpath(resource) ?? resource);
}

/** Resolve the checkout's current Git directory, including Git's relative worktree pointers. */
export async function readAssistantWorktreeIdentity(fileService: IFileService, worktree: URI): Promise<IAssistantWorktreeIdentity | undefined> {
	try {
		const marker = await readFolderGitDirectory(fileService, worktree);
		if (!marker) { return undefined; }
		const gitDirectory = await realDirectory(fileService, marker.uri);
		const stat = await fileService.stat(gitDirectory);
		if (!stat.isDirectory || !Number.isFinite(stat.ctime)) { return undefined; }
		if (marker.isSeparate && await fileService.exists(URI.joinPath(gitDirectory, 'commondir'))) {
			const path = await readGitPathFile(fileService, URI.joinPath(gitDirectory, 'gitdir'));
			if (!path || /[\r\n]/.test(path)) { return undefined; }
			const backlink = URI.file(resolve(gitDirectory.fsPath, path));
			if (!extUriBiasedIgnorePathCase.isEqual(await realDirectory(fileService, dirname(backlink)), await realDirectory(fileService, worktree))
				|| !extUriBiasedIgnorePathCase.isEqual(await realDirectory(fileService, backlink), await realDirectory(fileService, URI.joinPath(worktree, '.git')))) {
				return undefined;
			}
		}
		return { gitDirectory, createdAt: stat.ctime };
	} catch {
		// The checkout might have been moved or removed while it was being checked.
	}
	return undefined;
}

/** Find the Git directory that owns the list, including lists opened from a linked or bare checkout. */
export async function readAssistantCommonGitDirectory(fileService: IFileService, repository: URI): Promise<URI | undefined> {
	const identity = await readAssistantWorktreeIdentity(fileService, repository);
	if (!identity && (!await fileService.exists(URI.joinPath(repository, 'HEAD')) || !await fileService.exists(URI.joinPath(repository, 'objects')))) { return undefined; }
	const directory = identity?.gitDirectory ?? await realDirectory(fileService, repository);
	const commonFile = URI.joinPath(directory, 'commondir');
	if (!await fileService.exists(commonFile)) { return directory; }
	const commonPath = await readGitPathFile(fileService, commonFile);
	if (!commonPath || /[\r\n]/.test(commonPath)) { return undefined; }
	const commonDirectory = URI.file(resolve(directory.fsPath, commonPath));
	return realDirectory(fileService, commonDirectory);
}
