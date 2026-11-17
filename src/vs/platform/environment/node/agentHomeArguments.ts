/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { resolve } from '../../../base/common/path.js';
import type { IProcessEnvironment } from '../../../base/common/platform.js';
import type { NativeParsedArgs } from '../common/argv.js';

/** Restore explicit agent homes for this instance and normalize the arguments used by later protocol launches. */
export function applyAgentHomeArguments(args: Pick<NativeParsedArgs, 'agent-codex-home' | 'agent-claude-config-dir'>, environment: IProcessEnvironment, workingDirectory: string): void {
	for (const [argument, variable] of [['agent-codex-home', 'CODEX_HOME'], ['agent-claude-config-dir', 'CLAUDE_CONFIG_DIR']] as const) {
		const value = args[argument];
		if (value) {
			const directory = resolve(workingDirectory, value);
			args[argument] = directory;
			environment[variable] = directory;
		}
	}
}
