/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { acpToolContent, acpToolValue } from '../../node/acp/acpToolContent.js';
import { ToolResultContentType } from '../../common/state/sessionState.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

suite('ACP Tool Content', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('preserves raw JSON values while null and omitted fields do not replace earlier values', () => {
		assert.strictEqual(acpToolValue(undefined), undefined);
		assert.strictEqual(acpToolValue(null), undefined);
		assert.strictEqual(acpToolValue(''), '');
		assert.strictEqual(acpToolValue(false), 'false');
		assert.strictEqual(acpToolValue(0), '0');
		assert.strictEqual(acpToolValue({ path: 'D:/folder/file.md' }), '{\n  "path": "D:/folder/file.md"\n}');
	});
	test('preserves text, images, and embedded resource content without fetching URI references', () => {
		assert.deepStrictEqual(acpToolContent([
			{ type: 'content', content: { type: 'text', text: 'output' } },
			{ type: 'content', content: { type: 'image', data: 'AA==', mimeType: 'image/png' } },
			{ type: 'content', content: { type: 'resource', resource: { uri: 'file:///readme.md', text: '# Heading' } } },
			{ type: 'content', content: { type: 'resource_link', name: 'Reference', uri: 'https://example.com/readme' } },
		]), [
			{ type: ToolResultContentType.Text, text: 'output' },
			{ type: ToolResultContentType.EmbeddedResource, data: 'AA==', contentType: 'image/png' },
			{ type: ToolResultContentType.Text, text: 'file:///readme.md\n# Heading' },
			{ type: ToolResultContentType.Text, text: 'Reference: https://example.com/readme' },
		]);
	});
	test('represents a reported diff as content and ignores malformed blocks', () => {
		assert.deepStrictEqual(acpToolContent([null, { type: 'content' }, { type: 'diff', path: '/file.ts', oldText: null, newText: 'new file' }]), [{ type: ToolResultContentType.Text, text: '/file.ts\n---\n\n+++\nnew file' }]);
	});
});
