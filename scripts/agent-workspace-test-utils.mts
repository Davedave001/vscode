/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomInt } from 'node:crypto';
import { createServer } from 'node:net';

/** Reserve separate development inspector ports without using a running editor's defaults. */
export async function allocateInspectorArgs(): Promise<string[]> {
	const reservations: { server: ReturnType<typeof createServer>; port: number }[] = [];
	try {
		const names = ['agenthost', 'ptyhost', 'sharedprocess', 'extensions'];
		for (const name of names) {
			const server = createServer();
			for (let attempt = 0; ; attempt++) {
				// Multiple extension hosts probe up to nine offsets of 2048 from this port.
				const port = name === 'extensions' ? randomInt(12000, 45000) : 0;
				try {
					await new Promise<void>((resolve, reject) => {
						server.once('error', reject);
						server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
					});
					break;
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (attempt >= 9 || (code !== 'EADDRINUSE' && code !== 'EACCES')) {
						throw error;
					}
				}
			}
			const address = server.address();
			if (!address || typeof address === 'string') { throw new Error('An inspector reservation must have a TCP port'); }
			reservations.push({ server, port: address.port });
		}
		return names.map((name, i) => `--inspect-${name}=${reservations[i].port}`);
	} finally {
		await Promise.all(reservations.map(({ server }) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
	}
}
