/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolResultContentType, type ToolResultContent } from '../../common/state/sessionState.js';
import { isAcpRecord } from './acpClient.js';

/** Null and omission leave previously reported ACP input/output unchanged. */
export function acpToolValue(value: unknown): string | undefined {
	return value === undefined || value === null ? undefined : typeof value === 'string' ? value : JSON.stringify(value, undefined, 2);
}

/** Convert reported content without fetching resources or applying reported file changes. */
export function acpToolContent(value: unknown): ToolResultContent[] {
	if (!Array.isArray(value)) { return []; }
	const result: ToolResultContent[] = [];
	for (const item of value) {
		if (!isAcpRecord(item)) { continue; }
		if (item.type === 'diff' && typeof item.path === 'string' && typeof item.newText === 'string') {
			result.push({ type: ToolResultContentType.Text, text: `${item.path}\n---\n${typeof item.oldText === 'string' ? item.oldText : ''}\n+++\n${item.newText}` });
			continue;
		}
		if (item.type !== 'content' || !isAcpRecord(item.content)) { continue; }
		const content = item.content;
		if (content.type === 'text' && typeof content.text === 'string') {
			result.push({ type: ToolResultContentType.Text, text: content.text });
		} else if (content.type === 'image' && typeof content.data === 'string' && typeof content.mimeType === 'string') {
			result.push({ type: ToolResultContentType.EmbeddedResource, data: content.data, contentType: content.mimeType });
		} else if (content.type === 'resource' && isAcpRecord(content.resource)) {
			const resource = content.resource;
			if (typeof resource.text === 'string') {
				result.push({ type: ToolResultContentType.Text, text: typeof resource.uri === 'string' ? `${resource.uri}\n${resource.text}` : resource.text });
			} else if (typeof resource.blob === 'string' && typeof resource.mimeType === 'string') {
				result.push({ type: ToolResultContentType.EmbeddedResource, data: resource.blob, contentType: resource.mimeType });
			}
		} else if (content.type === 'resource_link' && typeof content.uri === 'string') {
			result.push({ type: ToolResultContentType.Text, text: typeof content.name === 'string' ? `${content.name}: ${content.uri}` : content.uri });
		}
	}
	return result;
}
