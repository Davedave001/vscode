/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AssistantNewsFeed, AssistantNewsScope } from '../common/native.js';

const sources = {
	toronto: ['https://www.cbc.ca/webfeed/rss/rss-canada-toronto', 'https://globalnews.ca/toronto/feed/'],
	canada: ['https://www.cbc.ca/webfeed/rss/rss-canada', 'https://globalnews.ca/canada/feed/'],
	world: ['https://www.cbc.ca/webfeed/rss/rss-world', 'https://globalnews.ca/world/feed/'],
} satisfies Record<AssistantNewsScope, readonly [string, string]>;
const publishers = ['CBC News', 'Global News'];
const MAX_FEED_BYTES = 512 * 1024;

export async function fetchAssistantNewsFeeds(scope: AssistantNewsScope, fetcher: (url: string, options: RequestInit) => Promise<Response>): Promise<readonly AssistantNewsFeed[]> {
	if (!Object.hasOwn(sources, scope)) { throw new Error('Unknown headline region.'); }
	return Promise.all(sources[scope].map(async (url, index): Promise<AssistantNewsFeed> => {
		const publisher = publishers[index];
		try {
			const response = await fetcher(url, {
				headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
				credentials: 'omit',
				redirect: 'error',
				signal: AbortSignal.timeout(8_000),
			});
			if (!response.ok || !response.body) {
				await response.body?.cancel();
				return { publisher, error: response.ok ? 'Empty response' : `HTTP ${response.status}` };
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let size = 0;
			let xml = '';
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) { break; }
					size += value.byteLength;
					if (size > MAX_FEED_BYTES) {
						await reader.cancel();
						return { publisher, error: 'Feed exceeds the size limit' };
					}
					xml += decoder.decode(value, { stream: true });
				}
				return { publisher, xml: xml + decoder.decode() };
			} finally {
				reader.releaseLock();
			}
		} catch {
			return { publisher, error: 'Feed request failed or timed out' };
		}
	}));
}
