/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append, getWindow } from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { ColorThemeData } from '../../../workbench/services/themes/common/colorThemeData.js';
import { generateColorThemeCSS } from '../../../workbench/services/themes/browser/colorThemeCss.js';
import '../../browser/media/style.css';
import '../../browser/media/workbench.css';

suite('Sessions - Extension theme compatibility', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps sidebar, menu and picker surfaces on their theme colors across palette changes', () => {
		const root = append(mainWindow.document.body, $('.monaco-workbench.agent-sessions-workbench.vs-dark'));
		const style = append(mainWindow.document.head, $('style'));
		store.add(toDisposable(() => { root.remove(); style.remove(); }));
		const surfaces = [
			append(root, $('.part.sidebar')),
			append(root, $('.action-widget')),
			append(root, $('.context-view.monaco-menu-container')),
			append(root, $('.quick-input-widget')),
		];
		const theme = ColorThemeData.createUnloadedTheme('vs-dark', {});
		const read = () => surfaces.map(element => getWindow(element).getComputedStyle(element).backgroundColor);
		for (const [colors, expected] of [
			[{ 'editor.background': '#1a1b26', 'sideBar.background': '#16161e', 'menu.background': '#202132', 'quickInput.background': '#242538' }, ['rgb(22, 22, 30)', 'rgb(32, 33, 50)', 'rgb(32, 33, 50)', 'rgb(36, 37, 56)']],
			[{ 'editor.background': '#fafafa', 'sideBar.background': '#eeeeff', 'menu.background': '#ddddff', 'quickInput.background': '#ccccff' }, ['rgb(238, 238, 255)', 'rgb(221, 221, 255)', 'rgb(221, 221, 255)', 'rgb(204, 204, 255)']],
		] as const) {
			theme.setCustomColors(colors);
			style.textContent = generateColorThemeCSS(theme, '.agent-sessions-workbench').code;
			assert.deepStrictEqual(read(), expected);
		}
	});
});
