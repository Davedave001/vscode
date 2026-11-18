/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { extUri, extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { ResourceSet } from '../../../base/common/map.js';
import { Schemas } from '../../../base/common/network.js';
import { ICodeWindow } from '../../window/electron-main/window.js';
import { IResolvedWorkspace, ISingleFolderWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier, IWorkspaceIdentifier } from '../../workspace/common/workspace.js';

interface IWorkspaceWindowMatch {
	readonly window: ICodeWindow;
	readonly workspace: IWorkspaceIdentifier;
}

/** Finds the most recently focused ordinary editor on the handoff's exact host. */
export function findWindowForEmptyHandoff(windows: readonly ICodeWindow[], remoteAuthority: string | undefined): ICodeWindow | undefined {
	return windows.filter(window => window.config && !window.config.isSessionsWindow && !window.isExtensionDevelopmentHost && window.remoteAuthority === remoteAuthority)
		.sort((a, b) => b.lastFocusTime - a.lastFocusTime)[0];
}

export async function findWindowOnFile(windows: ICodeWindow[], fileUri: URI, localWorkspaceResolver: (workspace: IWorkspaceIdentifier) => Promise<IResolvedWorkspace | undefined>): Promise<ICodeWindow | undefined> {

	// First check for windows with workspaces that have a parent folder of the provided path opened
	for (const window of windows) {
		const workspace = window.openedWorkspace;
		if (isWorkspaceIdentifier(workspace)) {
			const resolvedWorkspace = await localWorkspaceResolver(workspace);

			// resolved workspace: folders are known and can be compared with
			if (resolvedWorkspace) {
				if (resolvedWorkspace.folders.some(folder => extUriBiasedIgnorePathCase.isEqualOrParent(fileUri, folder.uri))) {
					return window;
				}
			}

			// unresolved: can only compare with workspace location
			else {
				if (extUriBiasedIgnorePathCase.isEqualOrParent(fileUri, workspace.configPath)) {
					return window;
				}
			}
		}
	}

	// Then go with single folder windows that are parent of the provided file path
	const singleFolderWindowsOnFilePath = windows.filter(window => isSingleFolderWorkspaceIdentifier(window.openedWorkspace) && extUriBiasedIgnorePathCase.isEqualOrParent(fileUri, window.openedWorkspace.uri));
	if (singleFolderWindowsOnFilePath.length) {
		return singleFolderWindowsOnFilePath.sort((windowA, windowB) => -((windowA.openedWorkspace as ISingleFolderWorkspaceIdentifier).uri.path.length - (windowB.openedWorkspace as ISingleFolderWorkspaceIdentifier).uri.path.length))[0];
	}

	return undefined;
}

export function findWindowOnWorkspaceOrFolder(windows: ICodeWindow[], folderOrWorkspaceConfigUri: URI): ICodeWindow | undefined {

	for (const window of windows) {

		// check for workspace config path
		if (isWorkspaceIdentifier(window.openedWorkspace) && extUriBiasedIgnorePathCase.isEqual(window.openedWorkspace.configPath, folderOrWorkspaceConfigUri)) {
			return window;
		}

		// check for folder path
		if (isSingleFolderWorkspaceIdentifier(window.openedWorkspace) && extUriBiasedIgnorePathCase.isEqual(window.openedWorkspace.uri, folderOrWorkspaceConfigUri)) {
			return window;
		}
	}

	return undefined;
}

/** Finds a live editor on the requested host. Exact folder sets take priority over containing workspaces. */
export async function findWindowOnWorkspaceFolders(windows: readonly ICodeWindow[], folders: readonly URI[], remoteAuthority: string | undefined, localWorkspaceResolver: (workspace: IWorkspaceIdentifier) => Promise<IResolvedWorkspace | undefined>, allowAdditionalFolders = false): Promise<IWorkspaceWindowMatch | undefined> {
	const containingMatches: IWorkspaceWindowMatch[] = [];
	for (const window of windows) {
		const workspace = window.openedWorkspace;
		if (!isWorkspaceIdentifier(workspace) || window.config?.isSessionsWindow || window.isExtensionDevelopmentHost || window.remoteAuthority !== remoteAuthority) {
			continue;
		}
		const match: IWorkspaceWindowMatch = { window, workspace: { id: workspace.id, configPath: workspace.configPath } };
		const resolved = await localWorkspaceResolver(workspace);
		if (!resolved || !workspaceMatchesFolders(resolved, folders, remoteAuthority, allowAdditionalFolders)) {
			continue;
		}
		if (resolved.folders.length === folders.length) {
			if (isCurrentEditorWorkspace(match, remoteAuthority)) {
				return match;
			}
		} else {
			containingMatches.push(match);
		}
	}
	// A containing window may have navigated while the remaining workspace files were read.
	return containingMatches.find(match => isCurrentEditorWorkspace(match, remoteAuthority));
}

function isCurrentEditorWorkspace({ window, workspace }: IWorkspaceWindowMatch, remoteAuthority: string | undefined): boolean {
	const current = window.openedWorkspace;
	return isWorkspaceIdentifier(current) && current.id === workspace.id && extUriBiasedIgnorePathCase.isEqual(current.configPath, workspace.configPath)
		&& window.remoteAuthority === remoteAuthority && !window.config?.isSessionsWindow && !window.isExtensionDevelopmentHost;
}

/** Compares folder/host identity; containing-workspace reuse requires an explicit handoff preference. */
export function workspaceMatchesFolders(workspace: IResolvedWorkspace, folders: readonly URI[], remoteAuthority: string | undefined, allowAdditionalFolders = false): boolean {
	if (folders.length === 0 || workspace.transient || workspace.remoteAuthority !== remoteAuthority || (!allowAdditionalFolders && workspace.folders.length !== folders.length)) {
		return false;
	}
	// Only local file paths can use this machine's casing rules; remote providers may be case-sensitive.
	const comparisonKey = (uri: URI) => (remoteAuthority === undefined && uri.scheme === Schemas.file ? extUriBiasedIgnorePathCase : extUri).getComparisonKey(uri);
	const requested = new ResourceSet(folders, comparisonKey);
	const resolved = new ResourceSet(workspace.folders.map(folder => folder.uri), comparisonKey);
	return requested.size === folders.length && resolved.size === workspace.folders.length && (allowAdditionalFolders || resolved.size === requested.size) && [...requested].every(folder => resolved.has(folder));
}

/**
 * Finds the window that opened the path an open request asked for, among the
 * windows the request used. Only resolved paths are passed, so a request whose
 * path doesn't exist finds no window, even when windows from the previous
 * session were restored next to it.
 */
export function findWindowOnRequestedPath(windows: ICodeWindow[], requestedPaths: readonly { readonly workspace?: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier; readonly fileUri?: URI }[], filesOpenedInWindow: ICodeWindow | undefined): ICodeWindow | undefined {
	if (requestedPaths.length !== 1) {
		return undefined;
	}

	const [{ workspace, fileUri }] = requestedPaths;
	if (isWorkspaceIdentifier(workspace)) {
		return findWindowOnWorkspaceOrFolder(windows, workspace.configPath);
	}

	if (isSingleFolderWorkspaceIdentifier(workspace)) {
		return findWindowOnWorkspaceOrFolder(windows, workspace.uri);
	}

	return fileUri ? filesOpenedInWindow : undefined;
}


export function findWindowOnExtensionDevelopmentPath(windows: ICodeWindow[], extensionDevelopmentPaths: string[]): ICodeWindow | undefined {

	const matches = (uriString: string): boolean => {
		return extensionDevelopmentPaths.some(path => extUriBiasedIgnorePathCase.isEqual(URI.file(path), URI.file(uriString)));
	};

	for (const window of windows) {

		// match on extension development path. the path can be one or more paths
		// so we check if any of the paths match on any of the provided ones
		if (window.config?.extensionDevelopmentPath?.some(path => matches(path))) {
			return window;
		}
	}

	return undefined;
}
