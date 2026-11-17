/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Render the existing SimpleRAG artwork into native application assets. No artwork is redrawn.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const blue = '#007acc';
const source = await fs.readFile(path.join(root, 'resources/branding/simple-rag-icon.png'));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
const write = async (file: string, bytes: string | Buffer) => fs.writeFile(path.join(root, file), bytes);

try {
	await page.evaluate(async data => {
		const image = new Image();
		image.src = data;
		await image.decode();
		image.id = 'brand-image';
		document.body.append(image);
	}, `data:image/png;base64,${source.toString('base64')}`);

	async function render(width: number, height = width, background = true, installer = false) {
		return page.evaluate(({ width, height, background, installer, blue }) => {
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext('2d');
			const image = document.querySelector<HTMLImageElement>('#brand-image');
			if (!context || !image) { throw new Error('The brand image or canvas context is unavailable.'); }
			if (background) {
				context.fillStyle = blue;
				context.beginPath();
				context.roundRect(0, 0, width, height, installer ? 0 : width * 0.18);
				context.fill();
			}
			const size = Math.min(width, height);
			// Crop transparent margins, then retain breathing room around the unchanged artwork.
			context.drawImage(image, 232, 195, 836, 835, size * 0.09, size * 0.09, size * 0.82, size * 0.82);
			if (installer && height > width * 1.5) {
				context.fillStyle = '#ffffff';
				context.font = `600 ${width * 0.14}px "Segoe UI", sans-serif`;
				context.fillText('Signal-C', width * 0.09, size * 1.25);
				context.font = `${width * 0.065}px "Segoe UI", sans-serif`;
				context.fillText('Signal-Connections', width * 0.09, size * 1.4);
			}
			return { png: canvas.toDataURL('image/png').split(',')[1], pixels: installer ? Array.from(context.getImageData(0, 0, width, height).data) : undefined };
		}, { width, height, background, installer, blue });
	}

	const mark = Buffer.from((await render(512, 512, false)).png, 'base64');
	await write('resources/branding/signal-c-mark.png', mark);
	await write('src/vs/workbench/browser/media/signal-c-mark.png', mark);
	// Embedded PNG keeps SVG-as-image self-contained under browser security restrictions.
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><image width="512" height="512" href="data:image/png;base64,${mark.toString('base64')}"/></svg>\n`;
	for (const file of [
		'src/vs/workbench/browser/media/code-icon.svg',
		'src/vs/sessions/browser/media/vscode-icon.svg',
		'src/vs/sessions/browser/media/sessions-icon.svg',
		'src/vs/sessions/browser/media/sessions-logo-light.svg',
		'src/vs/sessions/browser/media/sessions-logo-dark.svg',
		'src/vs/sessions/contrib/chat/browser/media/letterpress-sessions-light.svg',
		'src/vs/sessions/contrib/chat/browser/media/letterpress-sessions-dark.svg',
		...['light', 'dark', 'hcLight', 'hcDark'].map(theme => `src/vs/workbench/browser/parts/editor/media/letterpress-${theme}.svg`),
	]) { await write(file, svg); }

	const sizes = [16, 24, 32, 48, 64, 70, 128, 150, 192, 256, 512, 1024];
	const icons = new Map<number, Buffer>();
	for (const size of sizes) { icons.set(size, Buffer.from((await render(size)).png, 'base64')); }
	await write('resources/branding/signal-c-icon.png', icons.get(1024)!);
	const pngFiles: [string, number][] = [
		['resources/linux/code.png', 512], ['resources/server/code-192.png', 192], ['resources/server/code-512.png', 512],
		['resources/win32/code_70x70.png', 70], ['resources/win32/code_150x150.png', 150],
	];
	for (const [file, size] of pngFiles) { await write(file, icons.get(size)!); }

	const icoSizes = [16, 24, 32, 48, 64, 128, 256];
	const header = Buffer.alloc(6 + icoSizes.length * 16);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(icoSizes.length, 4);
	let offset = header.length;
	icoSizes.forEach((size, index) => {
		const entry = 6 + index * 16;
		header[entry] = header[entry + 1] = size === 256 ? 0 : size;
		header.writeUInt16LE(1, entry + 4);
		header.writeUInt16LE(32, entry + 6);
		header.writeUInt32LE(icons.get(size)!.length, entry + 8);
		header.writeUInt32LE(offset, entry + 12);
		offset += icons.get(size)!.length;
	});
	const ico = Buffer.concat([header, ...icoSizes.map(size => icons.get(size)!)]);
	for (const file of ['resources/win32/code.ico', 'resources/win32/sessions.ico', 'resources/server/favicon.ico']) { await write(file, ico); }
	const icnsTypes: [string, number][] = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]];
	const chunks = icnsTypes.map(([type, size]) => {
		const chunk = Buffer.alloc(8);
		chunk.write(type);
		chunk.writeUInt32BE(icons.get(size)!.length + 8, 4);
		return Buffer.concat([chunk, icons.get(size)!]);
	});
	const icns = Buffer.alloc(8);
	icns.write('icns');
	icns.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
	await write('resources/darwin/code.icns', Buffer.concat([icns, ...chunks]));

	// Preserve every installer's existing dimensions and DPI variants.
	for (const file of (await fs.readdir(path.join(root, 'resources/win32'))).filter(file => /^inno-(big|small)-\d+\.bmp$/.test(file))) {
		const old = await fs.readFile(path.join(root, 'resources/win32', file));
		const width = old.readInt32LE(18);
		const height = Math.abs(old.readInt32LE(22));
		const { pixels } = await render(width, height, true, true);
		if (!pixels) { throw new Error('The installer bitmap pixels are unavailable.'); }
		const stride = Math.ceil(width * 3 / 4) * 4;
		const bmp = Buffer.alloc(54 + stride * height);
		bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
		bmp.writeInt32LE(width, 18); bmp.writeInt32LE(height, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
		bmp.writeUInt32LE(stride * height, 34);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const src = (y * width + x) * 4;
				const dst = 54 + (height - 1 - y) * stride + x * 3;
				bmp[dst] = pixels[src + 2]; bmp[dst + 1] = pixels[src + 1]; bmp[dst + 2] = pixels[src];
			}
		}
		await write(`resources/win32/${file}`, bmp);
	}
	console.log('Generated Signal-C desktop, web, installer, and transparent in-app assets.');
} finally {
	await browser.close();
}
