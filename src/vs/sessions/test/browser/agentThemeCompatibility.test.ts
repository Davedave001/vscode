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
import { agentsActivityBarBackground, agentsActivityBarBorder, agentsChatInputBackground, agentsChatInputForeground, agentsDetailBackground, agentsPanelBackground, agentsPanelBorder, agentsPanelForeground } from '../../../workbench/common/agentsColors.js';
import '../../browser/media/style.css';
import '../../browser/media/workbench.css';

suite('Sessions - Extension theme compatibility', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('inherits conventional theme colors for chat cards, details, composer, frames and activity bar', () => {
		const theme = ColorThemeData.createUnloadedTheme('vs-dark', {});
		const pairs = [
			[agentsPanelBackground, 'panel.background'], [agentsPanelForeground, 'foreground'],
			[agentsDetailBackground, 'sideBar.background'], [agentsPanelBorder, 'panel.border'],
			[agentsActivityBarBackground, 'activityBar.background'], [agentsActivityBarBorder, 'activityBar.border'],
			[agentsChatInputBackground, 'input.background'], [agentsChatInputForeground, 'input.foreground'],
		] as const;
		for (const palette of [
			{ 'panel.background': '#1a1b26', foreground: '#c0caf5', 'sideBar.background': '#16161e', 'panel.border': '#1f2335', 'activityBar.background': '#13141c', 'activityBar.border': '#24283b', 'input.background': '#1f2335', 'input.foreground': '#a9b1d6' },
			{ 'panel.background': '#fdf6e3', foreground: '#384c54', 'sideBar.background': '#eee8d5', 'panel.border': '#93a1a1', 'activityBar.background': '#e4ddc8', 'activityBar.border': '#839496', 'input.background': '#e8e1cc', 'input.foreground': '#586e75' },
		]) {
			theme.setCustomColors(palette);
			for (const [agent, standard] of pairs) {
				assert.strictEqual(theme.getColor(agent)?.toString(), theme.getColor(standard)?.toString(), `${agent} should inherit ${standard}`);
			}
		}
		theme.setCustomColors({ 'panel.background': '#112233', 'agentsPanel.background': '#445566', 'sideBar.background': '#778899', 'agentsDetail.background': '#aabbcc' });
		assert.strictEqual(theme.getColor(agentsPanelBackground)?.toString(), '#445566');
		assert.strictEqual(theme.getColor(agentsDetailBackground)?.toString(), '#aabbcc');
	});

	test('keeps sidebar, menu and picker surfaces on their theme colors across palette changes', () => {
		const root = append(mainWindow.document.body, $('.monaco-workbench.agent-sessions-workbench.vs-dark.dock-detail-panel'));
		const style = append(mainWindow.document.head, $('style'));
		store.add(toDisposable(() => { root.remove(); style.remove(); }));
		const surfaces = [
			append(root, $('.part.sidebar')),
			append(root, $('.action-widget')),
			append(root, $('.context-view.monaco-menu-container')),
			append(root, $('.quick-input-widget')),
			append(append(append(root, $('.part.auxiliarybar')), $('.content')), $('.pane-body')),
		];
		const theme = ColorThemeData.createUnloadedTheme('vs-dark', {});
		const read = () => surfaces.map(element => getWindow(element).getComputedStyle(element).backgroundColor);
		for (const [colors, expected] of [
			[{ 'editor.background': '#1a1b26', 'panel.background': '#1a1b26', 'sideBar.background': '#16161e', 'menu.background': '#202132', 'quickInput.background': '#242538' }, ['rgb(22, 22, 30)', 'rgb(32, 33, 50)', 'rgb(32, 33, 50)', 'rgb(36, 37, 56)', 'rgb(22, 22, 30)']],
			[{ 'editor.background': '#fafafa', 'panel.background': '#fafafa', 'sideBar.background': '#eeeeff', 'menu.background': '#ddddff', 'quickInput.background': '#ccccff' }, ['rgb(238, 238, 255)', 'rgb(221, 221, 255)', 'rgb(221, 221, 255)', 'rgb(204, 204, 255)', 'rgb(238, 238, 255)']],
		] as const) {
			theme.setCustomColors(colors);
			style.textContent = generateColorThemeCSS(theme, '.agent-sessions-workbench').code;
			assert.deepStrictEqual(read(), expected);
		}
	});
});
