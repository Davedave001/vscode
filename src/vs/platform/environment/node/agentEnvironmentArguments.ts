/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { delimiter, resolve } from '../../../base/common/path.js';
import { isWindows, type IProcessEnvironment } from '../../../base/common/platform.js';
import type { NativeParsedArgs } from '../common/argv.js';

/** Restore explicit agent launch paths and normalize the arguments used by later protocol launches. */
export function applyAgentEnvironmentArguments(args: Pick<NativeParsedArgs, 'agent-codex-home' | 'agent-claude-config-dir' | 'agent-cli-fallback-dir'>, environment: IProcessEnvironment, workingDirectory: string, inheritedEnvironment: Readonly<IProcessEnvironment> = environment): void {
	for (const [argument, variable] of [['agent-codex-home', 'CODEX_HOME'], ['agent-claude-config-dir', 'CLAUDE_CONFIG_DIR']] as const) {
		const value = args[argument];
		if (value) {
			const directory = resolve(workingDirectory, value);
			args[argument] = directory;
			environment[variable] = directory;
		}
	}
	const fallback = args['agent-cli-fallback-dir'];
	if (fallback) {
		const directory = resolve(workingDirectory, fallback);
		args['agent-cli-fallback-dir'] = directory;
		const pathKey = Object.keys(inheritedEnvironment).find(key => isWindows ? key.toLowerCase() === 'path' : key === 'PATH') ?? 'PATH';
		const currentPath = inheritedEnvironment[pathKey] ?? '';
		const containsDirectory = currentPath.split(delimiter).some(entry => isWindows ? entry.toLowerCase() === directory.toLowerCase() : entry === directory);
		// Keep separately installed clients first and forward only this explicit fallback, never the entire launcher's environment.
		environment[pathKey] = containsDirectory ? currentPath : currentPath ? `${currentPath}${delimiter}${directory}` : directory;
	}
}
