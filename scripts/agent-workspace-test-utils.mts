/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServer } from 'node:net';

/** Reserve separate development inspector ports without using a running editor's defaults. */
export async function allocateInspectorArgs(): Promise<string[]> {
	const reservations: { server: ReturnType<typeof createServer>; port: number }[] = [];
	try {
		for (let i = 0; i < 4; i++) {
			const server = createServer();
			await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
			const address = server.address();
			if (!address || typeof address === 'string') { throw new Error('An inspector reservation must have a TCP port'); }
			reservations.push({ server, port: address.port });
		}
		return ['agenthost', 'ptyhost', 'sharedprocess', 'extensions'].map((name, i) => `--inspect-${name}=${reservations[i].port}`);
	} finally {
		await Promise.all(reservations.map(({ server }) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
	}
}
