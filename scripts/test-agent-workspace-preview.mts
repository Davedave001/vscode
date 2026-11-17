/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext } from 'playwright';

// Run against the existing --mock --workspace-preview server, in a fresh browser context.
const preview = new URL(process.argv[2] ?? 'http://127.0.0.1:8098/');
assert.ok(preview.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(preview.hostname), 'Use a loopback HTTP preview server');
assert.ok(!preview.username && !preview.password && !preview.search && !preview.hash && preview.pathname === '/', 'Use the preview root without credentials, query, or fragment');
const response = await fetch(preview, { redirect: 'error', signal: AbortSignal.timeout(10000) });
assert.ok(response.ok, 'The preview server must be running');
const shell = await response.text();
assert.ok(shell.includes('id="agents"') && shell.includes('agent-workspace.switch-mode'), 'Start the server with --mock --workspace-preview');

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts = join(repoRoot, '.build', 'agent-workspace-preview-smoke', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
await mkdir(artifacts, { recursive: true });
const report = {
	conversationCompleted: false, composerDraftRetained: false, unsavedBufferRetained: false,
	savedFileSurvivedReload: false, deferredAgentsLoaded: false, pageErrors: [] as string[],
};
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
const deadline = setTimeout(() => { void browser.close(); }, 180000);
let context: BrowserContext | undefined;
let stage = 'starting';
try {
	context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, serviceWorkers: 'block' });
	// Never send this mock workflow to external HTTP services, or reuse a desktop/browser profile.
	await context.route('**/*', route => {
		const url = new URL(route.request().url());
		return url.origin === preview.origin || ['blob:', 'data:'].includes(url.protocol) ? route.continue() : route.abort();
	});
	const page = await context.newPage();
	page.setDefaultTimeout(15000);
	page.on('pageerror', error => report.pageErrors.push(error.message));
	const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
	const agents = page.frameLocator('#agents');
	const ide = page.frameLocator('#ide');
	const responseText = 'This project has a simple structure with a main entry point and utility functions.';
	const bufferText = '// Signal-C unsaved continuity marker';
	const draftText = 'Signal-C follow-up draft kept across modes';
	const savedText = 'Signal-C saved continuity marker';
	const chatInput = agents.locator('.interactive-input-part .monaco-editor');
	const bufferLine = ide.getByRole('code').getByText(bufferText, { exact: false });
	const activeDirtyTab = ide.locator('.tabs-container .tab.active.dirty');
	try {
		stage = 'mock conversation';
		await page.goto(preview.href, { waitUntil: 'domcontentloaded' });
		assert.equal(await page.locator('#ide').count(), 0, 'IDE startup must remain lazy');
		await agents.getByText('Mock GPT', { exact: true }).waitFor({ timeout: 45000 });
		await chatInput.click();
		await page.keyboard.type('explain this project for the Signal-C continuity check');
		await page.keyboard.press('Enter');
		await agents.getByText(responseText, { exact: false }).waitFor({ timeout: 30000 });
		report.conversationCompleted = true;
		console.log('Completed the mock conversation');
		await chatInput.click();
		await page.keyboard.type(draftText);

		stage = 'creating an unsaved IDE buffer';
		await agents.getByRole('switch', { name: 'IDE mode', exact: true }).click();
		await page.waitForURL(url => url.searchParams.get('mode') === 'ide');
		await ide.getByRole('tree').getByText('README.md', { exact: true }).waitFor({ timeout: 45000 });
		await ide.locator('body').click({ position: { x: 500, y: 400 } });
		await page.keyboard.press(`${modifier}+n`);
		await ide.locator('.monaco-editor').first().waitFor({ state: 'visible' });
		await page.keyboard.type(bufferText);
		await bufferLine.waitFor();
		await activeDirtyTab.waitFor();
		await page.screenshot({ path: join(artifacts, 'ide-unsaved.png') });

		stage = 'returning to the conversation';
		await page.getByRole('switch', { name: 'IDE mode', exact: true }).click();
		await page.waitForURL(url => !url.searchParams.has('mode'));
		await agents.getByText(responseText, { exact: false }).waitFor();
		assert.ok((await chatInput.innerText()).replaceAll('\u00a0', ' ').includes(draftText), 'The original composer draft must remain');
		report.composerDraftRetained = true;
		await page.screenshot({ path: join(artifacts, 'agents-returned.png') });
		console.log('Retained the conversation and composer draft');

		stage = 'returning to the unsaved buffer';
		await agents.getByRole('switch', { name: 'IDE mode', exact: true }).click();
		await page.waitForURL(url => url.searchParams.get('mode') === 'ide');
		await bufferLine.waitFor();
		await activeDirtyTab.waitFor();
		report.unsavedBufferRetained = true;
		console.log('Retained the unsaved buffer after switching twice');

		stage = 'saving the sample file';
		await ide.getByRole('tree').getByText('README.md', { exact: true }).dblclick();
		await ide.getByRole('code').getByText('# Mock Repository', { exact: true }).waitFor();
		await ide.locator('.monaco-editor').first().click();
		await page.keyboard.press(`${modifier}+a`);
		await page.keyboard.type(`# ${savedText}\n\nSaved through the real IDE editor.\n`);
		// The workbench may autosave; request a save and wait for a clean active tab.
		await page.keyboard.press(`${modifier}+s`);
		await activeDirtyTab.waitFor({ state: 'hidden' });
		console.log('Saved the sample README');

		stage = 'reloading the saved file';
		await page.reload({ waitUntil: 'domcontentloaded' });
		assert.equal(await page.locator('#agents').getAttribute('src'), null, 'A direct IDE reload must defer the hidden Agents workbench');
		await ide.getByRole('tree').getByText('README.md', { exact: true }).waitFor({ timeout: 45000 });
		await ide.getByRole('tree').getByText('README.md', { exact: true }).dblclick();
		await ide.getByRole('code').getByText(savedText, { exact: false }).waitFor();
		report.savedFileSurvivedReload = true;
		await page.screenshot({ path: join(artifacts, 'saved-after-reload.png') });
		console.log('Retained the saved file after reloading');

		stage = 'opening deferred Agents after an IDE reload';
		await page.getByRole('switch', { name: 'IDE mode', exact: true }).click();
		await page.waitForURL(url => !url.searchParams.has('mode'));
		await agents.getByText('Mock GPT', { exact: true }).waitFor({ timeout: 45000 });
		report.deferredAgentsLoaded = true;
		await page.screenshot({ path: join(artifacts, 'agents-after-ide-reload.png') });
		assert.deepEqual(report.pageErrors, [], 'The workflow must not raise page errors');
		console.log('Opened the deferred Agents workbench after an IDE reload');
	} catch (error) {
		await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
		await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ stage, message: error instanceof Error ? error.message : String(error) }, null, 2));
		throw error;
	}
} finally {
	clearTimeout(deadline);
	await context?.close();
	await browser.close();
	await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
	console.log(`Artifacts: ${artifacts}`);
}
