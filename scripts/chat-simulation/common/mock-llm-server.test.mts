/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { startServer } = require('./mock-llm-server.ts') as typeof import('./mock-llm-server.ts');

test('model catalog supports both chat clients and the editor proxy model consumer', async () => {
	const server = await startServer(0, { logger: () => {} });
	try {
		const response = await fetch(`${server.url}/models`);
		assert.equal(response.status, 200);
		const catalog = await response.json() as { data: { id: string }[]; models: { serviceType: string }[] };
		assert.ok(catalog.data.some(model => model.id === 'gpt-5.3-codex'), 'The native runtime default chat model must remain available');
		assert.deepEqual(catalog.models.filter(model => model.serviceType === 'NESChat'), [], 'The fixture advertises no inline edit models');
		assert.deepEqual(catalog.models.filter(model => model.serviceType === 'CursorJumpChat'), []);
		assert.deepEqual(catalog.models.filter(model => model.serviceType === 'InstantApplyChat'), []);
	} finally {
		await server.close();
	}
});
