/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute } from '../../../../base/common/path.js';
import { basename, dirname, isEqual, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';

/** What a local folder is a checkout of, read from its `.git` (see {@link readFolderGitCheckout}). */
export interface IFolderGitCheckout {
	/** The git repository: the folder itself, or the main checkout of a worktree. */
	readonly repository: URI;
	/** For a worktree, its entry in the repository's `.git/worktrees`, which its `.git` file names. */
	readonly worktreeGitDir?: URI;
}

/**
 * The directory named by a folder's `.git` entry. For a marker file, its path is relative to that folder.
 */
export async function readFolderGitDirectory(fileService: IFileService, folder: URI): Promise<{ uri: URI; isSeparate: boolean } | undefined> {
	const dotGit = joinPath(folder, '.git');
	let isDirectory: boolean;
	try {
		isDirectory = (await fileService.stat(dotGit)).isDirectory;
	} catch (error) {
		if (error instanceof Error && toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND) {
			return undefined;
		}
		throw error;
	}
	if (isDirectory) {
		return { uri: dotGit, isSeparate: false };
	}
	const content = (await fileService.readFile(dotGit, { limits: { size: 8 * 1024 } })).value.toString();
	const gitdir = /^gitdir:\s*(?<path>.+?)\s*$/m.exec(content)?.groups?.path;
	return gitdir ? { uri: isAbsolute(gitdir) ? URI.file(gitdir) : joinPath(folder, gitdir), isSeparate: true } : undefined;
}

/**
 * The git repository that a local folder is a checkout of, read from its `.git`: the folder itself when `.git` is a
 * directory, and the main checkout when `.git` is the file of a worktree (`gitdir: <repository>/.git/worktrees/<name>`).
 * `undefined` for a folder without `.git`, or whose `.git` names no worktree, such as a submodule's. Throws when `.git`
 * exists but cannot be read.
 */
export async function readFolderGitCheckout(fileService: IFileService, folder: URI): Promise<IFolderGitCheckout | undefined> {
	const gitDirectory = await readFolderGitDirectory(fileService, folder);
	if (!gitDirectory) {
		return undefined;
	}
	if (!gitDirectory.isSeparate) {
		return { repository: folder };
	}
	const worktreeGitDir = gitDirectory.uri;
	const worktreesDir = dirname(worktreeGitDir);
	const commonGitDir = dirname(worktreesDir);
	return basename(worktreesDir) === 'worktrees' && basename(commonGitDir) === '.git' && !isEqual(commonGitDir, worktreesDir)
		? { repository: dirname(commonGitDir), worktreeGitDir }
		: undefined;
}
