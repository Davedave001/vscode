/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { constObservable, observableValue } from '../../../../../base/common/observable.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { AssistantNewsScope, AssistantWeatherDay, AssistantWeatherForecast, AssistantWeatherLocation, ReachAssistantRequest, ReachAssistantResponse } from '../../../../../platform/native/common/native.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { InMemoryStorageService, IStorageService, WillSaveStateReason } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustRequestService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { ISearchService } from '../../../../../workbench/services/search/common/search.js';
import { AccessibilitySignal, IAccessibilitySignalService } from '../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { toFileVariableEntry } from '../../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { ContributionEnablementState } from '../../../../../workbench/contrib/chat/common/enablement.js';
import { IGitService } from '../../../../../workbench/contrib/git/common/gitService.js';
import { McpCommandIds } from '../../../../../workbench/contrib/mcp/common/mcpCommandIds.js';
import { IAutostartResult, IMcpServer, IMcpService, IMcpTool, McpConnectionState, McpServerDefinition, McpServerTransportType, McpToolVisibility } from '../../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { microsoft365WorkIq } from '../../../../../workbench/contrib/mcp/common/signalCAppConnections.js';
import { ISignalCDirectMail } from '../../../../../workbench/contrib/mcp/browser/signalCDirectMail.js';
import { SharedChatInputComposer } from '../../../../../workbench/contrib/sessions/browser/chat/sharedChatInputComposer.js';
import { INewSessionComposer, INewSessionComposerService } from '../../../../../workbench/contrib/sessions/browser/newSessionComposerService.js';
import { AbstractCustomView, type ICustomViewDescriptor, ICustomViewService } from '../../../../../workbench/contrib/sessions/browser/customView.js';
import { ASSISTANT_CUSTOM_VIEW_ID, OPEN_ASSISTANT_ACTION_ID } from '../../../../../workbench/contrib/sessions/common/chatConstants.js';
import { ASSISTANT_WEATHER_LOCATION_SETTING } from '../../../../../workbench/contrib/sessions/common/sessionConfig.js';
import { IFocusedSessionHostService, ISessionHost } from '../../../../../workbench/services/sessions/browser/sessionHost.js';
import { ISession, ISessionFolder, ISessionWorkspace } from '../../../../../workbench/services/sessions/common/session.js';
import { WorkspaceSelectionOrigin } from '../../../../../workbench/services/sessions/common/workspaceSelection.js';
import { AgentsWindowMenus } from '../../../../browser/agentsWindowMenus.js';
import { IReachAccount, IReachSubscriptionConnection } from '../../../accountMenu/browser/reachSubscriptionConnection.js';
import { IAssistantAgentChats } from '../../browser/assistantAgentChats.js';
import { IAssistantBriefingScheduler } from '../../browser/assistantBriefingScheduler.js';
import { ASSISTANT_BRIEFINGS } from '../../browser/assistantBriefings.js';
import { AssistantConversationStore, readAssistantTaskTarget } from '../../browser/assistantConversation.js';
import { AssistantRuns, IAssistantApprovalRequest, IAssistantRuns } from '../../browser/assistantRuns.js';
import { AssistantSessionContribution, MANAGE_ASSISTANT_ROUTINES_ACTION_ID } from '../../browser/assistantSession.js';
import { collectAssistantTools, findAssistantAppConnection, formatAssistantWorkspacePath, getAssistantWorkspaceFolders, resolveAssistantWorkspacePath } from '../../browser/assistantTools.js';

function emptyMcpService(): IMcpService {
	return new class extends mock<IMcpService>() {
		override readonly servers = constObservable([]);
		override autostart() { return constObservable(IAutostartResult.Empty); }
	};
}

function fileServiceMock(files: Record<string, string> = {}): IFileService {
	return new class extends mock<IFileService>() {
		override async exists(resource: URI) { return Object.hasOwn(files, resource.path); }
		override async readFile(resource: URI) {
			const content = files[resource.path];
			if (content !== undefined) {
				return { value: VSBuffer.fromString(content) } as never;
			}
			throw new Error('File not found');
		}
		override async writeFile(resource: URI, buffer: VSBuffer) {
			files[resource.path] = buffer.toString();
			return undefined as never;
		}
	};
}

function workspaceServiceMock(): IWorkspaceContextService {
	return new class extends mock<IWorkspaceContextService>() {
		override getWorkspace() { return { folders: [{ uri: URI.parse('file:///ws') }] } as never; }
	};
}

function searchServiceMock(): ISearchService {
	return new class extends mock<ISearchService>() { };
}

const quickInputStub = new class extends mock<IQuickInputService>() { };

const openerStub = new class extends mock<IOpenerService>() { };
const agentChatsStub = upcastPartial<IAssistantAgentChats>({ target: undefined });
const assistantCommandStub = new class extends mock<ICommandService>() { };
const directMailStub = upcastPartial<ISignalCDirectMail>({ connections: constObservable([]) });
const configurationStub = upcastPartial<IConfigurationService>({ getValue: () => undefined });

function mcpServiceWith(...servers: IMcpServer[]): IMcpService {
	return new class extends mock<IMcpService>() {
		override readonly servers = constObservable(servers);
		override autostart() { return constObservable(IAutostartResult.Empty); }
	};
}

function fakeServer(overrides: { name?: string; collectionId?: string; url?: string; running?: boolean; state?: McpConnectionState; toolCount?: number; tools?: readonly IMcpTool[]; instructions?: string } = {}): IMcpServer {
	const tools = overrides.tools ?? Array.from({ length: overrides.toolCount ?? 2 }, (_, i) => new class extends mock<IMcpTool>() {
		override readonly visibility = McpToolVisibility.Model;
		override readonly id = `mcp_fake_${i}`;
		override readonly definition = { name: `mcp_fake_${i}`, description: 'Fake tool', inputSchema: { type: 'object' } } as never;
	});
	return new class extends mock<IMcpServer>() {
		override readonly collection = { id: overrides.collectionId ?? 'user', label: 'User' } as never;
		override readonly definition = { label: overrides.name ?? 'Notes', id: 'notes-server' } as never;
		override readonly enablement = constObservable(ContributionEnablementState.EnabledWorkspace);
		override readonly connectionState = constObservable<McpConnectionState>(overrides.state ?? { state: overrides.running === false ? McpConnectionState.Kind.Stopped : McpConnectionState.Kind.Running });
		override readonly serverMetadata = constObservable({ serverName: overrides.name ?? 'Notes', serverInstructions: overrides.instructions, icons: undefined as never });
		override readonly tools = constObservable(tools);
		override readonly prompts = constObservable([]);
		override readDefinitions() {
			const server = overrides.url ? upcastPartial<McpServerDefinition>({
				launch: { type: McpServerTransportType.HTTP, uri: URI.parse(overrides.url), headers: [] },
			}) : undefined;
			return constObservable({ server, collection: undefined });
		}
	};
}

suite('AssistantSession', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('waits for a cold connection and calls its read-only tool on the first request', async () => {
		const storage = store.add(new InMemoryStorageService());
		const gmail = fakeServer({ name: 'Gmail', tools: [
			upcastPartial<IMcpTool>({
				id: 'gmail_search', visibility: McpToolVisibility.Model,
				definition: { name: 'gmail_search', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
				call: async () => ({ content: [{ type: 'text', text: 'Fixture message ID' }] }),
			}),
		] });
		const startup = observableValue<IAutostartResult>('fixtureStartup', { ...IAutostartResult.Empty, working: true });
		const mcp = new class extends mock<IMcpService>() {
			override readonly servers = observableValue<readonly IMcpServer[]>('fixtureServers', []);
			override autostart() { return startup; }
		};
		const requests: ReachAssistantRequest[] = [];
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_account: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				requests.push(request);
				return requests.length === 1
					? { kind: 'reply', text: '', toolCalls: [{ id: 'search', name: 'gmail_search', arguments: '{}' }] }
					: { kind: 'reply', text: 'Found the test message.' };
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, mcp, upcastPartial<IRequestService>({}), fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		const request = runs.send('account', 'Search my Gmail.');
		assert.strictEqual(requests.length, 0);
		mcp.servers.set([gmail], undefined);
		startup.set(IAutostartResult.Empty, undefined);
		assert.strictEqual(await request, true);
		assert.ok(requests[0].tools?.some(tool => tool.name === 'gmail_search'));
		assert.strictEqual(requests[1].messages.at(-1)?.content, 'Fixture message ID');
	});

	test('can stop Assistant while app connections are starting', async () => {
		const storage = store.add(new InMemoryStorageService());
		const mcp = new class extends mock<IMcpService>() {
			override autostart() { return constObservable({ ...IAutostartResult.Empty, working: true }); }
		};
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(): Promise<ReachAssistantResponse> { assert.fail('A stopped run must not reach the model'); }
		};
		const runs = store.add(new AssistantRuns(reach, storage, mcp, upcastPartial<IRequestService>({}), fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		const request = runs.send('account', 'Search my Gmail.');
		runs.stop('account');
		assert.strictEqual(await request, false);
	});

	test('discovers a late Gmail tool while another server is starting and only executes it once offered', async () => {
		await runWithFakedTimers({ useFakeTimers: true }, async () => {
			const storage = store.add(new InMemoryStorageService());
			const startup = observableValue<IAutostartResult>('fixtureStartup', { ...IAutostartResult.Empty, working: true });
			let startupToken: CancellationToken | undefined;
			let toolCalls = 0;
			let lookupStartedAt = 0;
			const mcp = new class extends mock<IMcpService>() {
				override readonly servers = observableValue<readonly IMcpServer[]>('fixtureServers', []);
				override autostart(token?: CancellationToken) { startupToken = token; return startup; }
			};
			const gmail = fakeServer({ name: 'Gmail', tools: [
				upcastPartial<IMcpTool>({
					id: 'gmail_search', visibility: McpToolVisibility.Model,
					definition: { name: 'gmail_search', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
					call: async () => {
						toolCalls++;
						return { content: [{ type: 'text', text: 'Late fixture message ID' }] };
					},
				}),
			] });
			let step = 0;
			const reach = new class extends mock<IReachSubscriptionConnection>() {
				override readonly onDidChangeAccount = Event.None;
				override async sendAssistantPrompt(_account: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
					if (++step === 1) {
						assert.ok(!request.tools?.some(tool => tool.name === 'gmail_search'));
						assert.strictEqual(startupToken?.isCancellationRequested, false);
						lookupStartedAt = Date.now();
						void timeout(50).then(() => {
							mcp.servers.set([gmail], undefined);
						});
						return { kind: 'reply', text: '', toolCalls: [
							{ id: 'find', name: 'assistant.find_app_tools', arguments: '{"app":"Gmail"}' },
							{ id: 'too-soon', name: 'gmail_search', arguments: '{}' },
						] };
					}
					assert.ok(request.tools?.some(tool => tool.name === 'gmail_search'));
					if (step === 2) {
						assert.ok(Date.now() - lookupStartedAt < 1000, 'Gmail should be usable without waiting for unrelated startup');
						assert.strictEqual(startup.get().working, true);
						assert.match(request.messages.find(message => message.toolCallId === 'find')?.content ?? '', /gmail_search/);
						assert.match(request.messages.at(-1)?.content ?? '', /unknown tool "gmail_search"/);
						assert.strictEqual(toolCalls, 0);
						return { kind: 'reply', text: '', toolCalls: [{ id: 'search', name: 'gmail_search', arguments: '{}' }] };
					}
					assert.strictEqual(request.messages.at(-1)?.content, 'Late fixture message ID');
					return { kind: 'reply', text: 'Found the message.' };
				}
			};
			const runs = store.add(new AssistantRuns(reach, storage, mcp, upcastPartial<IRequestService>({}), fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
			assert.strictEqual(await runs.send('account', 'Search my Gmail.'), true);
			assert.strictEqual(toolCalls, 1);
			assert.strictEqual(startupToken?.isCancellationRequested, true);
		});
	});

	test('includes a late read-only account when listing sources for a briefing', async () => {
		await runWithFakedTimers({ useFakeTimers: true }, async () => {
			const storage = store.add(new InMemoryStorageService());
			const readTool = (name: string) => upcastPartial<IMcpTool>({
				id: name, visibility: McpToolVisibility.Model,
				definition: { name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
			});
			const github = fakeServer({ name: 'GitHub', tools: [readTool('read_prs')] });
			const gmail = fakeServer({ name: 'Gmail', tools: [readTool('read_email'), upcastPartial<IMcpTool>({
				id: 'send_email', visibility: McpToolVisibility.Model,
				definition: { name: 'send_email', inputSchema: { type: 'object' } },
			})] });
			const startup = observableValue<IAutostartResult>('fixtureStartup', { ...IAutostartResult.Empty, working: true });
			const mcp = new class extends mock<IMcpService>() {
				override readonly servers = observableValue<readonly IMcpServer[]>('fixtureServers', [github]);
				override autostart() { return startup; }
			};
			let requests = 0;
			const reach = new class extends mock<IReachSubscriptionConnection>() {
				override readonly onDidChangeAccount = Event.None;
				override async sendAssistantPrompt(_account: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
					const names = request.tools?.map(tool => tool.name) ?? [];
					if (++requests === 1) {
						assert.ok(names.includes('read_prs') && !names.includes('read_email'));
						void timeout(50).then(() => {
							mcp.servers.set([github, gmail], undefined);
							startup.set(IAutostartResult.Empty, undefined);
						});
						return { kind: 'reply', text: '', toolCalls: [{ id: 'sources', name: 'assistant.list_connection_sources', arguments: '{}' }] };
					}
					assert.deepStrictEqual(JSON.parse(request.messages.at(-1)?.content ?? ''), { available: ['GitHub', 'Gmail'], unavailable: [] });
					assert.ok(names.includes('read_prs') && names.includes('read_email') && !names.includes('send_email'));
					return { kind: 'reply', text: 'Briefing with both fixture sources.' };
				}
			};
			const runs = store.add(new AssistantRuns(reach, storage, mcp, upcastPartial<IRequestService>({}), fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
			assert.strictEqual(await runs.send('account', '/briefing morning'), true);
			assert.strictEqual(requests, 2);
		});
	});

	test('briefs on demand with connected read-only tools and the same prompts as the daily presets', async () => {
		const storage = store.add(new InMemoryStorageService());
		const requests: ReachAssistantRequest[] = [];
		const conversations = new AssistantConversationStore(storage);
		conversations.appendTurn('account', { prompt: 'Unrelated private context', reply: 'Old reply' });
		const mcpService = mcpServiceWith(fakeServer({ name: 'GitHub', instructions: 'Untrusted fixture instructions', tools: [
			upcastPartial<IMcpTool>({
				id: 'read_prs', visibility: McpToolVisibility.Model,
				definition: { name: 'read_prs', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
			}),
			upcastPartial<IMcpTool>({
				id: 'write_pr', visibility: McpToolVisibility.Model,
				definition: { name: 'write_pr', inputSchema: { type: 'object' } },
			}),
		] }));
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_account: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				requests.push(request);
				return { kind: 'reply', text: 'Briefing with fixture sources.' };
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, mcpService, upcastPartial<IRequestService>({}), fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		for (const period of ['morning', 'evening'] as const) {
			assert.strictEqual(await runs.send('account', `/briefing ${period}`), true);
			const request = requests.at(-1)!;
			assert.strictEqual(request.messages.length, 2);
			assert.doesNotMatch(request.messages[0].content, /Untrusted fixture instructions/);
			assert.strictEqual(request.messages[1].content, ASSISTANT_BRIEFINGS[period].prompt);
			assert.match(request.messages[1].content, /received and sent email separately/);
			assert.deepStrictEqual(request.tools?.map(tool => tool.name).sort(),
				['assistant.find_app_tools', 'assistant.get_current_time', 'assistant.get_news_headlines', 'assistant.get_weather_forecast', 'assistant.list_connection_sources', 'read_prs']);
		}
		assert.deepStrictEqual(conversations.read('account').turns.slice(1).map(turn => turn.prompt), ['/briefing morning', '/briefing evening']);
		assert.deepStrictEqual([ASSISTANT_BRIEFINGS.morning.schedule.scheduleHour, ASSISTANT_BRIEFINGS.evening.schedule.scheduleHour], [8, 18]);
	});

	test('runs scheduled briefings through the same Assistant with quiet read-only tools and preserves the draft', async () => {
		const storage = store.add(new InMemoryStorageService());
		const conversation = new AssistantConversationStore(storage);
		conversation.setDraft('account', '/briefing morning');
		let called = false;
		let newsScope: AssistantNewsScope | undefined;
		let weatherDay: AssistantWeatherDay | undefined;
		let weatherLocation: AssistantWeatherLocation | undefined;
		const forecast: AssistantWeatherForecast = {
			source: 'The Weather Network', sourceUrl: 'https://www.theweathernetwork.com/en/city/ca/british-columbia/vancouver/7-days',
			location: 'Vancouver, BC, CA', date: '2026-11-19', highC: 8, lowC: 2, precipitationChancePercent: 70, conditions: 'Showers',
		};
		const published = new Date(Date.now() - 60_000);
		const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
		const mcp = mcpServiceWith(fakeServer({ tools: [
			upcastPartial<IMcpTool>({
				id: 'read_mail', visibility: McpToolVisibility.Model,
				definition: { name: 'read_mail', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
				call: async (_args, context) => {
					assert.strictEqual(context?.errorOnUserInteraction, true);
					called = true;
					return { content: [{ type: 'text', text: 'Fixture email summary' }] };
				},
			}),
			upcastPartial<IMcpTool>({
				id: 'send_mail', visibility: McpToolVisibility.Model,
				definition: { name: 'send_mail', inputSchema: { type: 'object' } },
			}),
		] }));
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async readAssistantWeatherForecast(day: AssistantWeatherDay, location: AssistantWeatherLocation) {
				weatherDay = day;
				weatherLocation = location;
				return forecast;
			}
			override async readAssistantNewsFeeds(scope: AssistantNewsScope) {
				newsScope = scope;
				return [
					{ publisher: 'CBC News', error: 'HTTP 503' },
					{ publisher: 'Global News', xml: `<rss><channel>
						<item><title>Toronto &amp; area</title><link>https://globalnews.ca/news/current</link><pubDate>${published.toUTCString()}</pubDate></item>
						<item><title>Duplicate</title><link>https://globalnews.ca/news/current#section</link><pubDate>${published.toUTCString()}</pubDate></item>
						<item><title>Old Toronto news</title><link>https://globalnews.ca/news/old</link><pubDate>${stale.toUTCString()}</pubDate></item>
						<item><title>Invalid link</title><link>javascript:alert(1)</link><pubDate>${published.toUTCString()}</pubDate></item>
					</channel></rss>` },
				];
			}
			override async sendAssistantPrompt(_account: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				assert.ok(request.tools?.some(tool => tool.name === 'read_mail'));
				assert.ok(!request.tools?.some(tool => tool.name === 'send_mail' || tool.name === 'assistant.web_fetch' || tool.name === 'assistant.set_weather_location'));
				if (request.messages.at(-1)?.role === 'tool') {
					const results = request.messages.filter(message => message.role === 'tool');
					assert.strictEqual(results[0].content, 'Fixture email summary');
					assert.deepStrictEqual(JSON.parse(results[1].content), {
						scope: 'toronto',
						headlines: [{ title: 'Toronto & area', url: 'https://globalnews.ca/news/current', publisher: 'Global News', publishedAt: new Date(published.toUTCString()).toISOString() }],
						sources: [{ publisher: 'CBC News', status: 'HTTP 503' }, { publisher: 'Global News', status: 'Available' }],
					});
					assert.deepStrictEqual(JSON.parse(results[2].content), forecast);
					return { kind: 'reply', text: 'Your morning briefing' };
				}
				return { kind: 'reply', text: '', toolCalls: [
					{ id: 'read', name: 'read_mail', arguments: '{}' },
					{ id: 'news', name: 'assistant.get_news_headlines', arguments: '{"scope":"toronto"}' },
					{ id: 'weather', name: 'assistant.get_weather_forecast', arguments: '{"day":"tomorrow"}' },
				] };
			}
		};
		const configuration = upcastPartial<IConfigurationService>({ getValue: <T>(key?: unknown) => (key === ASSISTANT_WEATHER_LOCATION_SETTING ? 'Vancouver, BC, CA' : undefined) as T });
		const runs = store.add(new AssistantRuns(reach, storage, mcp, upcastPartial<IRequestService>({}), fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configuration));
		assert.strictEqual(await runs.sendScheduledBriefing('account', 'morning'), true);
		assert.strictEqual(called, true);
		assert.strictEqual(newsScope, 'toronto');
		assert.strictEqual(weatherDay, 'tomorrow');
		assert.deepStrictEqual(weatherLocation, { city: 'Vancouver', country: 'CA', subdivision: 'BC' });
		assert.strictEqual(conversation.read('account').draft, '/briefing morning');
		assert.strictEqual(conversation.read('account').turns.at(-1)?.reply, 'Your morning briefing');
	});

	test('saves an approved weather location in User Settings and supports one-off forecast locations', async () => {
		const storage = store.add(new InMemoryStorageService());
		let setting = 'Toronto, ON, CA';
		const readLocations: AssistantWeatherLocation[] = [];
		const configuration = upcastPartial<IConfigurationService>({
			getValue: <T>(key?: unknown) => (key === ASSISTANT_WEATHER_LOCATION_SETTING ? setting : undefined) as T,
			updateValue: async (key: string, value: unknown, target?: unknown) => {
				assert.strictEqual(key, ASSISTANT_WEATHER_LOCATION_SETTING);
				assert.strictEqual(target, ConfigurationTarget.USER);
				assert.ok(typeof value === 'string');
				setting = value;
			},
		});
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async readAssistantWeatherForecast(_day: AssistantWeatherDay, location: AssistantWeatherLocation): Promise<AssistantWeatherForecast> {
				readLocations.push(location);
				return { source: 'The Weather Network', sourceUrl: 'https://www.theweathernetwork.com/en/city', location: location.city, date: '2026-11-19' };
			}
			override async sendAssistantPrompt(_account: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				const last = request.messages.at(-1);
				if (last?.role === 'tool') { return { kind: 'reply', text: last.content }; }
				const call = last?.content.includes('Set')
					? { name: 'assistant.set_weather_location', arguments: '{"city":"Vancouver","country":"ca","subdivision":"bc"}' }
					: { name: 'assistant.get_weather_forecast', arguments: last?.content.includes('Paris') ? '{"city":"Paris","country":"FR"}' : '{}' };
				assert.ok(request.tools?.some(tool => tool.name === call.name));
				return { kind: 'reply', text: '', toolCalls: [{ id: 'weather', ...call }] };
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, emptyMcpService(), upcastPartial<IRequestService>({}), fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configuration));
		let allow = false;
		store.add(runs.onDidRequestApproval(request => {
			assert.strictEqual(request.tool, 'assistant.set_weather_location');
			runs.respondApproval(request.id, allow ? 'allow' : 'reject');
		}));
		assert.strictEqual(await runs.send('account', 'Set my default weather location to Vancouver'), true);
		assert.strictEqual(setting, 'Toronto, ON, CA');
		allow = true;
		assert.strictEqual(await runs.send('account', 'Set my default weather location to Vancouver'), true);
		assert.strictEqual(setting, 'Vancouver, BC, CA');
		assert.strictEqual(await runs.send('account', 'What is my weather?'), true);
		assert.strictEqual(await runs.send('account', 'What is the weather in Paris?'), true);
		assert.deepStrictEqual(readLocations, [
			{ city: 'Vancouver', country: 'CA', subdivision: 'BC' },
			{ city: 'Paris', country: 'FR', subdivision: undefined },
		]);
		assert.strictEqual(setting, 'Vancouver, BC, CA');
	});

	test('uses only the selected connection and its read-only tools for a routine even in Allow all mode', async () => {
		const storage = store.add(new InMemoryStorageService());
		const conversation = new AssistantConversationStore(storage);
		const flushedRunIds: (string | undefined)[] = [];
		store.add(storage.onWillSaveState(() => flushedRunIds.push(conversation.read('account').turns.at(-1)?.routineRunId)));
		conversation.setDraft('account', 'Unsent draft');
		conversation.remember('account', ['Private memory from another connection']);
		conversation.setPermissionMode('account', 'allowAll');
		const called: string[] = [];
		const makeTool = (name: string, readOnlyHint: boolean) => upcastPartial<IMcpTool>({
			id: name, visibility: McpToolVisibility.Model,
			definition: { name, inputSchema: { type: 'object' }, annotations: { readOnlyHint } },
			call: async (_args, context) => {
				assert.strictEqual(context?.errorOnUserInteraction, true);
				called.push(name);
				return { content: [{ type: 'text', text: 'Fixture request A-123' }] };
			},
		});
		// The server IDs intentionally match; collections distinguish the accounts.
		const work = fakeServer({ name: 'Work Mail', collectionId: 'work', tools: [makeTool('read_work', true), makeTool('send_work', false)] });
		const personal = fakeServer({ name: 'Personal Mail', collectionId: 'personal', tools: [makeTool('read_personal', true)] });
		const mcp = mcpServiceWith(work, personal);
		let requestCount = 0;
		let newsOutage = false;
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async readAssistantNewsFeeds() {
				assert.ok(newsOutage);
				return [{ publisher: 'CBC News', error: 'HTTP 503' }, { publisher: 'Global News', xml: '<html />' }];
			}
			override async sendAssistantPrompt(_account: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				const names = request.tools?.map(tool => tool.name) ?? [];
				assert.ok(names.includes('read_work'));
				assert.ok(!names.includes('read_personal') && !names.includes('send_work') && !names.includes('assistant.start_agent'));
				assert.doesNotMatch(request.messages[0].content, /Private memory from another connection/);
				assert.match(request.messages[1].content, /Summarize open support requests/);
				if (++requestCount === 1) {
					return { kind: 'reply', text: '', toolCalls: [
						{ id: 'sources', name: 'assistant.list_connection_sources', arguments: '{}' },
						newsOutage
							? { id: 'news', name: 'assistant.get_news_headlines', arguments: '{}' }
							: { id: 'foreign', name: 'read_personal', arguments: '{}' },
						{ id: 'write', name: 'send_work', arguments: '{}' },
						{ id: 'read', name: 'read_work', arguments: '{}' },
					] };
				}
				const results = request.messages.filter(message => message.role === 'tool').map(message => message.content);
				assert.deepStrictEqual(JSON.parse(results[0]).available, ['Work Mail']);
				if (newsOutage) {
					assert.match(results[1], /No current canada headlines.*CBC News: HTTP 503.*Global News: Invalid RSS response/u);
				} else {
					assert.strictEqual(results[1], 'Error: unknown tool "read_personal"');
				}
				assert.deepStrictEqual(results.slice(2), ['Error: unknown tool "send_work"', 'Fixture request A-123']);
				return { kind: 'reply', text: 'Open requests report' };
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, mcp, upcastPartial<IRequestService>({}), fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		const settings = {
			id: 'fixture-routine', name: 'Support triage', prompt: 'Summarize open support requests', serverIds: [JSON.stringify(['work', 'notes-server'])],
		};
		assert.strictEqual(await runs.sendScheduledRoutine('account', settings, 'full-report'), 'completed');
		assert.strictEqual(requestCount, 2);
		assert.deepStrictEqual(called, ['read_work']);
		const state = conversation.read('account');
		assert.strictEqual(state.draft, 'Unsent draft');
		assert.strictEqual(state.turns.at(-1)?.routineId, 'fixture-routine');
		assert.strictEqual(state.turns.at(-1)?.routineRunId, 'full-report');
		assert.strictEqual(state.turns.at(-1)?.reply, 'Open requests report');
		assert.deepStrictEqual(flushedRunIds, ['full-report']);
		requestCount = 0;
		assert.strictEqual(await runs.sendScheduledRoutine('account', {
			...settings, serverIds: [...settings.serverIds, 'missing-connection'],
		}, 'partial-report'), 'needsAttention');
		assert.strictEqual(conversation.read('account').turns.at(-1)?.routineRunId, 'partial-report');
		assert.match(conversation.read('account').turns.at(-1)?.reply ?? '', /1 saved connection — No longer configured/);
		assert.strictEqual(conversation.read('account').turns.at(-1)?.unavailableConnections, undefined);
		assert.deepStrictEqual(flushedRunIds, ['full-report', 'partial-report']);
		requestCount = 0;
		newsOutage = true;
		assert.strictEqual(await runs.sendScheduledRoutine('account', {
			...settings, prompt: 'Summarize open support requests and current headlines',
		}, 'news-outage'), 'needsAttention');
		const outage = conversation.read('account').turns.at(-1);
		assert.strictEqual(outage?.reply, 'Open requests report');
		assert.strictEqual(outage?.activity?.find(item => item.tool === 'assistant.get_news_headlines')?.status, 'failed');
	});

	test('a routine can use a selected direct mailbox without starting an MCP connection', async () => {
		const storage = store.add(new InMemoryStorageService());
		const connection = { id: 'direct-outlook-fixture', provider: 'outlook' as const, label: 'Outlook (Direct)', needsSignIn: false };
		const gmail = { id: 'direct-gmail-fixture', provider: 'gmail' as const, label: 'Gmail (Direct)', needsSignIn: false };
		const directMail = upcastPartial<ISignalCDirectMail>({
			connections: constObservable([connection, gmail]),
			read: async (selected, args) => {
				assert.deepStrictEqual(selected, connection);
				assert.deepStrictEqual(args, { folder: 'sent' });
				return '{"messages":[{"id":"mail-1","subject":"Sent test message"}]}';
			},
		});
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_account: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				assert.ok(request.tools?.some(tool => tool.name === 'assistant.outlook_read'));
				assert.ok(!request.tools?.some(tool => tool.name === 'assistant.gmail_read'));
				if (request.messages.at(-1)?.role === 'tool') {
					assert.match(request.messages.at(-1)?.content ?? '', /Sent test message/);
					return { kind: 'reply', text: 'Outlook sent-mail report' };
				}
				return { kind: 'reply', text: '', toolCalls: [{ id: 'outlook', name: 'assistant.outlook_read', arguments: '{"folder":"sent"}' }] };
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, emptyMcpService(), upcastPartial<IRequestService>({}), fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMail, configurationStub));
		assert.strictEqual(await runs.sendScheduledRoutine('account', { id: 'check-mail', name: 'Sent mail', prompt: 'Summarize sent mail', serverIds: [connection.id] }, 'direct-report'), 'completed');
		const turn = new AssistantConversationStore(storage).read('account').turns.at(-1);
		assert.strictEqual(turn?.reply, 'Outlook sent-mail report');
		assert.strictEqual(turn?.activity?.find(item => item.tool === 'assistant.outlook_read')?.detail, undefined);
	});

	test('reports signed-out Outlook even when the model omits it and keeps reading the other selected source', async () => {
		const storage = store.add(new InMemoryStorageService());
		const conversation = new AssistantConversationStore(storage);
		const readCalls: string[] = [];
		const outlook = fakeServer({
			name: 'Work Outlook', collectionId: 'outlook', url: microsoft365WorkIq.url,
			state: { state: McpConnectionState.Kind.Stopped, reason: 'needs-user-interaction' },
			tools: [upcastPartial<IMcpTool>({
				id: 'cached_outlook_read', visibility: McpToolVisibility.Model, definition: { name: 'fetch', inputSchema: { type: 'object' } },
				call: async () => assert.fail('A cached read must not retry a known signed-out connection'),
			})],
		});
		const mail = fakeServer({ name: 'Other work mail', collectionId: 'mail', tools: [upcastPartial<IMcpTool>({
			id: 'read_mail', visibility: McpToolVisibility.Model,
			definition: { name: 'read_mail', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
			call: async (_args, context) => {
				assert.strictEqual(context?.errorOnUserInteraction, true);
				readCalls.push('mail');
				return { content: [{ type: 'text', text: 'Fixture case A-100' }] };
			},
		})] });
		const ignored = fakeServer({ name: 'Unselected account', collectionId: 'unselected', state: { state: McpConnectionState.Kind.Error, message: 'Private provider error' } });
		const mcp = mcpServiceWith(outlook, mail, ignored);
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_account: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				assert.ok(request.tools?.some(tool => tool.name === 'read_mail'));
				assert.ok(!request.tools?.some(tool => tool.name === 'cached_outlook_read'));
				const results = request.messages.filter(message => message.role === 'tool');
				if (!results.length) {
					return { kind: 'reply', text: '', toolCalls: [
						{ id: 'sources', name: 'assistant.list_connection_sources', arguments: '{}' },
						{ id: 'mail', name: 'read_mail', arguments: '{}' },
					] };
				}
				assert.deepStrictEqual(JSON.parse(results[0].content), {
					available: ['Other work mail'], unavailable: [{ name: 'Work Outlook', reason: 'Sign-in required' }],
				});
				assert.strictEqual(results[1].content, 'Fixture case A-100');
				return { kind: 'reply', text: 'Found case A-100.' };
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, mcp, upcastPartial<IRequestService>({}), fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		const routine = {
			id: 'fixture-routine', name: 'Inbox review', prompt: 'Report inbox cases.',
			serverIds: [JSON.stringify(['outlook', 'notes-server']), JSON.stringify(['mail', 'notes-server'])],
		};
		assert.strictEqual(await runs.sendScheduledRoutine('account', routine, 'partial-outlook-report'), 'needsAttention');
		assert.deepStrictEqual(readCalls, ['mail']);
		assert.strictEqual(conversation.read('account').turns.at(-1)?.reply, 'Found case A-100.\n\n**Unavailable connections**\n\n- Work Outlook — Sign-in required');
		assert.deepStrictEqual(conversation.read('account').turns.at(-1)?.unavailableConnections, [{ id: JSON.stringify(['outlook', 'notes-server']), name: 'Work Outlook', needsSignIn: true }]);
	});

	test('discovers Outlook by name and reads structured Work IQ mail in a briefing', async () => {
		const storage = store.add(new InMemoryStorageService());
		const mailPath = '/me/mailFolders/inbox/messages?$top=3';
		let reads = 0;
		const workIq = fakeServer({ name: 'Work IQ', url: microsoft365WorkIq.url, tools: [
			upcastPartial<IMcpTool>({
				id: 'workiq_fetch', visibility: McpToolVisibility.Model,
				definition: { name: 'fetch', inputSchema: { type: 'object', properties: { entityUrls: { type: 'array', items: { type: 'string' } } } } },
				call: async args => {
					assert.deepStrictEqual(args, { entityUrls: [mailPath] });
					reads++;
					return { content: [], structuredContent: { results: [{ statusCode: 200, data: { value: [{ subject: 'Fixture mail in the inbox' }] } }] } };
				},
			}),
			upcastPartial<IMcpTool>({
				id: 'workiq_action', visibility: McpToolVisibility.Model,
				definition: { name: 'do_action', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
				call: async () => assert.fail('A Work IQ action must never be exposed in a briefing'),
			}),
		] });
		const unrelated = fakeServer({ name: 'Work IQ', url: 'https://example.com/mcp', tools: [upcastPartial<IMcpTool>({
			id: 'unrelated_fetch', visibility: McpToolVisibility.Model,
			definition: { name: 'fetch', inputSchema: { type: 'object' } },
			call: async () => assert.fail('A matching name cannot inherit Work IQ read-only treatment'),
		})] });
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_account: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				const tools = request.tools?.map(tool => tool.name) ?? [];
				assert.ok(tools.includes('workiq_fetch'));
				assert.ok(!tools.includes('workiq_action') && !tools.includes('unrelated_fetch'));
				const result = request.messages.at(-1)?.content ?? '';
				if (result.includes('Fixture mail in the inbox')) { return { kind: 'reply', text: 'Outlook briefing ready.' }; }
				if (request.messages.at(-1)?.role === 'tool') {
					assert.match(result, /Available in the next request.*workiq_fetch/s);
					return { kind: 'reply', text: '', toolCalls: [{ id: 'read', name: 'workiq_fetch', arguments: JSON.stringify({ entityUrls: [mailPath] }) }] };
				}
				return { kind: 'reply', text: '', toolCalls: [{ id: 'discover', name: 'assistant.find_app_tools', arguments: '{"app":"Outlook","query":"search email"}' }] };
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, mcpServiceWith(workIq, unrelated), upcastPartial<IRequestService>({}), fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		assert.strictEqual(await runs.send('account', '/briefing morning'), true);
		assert.strictEqual(reads, 1);
		assert.strictEqual(new AssistantConversationStore(storage).read('account').turns.at(-1)?.reply, 'Outlook briefing ready.');
	});

	test('stages a routine proposal in a chat turn, including editable schedule defaults', async () => {
		const storage = store.add(new InMemoryStorageService());
		const requests: ReachAssistantRequest[] = [];
		const proposal = { name: 'Calendar review', prompt: 'Summarize tomorrow’s meetings', cadence: 'weekdays', hour: 16, minute: 30 };
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_account: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				requests.push(request);
				if (requests.length === 1) {
					assert.ok(request.tools?.some(tool => tool.name === 'assistant.propose_routine'));
					return { kind: 'reply', text: '', toolCalls: [{
						id: 'proposal', name: 'assistant.propose_routine', arguments: JSON.stringify({ ...proposal, serverIds: ['injected'] }),
					}] };
				}
				assert.match(request.messages.at(-1)?.content ?? '', /Review routine/);
				return { kind: 'reply', text: 'Here is a routine to review.' };
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, emptyMcpService(), upcastPartial<IRequestService>({}), fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		assert.strictEqual(await runs.send('account', 'Set up a weekday calendar review at 16:30'), true);
		assert.strictEqual(requests.length, 2);
		assert.deepStrictEqual(new AssistantConversationStore(storage).read('account').turns[0].routineDraft, proposal);
	});

	test('learns from a connected result and saves only the source-backed memory selected in review', async () => {
		const storage = store.add(new InMemoryStorageService());
		const conversations = new AssistantConversationStore(storage);
		const requests: ReachAssistantRequest[] = [];
		const mcpService = mcpServiceWith(fakeServer({ name: 'Gmail work', tools: [upcastPartial<IMcpTool>({
			id: 'mcp_sent', visibility: McpToolVisibility.Model,
			definition: { name: 'list_sent', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
			call: async () => ({ content: [{ type: 'text', text: 'message-1234: fixture email content\nmessage-5678: second fixture email' }] }),
		})] }));
		const propose = (id: string, note: string, reference: string) => ({
			id, name: 'assistant.propose_memory', arguments: JSON.stringify({ note, tool: 'mcp_sent', reference }),
		});
		const responses: ReachAssistantResponse[] = [
			{ kind: 'reply', text: '', toolCalls: [{ id: 'read', name: 'mcp_sent', arguments: '{}' }] },
			{ kind: 'reply', text: '', toolCalls: [
				propose('valid', 'Prefers short weekly updates', 'message-1234'),
				propose('other', 'Prefers to confirm dates in writing', 'message-5678'),
				propose('invalid', 'Unfounded statement', 'unverified-reference'),
			] },
			{ kind: 'reply', text: 'Found two candidates from sent email.' },
		];
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_account: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				requests.push(request);
				return responses.shift()!;
			}
		};
		const quickInput = new class extends mock<IQuickInputService>() {
			override async pick(items: unknown[]): Promise<never> {
				assert.strictEqual(conversations.read('account').instructions, '');
				assert.deepStrictEqual(items.map(item => (item as { label: string }).label), [
					'Prefers short weekly updates', 'Prefers to confirm dates in writing',
				]);
				return [items[0]] as never;
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, mcpService, upcastPartial<IRequestService>({}), fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInput, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		assert.strictEqual(await runs.send('account', '/learn'), true);
		assert.match(requests[0].messages[1].content, /both my sent and received email/);
		assert.match(requests[0].messages[1].content, /my commits, pull requests, reviews, and issue comments/);
		assert.match(requests[2].messages.find(message => message.toolCallId === 'invalid')?.content ?? '', /exact link or record ID/);
		assert.strictEqual(conversations.read('account').instructions, '- Prefers short weekly updates (Gmail work · list_sent, message-1234)');
		assert.strictEqual(conversations.read('other account').instructions, '');
		assert.doesNotMatch(JSON.stringify(conversations.read('account')), /fixture email content/);
	});

	test('records a provider-reported MCP failure as failed and gives its reason to the model', async () => {
		const storage = store.add(new InMemoryStorageService());
		const reason = 'This Google Cloud project requires Google Workspace Developer Preview enrollment.';
		const tool = upcastPartial<IMcpTool>({
			id: 'list_labels', visibility: McpToolVisibility.Model,
			definition: { name: 'list_labels', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
			call: async () => ({ isError: true, content: [{ type: 'text', text: reason }] }),
		});
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_account: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				if (request.messages.at(-1)?.role === 'tool') {
					assert.strictEqual(request.messages.at(-1)?.content, `Tool reported an error:\n${reason}`);
					return { kind: 'reply', text: 'Gmail is blocked by project enrollment.' };
				}
				return { kind: 'reply', text: '', toolCalls: [{ id: 'read-labels', name: 'list_labels', arguments: '{}' }] };
			}
		};
		const mcp = mcpServiceWith(fakeServer({ name: 'Gmail', tools: [tool] }));
		const runs = store.add(new AssistantRuns(reach, storage, mcp, upcastPartial<IRequestService>({}), fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		assert.strictEqual(await runs.send('account', 'List Gmail labels'), true);
		const [activity] = new AssistantConversationStore(storage).read('account').turns[0].activity!;
		assert.strictEqual(activity.status, 'failed');
		assert.strictEqual(activity.detail, reason);
		assert.strictEqual(await runs.sendScheduledRoutine('account', {
			id: 'gmail-review', name: 'Mail review', prompt: 'Read Gmail labels', serverIds: [JSON.stringify(['user', 'notes-server'])],
		}, 'gmail-run'), 'needsAttention');
		const lastReport = new AssistantConversationStore(storage).read('account').turns.at(-1);
		assert.strictEqual(lastReport?.routineRunId, 'gmail-run');
		assert.strictEqual(lastReport?.activity?.[0].status, 'failed');
	});

	test('routes Microsoft mail names to Outlook and keeps Work IQ explicitly available', () => {
		for (const name of ['Outlook', 'Outlook.com', 'Outlook (Direct)', 'Microsoft 365', 'Microsoft 365 Mail', 'Outlook / Microsoft 365 Mail']) {
			assert.strictEqual(findAssistantAppConnection(name)?.id, 'outlook-direct');
		}
		for (const name of ['Work IQ', 'Microsoft 365 (Work IQ)', 'Microsoft Teams']) {
			assert.strictEqual(findAssistantAppConnection(name)?.id, 'microsoft-365');
		}
	});

	test('opens only approved catalog app setup through Assistant', async () => {
		const storage = store.add(new InMemoryStorageService());
		const calls: unknown[][] = [];
		const toolResults: string[] = [];
		const approvalLabels: string[] = [];
		const setup = new DeferredPromise<unknown>();
		const commands = upcastPartial<ICommandService>({ executeCommand: async <T>(...args: unknown[]) => { calls.push(args); return await setup.p as T; } });
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_account: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				const results = request.messages.filter(message => message.role === 'tool');
				if (results.length) {
					toolResults.push(results.at(-1)!.content);
					return { kind: 'reply', text: 'OAuth setup result received.' };
				}
				const app = request.messages.at(-1)?.content;
				return { kind: 'reply', text: '', toolCalls: [{ id: 'oauth', name: 'assistant.connect_app', arguments: JSON.stringify({ app }) }] };
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, emptyMcpService(), upcastPartial<IRequestService>({}), fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, commands, directMailStub, configurationStub));
		let allow = false;
		store.add(runs.onDidRequestApproval(request => {
			approvalLabels.push(request.label);
			runs.respondApproval(request.id, allow ? 'allow' : 'reject');
		}));
		assert.strictEqual(await runs.send('account', 'Slack'), true);
		assert.strictEqual(calls.length, 0);
		allow = true;
		assert.strictEqual(await runs.send('account', 'https://untrusted.example/oauth'), true);
		assert.strictEqual(calls.length, 0);
		assert.strictEqual(await runs.send('account', 'Slack'), true);
		assert.deepStrictEqual(calls, [[McpCommandIds.ConnectApp, undefined, 'slack', 'assistant']]);
		assert.strictEqual(runs.openAppSetup('slack'), false);
		assert.strictEqual(approvalLabels.length, 3);
		assert.match(toolResults[0], /declined/);
		assert.match(toolResults[1], /No matching app/);
		assert.match(toolResults[2], /finish the setup and any browser authorization/);
		await setup.complete(undefined);
	});

	test('discovers Slack tools beyond the model limit and still asks before sending', async () => {
		const storage = store.add(new InMemoryStorageService());
		const sent: unknown[] = [];
		const slackTool = upcastPartial<IMcpTool>({
			id: 'mcp_slack_send_message', visibility: McpToolVisibility.Model,
			definition: { name: 'slack_send_message', description: 'Send a message to a Slack channel', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
			call: async args => { sent.push(args); return { content: [{ type: 'text', text: 'Synthetic Slack delivery confirmed' }] }; },
		});
		const mcpService = upcastPartial<IMcpService>({ servers: constObservable([
			fakeServer({ toolCount: 40, instructions: 'Fixture notes instructions' }),
			fakeServer({ name: 'Slack', tools: [slackTool], instructions: 'Fixture Slack instructions' }),
		]) });
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_account: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				assert.ok(request.tools && request.tools.length <= 32);
				const results = request.messages.filter(message => message.role === 'tool');
				if (!results.length) {
					assert.ok(!request.tools.some(spec => spec.name === slackTool.id));
					assert.match(request.messages[0].content, /Fixture notes instructions/);
					assert.doesNotMatch(request.messages[0].content, /Fixture Slack instructions/);
					return { kind: 'reply', text: '', toolCalls: [{ id: 'find', name: 'assistant.find_app_tools', arguments: '{"app":"Slack","query":"send message"}' }] };
				}
				if (results.length === 1) {
					assert.match(results[0].content, /mcp_slack_send_message/);
					assert.ok(request.messages[0].content.includes(slackTool.id));
					assert.match(request.messages[0].content, /Fixture Slack instructions/);
					assert.doesNotMatch(request.messages[0].content, /Fixture notes instructions/);
					assert.deepStrictEqual(request.tools.find(spec => spec.name === slackTool.id)?.parameters, slackTool.definition.inputSchema);
					return { kind: 'reply', text: '', toolCalls: [{ id: 'send', name: slackTool.id, arguments: '{"text":"Test message"}' }] };
				}
				assert.match(results[1].content, /Synthetic Slack delivery confirmed/);
				return { kind: 'reply', text: 'Message sent.' };
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, mcpService, upcastPartial<IRequestService>({}), fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		let approvedTool: string | undefined;
		store.add(runs.onDidRequestApproval(request => {
			assert.deepStrictEqual(sent, []);
			approvedTool = request.tool;
			runs.respondApproval(request.id, 'allow');
		}));
		assert.strictEqual(await runs.send('account', 'Send a test message in Slack'), true);
		assert.strictEqual(approvedTool, slackTool.id);
		assert.deepStrictEqual(sent, [{ text: 'Test message' }]);
	});

	test('opens linked tasks and announces tool approvals once in the shared composer', async () => {
		const opened: string[] = [];
		const descriptors: ICustomViewDescriptor[] = [];
		const active = observableValue<ICustomViewDescriptor | undefined>('assistantTestView', undefined);
		const views = new class extends mock<ICustomViewService>() {
			override readonly activeCustomView = active;
			override readonly activeCustomViewOpen = constObservable(undefined);
			override registerCustomView(value: ICustomViewDescriptor) { descriptors.push(value); return Disposable.None; }
			override showCustomView(id: string) {
				opened.push(id);
				active.set(descriptors.find(descriptor => descriptor.id === id), undefined);
			}
		};
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(ICustomViewService, views);
		instantiation.stub(ISignalCDirectMail, directMailStub);
		const focusedSession = observableValue<ISession | undefined>('focusedAssistantProject', undefined);
		const host = upcastPartial<ISessionHost>({ session: focusedSession, chat: constObservable(undefined) });
		const editorSelection = observableValue<ReturnType<IAssistantAgentChats['editorSelection']['get']>>('testEditorSelection', undefined);
		const agentChats = upcastPartial<IAssistantAgentChats>({ target: undefined, editorSelection });
		const project = URI.parse('file:///linked-project');
		instantiation.stub(IFocusedSessionHostService, upcastPartial<IFocusedSessionHostService>({ getFocusedHost: () => host }));
		instantiation.stub(INewSessionComposerService, upcastPartial<INewSessionComposerService>({
			getComposer: () => upcastPartial<INewSessionComposer>({ workspaceSelection: { folderUri: project, state: 'selected', origin: WorkspaceSelectionOrigin.User, historyState: 'loaded', sessionFallbackState: 'idle', registeredProviderCount: 1 } }),
		}));
		instantiation.stub(IAssistantAgentChats, agentChats);
		const storage = store.add(new InMemoryStorageService());
		const accountChanged = store.add(new Emitter<void>());
		const changedInput = store.add(new Emitter<void>());
		const submitted: { accountId: string; request: ReachAssistantRequest; conversationId?: string }[] = [];
		const signals: AccessibilitySignal[] = [];
		let account: IReachAccount | undefined;
		let inputValue = '';
		const excerpts: { name: string; content: string }[] = [];
		const taskResult = new DeferredPromise<ReachAssistantResponse>();
		const routineAccounts: string[] = [];
		const pickers: string[] = [];
		instantiation.stub(ICommandService, upcastPartial<ICommandService>({
			executeCommand: async (id, ...args) => {
				await CommandsRegistry.getCommand(id)!.handler(instantiation, ...args);
				return undefined;
			},
		}));
		instantiation.stub(IClipboardService, new class extends mock<IClipboardService>() { });
		instantiation.stub(IQuickInputService, upcastPartial<IQuickInputService>({
			pick: async (_items, options) => { pickers.push(options?.title ?? ''); return undefined; },
		}));
		instantiation.stub(IAssistantBriefingScheduler, upcastPartial<IAssistantBriefingScheduler>({
			getRoutines: async id => { routineAccounts.push(id); return []; },
		}));
		instantiation.stub(IDialogService, new class extends mock<IDialogService>() { });
		instantiation.stub(IRequestService, new class extends mock<IRequestService>() { });
		instantiation.stub(IFileService, fileServiceMock());
		instantiation.stub(IWorkspaceContextService, workspaceServiceMock());
		instantiation.stub(IWorkspaceTrustRequestService, upcastPartial<IWorkspaceTrustRequestService>({}));
		instantiation.stub(IGitService, upcastPartial<IGitService>({}));
		instantiation.stub(ISearchService, searchServiceMock());
		instantiation.stub(IAccessibilitySignalService, new class extends mock<IAccessibilitySignalService>() {
			override async playSignal(signal: AccessibilitySignal) { signals.push(signal); }
		});
		instantiation.stub(IOpenerService, openerStub);
		instantiation.stub(IStorageService, storage);
		const mcpService = mcpServiceWith(fakeServer({ name: 'Notes', toolCount: 3 }));
		instantiation.stub(IMcpService, mcpService);
		instantiation.stubInstance(SharedChatInputComposer, {
			dispose() { },
			render(parent, _root, inlineControls) { if (inlineControls) { parent.appendChild(inlineControls); } },
			focus() { },
			setInputEnabled() { },
			getInputValue: () => inputValue,
			setInputValue: value => { inputValue = value; changedInput.fire(); },
			getDraft: () => ({ inputText: inputValue, attachments: [] }),
			setDraft: draft => { inputValue = draft?.inputText ?? ''; changedInput.fire(); },
			attachTextContext: (name, content) => { excerpts.push({ name, content }); },
			onDidChangeInput: changedInput.event,
			attachments: [],
		});
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = accountChanged.event;
			override readonly assistantSupported = true;
			override async getAccount() { return account; }
			override async listAssistantModels() { return [{ id: 'reach-qwen', name: 'Qwen' }]; }
			override async sendAssistantPrompt(accountId: string, request: ReachAssistantRequest, _requestId?: string, _token?: CancellationToken, conversationId?: string): Promise<ReachAssistantResponse> {
				submitted.push({ accountId, request, conversationId });
				if (request.messages.at(-1)?.content === 'Write a fixture') {
					return { kind: 'reply', text: '', toolCalls: [{ id: 'write-fixture', name: 'assistant.write_file', arguments: '{"path":"fixture.txt","content":"hello"}' }] };
				}
				if (conversationId) { return taskResult.p; }
				return { kind: 'reply', text: '**Connected.**' };
			}
		};
		instantiation.stub(IReachSubscriptionConnection, reach);
		const runs = store.add(new AssistantRuns(reach, storage, mcpService, new class extends mock<IRequestService>() { }, fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		instantiation.stub(IAssistantRuns, runs);
		store.add(new AssistantSessionContribution(views));
		for (const menu of [AgentsWindowMenus.CustomViewAssistant, AgentsWindowMenus.CustomViewAutomations]) {
			assert.ok(MenuRegistry.getMenuItems(menu).some(item => isIMenuItem(item) && item.command.id === MANAGE_ASSISTANT_ROUTINES_ACTION_ID));
		}
		const manageRoutines = CommandsRegistry.getCommand(MANAGE_ASSISTANT_ROUTINES_ACTION_ID)!;
		await manageRoutines.handler(instantiation);
		assert.deepStrictEqual(opened, [ASSISTANT_CUSTOM_VIEW_ID]);
		assert.deepStrictEqual(agentChats.target?.workspace, project);
		const [descriptor] = descriptors;
		assert.strictEqual(descriptor.id, ASSISTANT_CUSTOM_VIEW_ID);
		const view = store.add(instantiation.createInstance<AbstractCustomView>(descriptor.ctor));
		const content = document.createElement('div');
		view.render(content);
		await timeout(0);
		assert.match(content.textContent ?? '', /Sign in with your SignalREACH account/);
		assert.deepStrictEqual(routineAccounts, [], 'Opening routines must wait for a signed-in account');
		const chat = content.querySelector<HTMLElement>('.reach-assistant-chat')!;
		assert.strictEqual(chat.hidden, true);
		account = { id: 'my-account', subscriptionActive: true };
		const conversation = new AssistantConversationStore(storage);
		conversation.appendTurn(account.id, { prompt: 'Saved locally', reply: 'Earlier reply' });
		conversation.setDraft(account.id, 'Saved draft');
		conversation.setModel(account.id, 'reach-qwen');
		accountChanged.fire();
		await timeout(0);
		assert.strictEqual(chat.hidden, false);
		assert.match(content.querySelector('[role=log]')?.textContent ?? '', /Earlier reply/);
		assert.strictEqual(chat.querySelector('.reach-assistant-app-name')?.textContent, 'Notes');
		assert.strictEqual(chat.querySelector('.reach-assistant-app-count')?.textContent, '3');
		assert.ok(chat.querySelector('.reach-assistant-app-dot.running'));
		assert.ok(chat.querySelector('.reach-assistant-app-add'));
		assert.strictEqual(inputValue, 'Saved draft');
		assert.deepStrictEqual(routineAccounts, ['my-account']);
		assert.deepStrictEqual(pickers, ['Assistant routines']);
		assert.ok(chat.querySelector('.reach-assistant-composer .reach-assistant-controls'));
		assert.match(chat.querySelector('.reach-assistant-model')?.textContent ?? '', /Qwen/);
		const button = (label: string) => Array.from(chat.querySelectorAll<HTMLButtonElement>('button')).find(element => element.textContent === label)!;
		const selection = { text: 'Unsaved excerpt', startLine: 2, endLine: 4, truncated: false };
		editorSelection.set({ file: URI.file('/elsewhere/selection.ts'), selection }, undefined);
		assert.strictEqual(button('Attach IDE selection · selection.ts:2–4'), undefined);
		editorSelection.set({ file: URI.file('/ws/src/selection.ts'), selection }, undefined);
		assert.deepStrictEqual(excerpts, []);
		button('Attach IDE selection · selection.ts:2–4').click();
		assert.deepStrictEqual(excerpts, [{ name: 'src/selection.ts:2–4', content: selection.text }]);
		assert.strictEqual(inputValue, 'Saved draft');
		assert.strictEqual(submitted.length, 0);
		editorSelection.set(undefined, undefined);
		button('New task').click();
		const task = conversation.read(account.id).tasks![0];
		assert.strictEqual(inputValue, '');
		assert.strictEqual(conversation.read(account.id, task.id).modelId, 'reach-qwen');
		assert.strictEqual(readAssistantTaskTarget(task)?.workspace?.toString(), project.toString());
		inputValue = 'Unsent on exit';
		changedInput.fire();
		assert.strictEqual(conversation.read(account.id, task.id).draft, undefined);
		await storage.flush(WillSaveStateReason.SHUTDOWN);
		assert.strictEqual(conversation.read(account.id, task.id).draft, 'Unsent on exit');
		const pending = runs.send(account.id, 'Research an approach', task.id);
		assert.strictEqual(chat.querySelector<HTMLElement>('.reach-assistant-pending')?.hidden, false);
		await manageRoutines.handler(instantiation);
		await timeout(0);
		assert.strictEqual(inputValue, 'Saved draft');
		assert.strictEqual(conversation.read(account.id, task.id).draft, 'Unsent on exit');
		assert.deepStrictEqual(pickers, ['Assistant routines', 'Assistant routines']);
		assert.deepStrictEqual(opened, [ASSISTANT_CUSTOM_VIEW_ID], 'Opening the picker must reuse the visible Assistant view');
		assert.match(chat.querySelector('.reach-assistant-task-updates')?.textContent ?? '', /Research an approach.*Running/);
		assert.strictEqual(submitted.length, 1);
		assert.strictEqual(submitted[0].accountId, 'my-account');
		assert.strictEqual(submitted[0].conversationId, task.id);
		assert.strictEqual(submitted[0].request.modelId, 'reach-qwen');
		assert.deepStrictEqual(submitted[0].request.messages.at(-1), { role: 'user', content: 'Research an approach' });
		await taskResult.complete({ kind: 'reply', text: '**Findings ready.**', model: 'Qwen' });
		assert.strictEqual(await pending, true);
		assert.match(chat.querySelector('.reach-assistant-task-updates')?.textContent ?? '', /Complete.*Findings ready/);
		assert.ok(signals.includes(AccessibilitySignal.taskCompleted));
		assert.strictEqual(conversation.read(account.id).turns.length, 1);
		button('Research an approach').click();
		assert.strictEqual(chat.querySelector('.reach-assistant-reply strong')?.textContent, 'Findings ready.');
		assert.strictEqual(chat.querySelector('.reach-assistant-reply-tools .action-label')?.getAttribute('role'), 'button');
		const approval = Event.toPromise(runs.onDidRequestApproval);
		const finishing = runs.send(account.id, 'Write a fixture', task.id);
		await approval;
		assert.strictEqual(chat.querySelector<HTMLElement>('.reach-assistant-approval')?.hidden, false);
		button('Reject').click();
		assert.strictEqual(await finishing, true);
		assert.strictEqual(signals.filter(signal => signal === AccessibilitySignal.chatUserActionRequired).length, 1);
		account = undefined;
		accountChanged.fire();
		await timeout(0);
		assert.strictEqual(chat.hidden, true);
		assert.strictEqual(content.querySelector('[role=log]')?.textContent, '');
		assert.strictEqual(conversation.read('my-account').draft, 'Saved draft');
		await manageRoutines.handler(instantiation);
		active.set(undefined, undefined);
		account = { id: 'my-account', subscriptionActive: true };
		accountChanged.fire();
		await timeout(0);
		assert.strictEqual(pickers.length, 2, 'Leaving Assistant must cancel a picker request waiting for sign-in');
		const fileRoots = [project, URI.parse('file:///linked-utilities')];
		focusedSession.set(upcastPartial<ISession>({
			mainChat: constObservable(undefined as never),
			workspace: constObservable(upcastPartial<ISessionWorkspace>({
				uri: project, folders: fileRoots.map(workingDirectory => upcastPartial<ISessionFolder>({ workingDirectory })), isVirtualWorkspace: false,
			})),
		}), undefined);
		await CommandsRegistry.getCommand(OPEN_ASSISTANT_ACTION_ID)!.handler(instantiation);
		assert.deepStrictEqual(agentChats.target?.fileRoots, fileRoots);
	});

	test('restores each conversation’s editable attachments and keeps its prepared prompt for retry', () => {
		const storage = store.add(new InMemoryStorageService());
		const conversation = new AssistantConversationStore(storage);
		const originalAttachment = URI.file('/fixture/service-marker.txt');
		const draft = { inputText: 'Read this file', attachments: [toFileVariableEntry(originalAttachment)] };
		conversation.setDraft('account', 'Unsent main draft');
		conversation.setComposerDraft('account', draft, 'task', 'Prepared prompt with file content');

		const reopened = new AssistantConversationStore(storage);
		assert.deepStrictEqual(reopened.readComposerDraft('account'), { inputText: 'Unsent main draft', attachments: [] });
		const restored = reopened.readComposerDraft('account', 'task');
		assert.strictEqual(restored.inputText, draft.inputText);
		assert.deepStrictEqual(restored.attachments.map(attachment => attachment.value), [originalAttachment]);
		reopened.setComposerDraft('account', restored, 'task');
		assert.strictEqual(reopened.read('account', 'task').draft, 'Prepared prompt with file content');

		const replacementAttachment = URI.file('/fixture/another-file.txt');
		reopened.setComposerDraft('account', { ...restored, attachments: [toFileVariableEntry(replacementAttachment)] }, 'task');
		assert.strictEqual(reopened.read('account', 'task').draft, draft.inputText);
		assert.deepStrictEqual(reopened.readComposerDraft('account', 'task').attachments.map(attachment => attachment.value), [replacementAttachment]);
		assert.strictEqual(reopened.readComposerDraft('other-account', 'task').attachments.length, 0);
		reopened.setDraft('account', '', 'task');
		assert.deepStrictEqual(reopened.readComposerDraft('account', 'task'), { inputText: '', attachments: [] });
	});

	test('keeps a replacement attachment draft when an earlier request with the same text finishes', async () => {
		const storage = store.add(new InMemoryStorageService());
		const conversation = new AssistantConversationStore(storage);
		const reply = new DeferredPromise<ReachAssistantResponse>();
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt() { return reply.p; }
		};
		const runs = store.add(new AssistantRuns(reach, storage, emptyMcpService(), new class extends mock<IRequestService>() { }, fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		const text = 'Read this file';
		conversation.setComposerDraft('account', { inputText: text, attachments: [toFileVariableEntry(URI.file('/fixture/first.txt'))] });
		const sending = runs.send('account', text);
		const replacement = URI.file('/fixture/second.txt');
		conversation.setComposerDraft('account', { inputText: text, attachments: [toFileVariableEntry(replacement)] });
		await reply.complete({ kind: 'reply', text: 'Read the first file.' });
		assert.strictEqual(await sending, true);
		assert.deepStrictEqual(conversation.readComposerDraft('account').attachments.map(attachment => attachment.value), [replacement]);
	});

	test('captures IDE roots only while the current New Chat selection belongs to that switch', async () => {
		const instantiation = store.add(new TestInstantiationService());
		const views = upcastPartial<ICustomViewService>({
			activeCustomView: constObservable(undefined),
			registerCustomView: () => Disposable.None,
			showCustomView: () => {},
		});
		const root = URI.file('/ide-active');
		const sibling = URI.file('/ide-sibling');
		const activeFile = URI.joinPath(root, 'main.ts');
		const selectionVersion = observableValue('workspace selection', 1);
		const navigationVersion = observableValue('workspace navigation', 2);
		const composer = upcastPartial<INewSessionComposer>({
			workspaceSelection: { folderUri: root, state: 'selected', origin: WorkspaceSelectionOrigin.WindowContext, historyState: 'loaded', sessionFallbackState: 'idle', registeredProviderCount: 1 },
		});
		const target = upcastPartial<IAssistantAgentChats>({
			editorWorkspace: { selectedFolder: root, fileRoots: [root, sibling], fileRootNames: ['Active', 'Sibling'], activeFile, selectionVersion: 1, navigationVersion: 2 },
		});
		const host = upcastPartial<ISessionHost>({ session: constObservable(undefined), chat: constObservable(undefined) });
		instantiation.stub(IFocusedSessionHostService, upcastPartial<IFocusedSessionHostService>({ getFocusedHost: () => host }));
		instantiation.stub(INewSessionComposerService, upcastPartial<INewSessionComposerService>({
			getComposer: () => composer, userWorkspaceSelectionVersion: selectionVersion, userNavigationVersion: navigationVersion,
		}));
		instantiation.stub(IAssistantAgentChats, target);
		store.add(new AssistantSessionContribution(views));
		const open = () => CommandsRegistry.getCommand(OPEN_ASSISTANT_ACTION_ID)!.handler(instantiation);
		await open();
		assert.deepStrictEqual(target.target?.fileRoots, [root, sibling]);
		assert.deepStrictEqual(target.target?.fileRootNames, ['Active', 'Sibling']);
		assert.deepStrictEqual(target.target?.activeEditorFile, activeFile);
		assert.deepStrictEqual(target.target?.workspace, root);

		navigationVersion.set(3, undefined);
		await open();
		assert.strictEqual(target.target?.fileRoots, undefined);
		assert.strictEqual(target.target?.activeEditorFile, undefined);
		navigationVersion.set(2, undefined);
		selectionVersion.set(2, undefined);
		await open();
		assert.strictEqual(target.target?.fileRoots, undefined);
	});

	test('runs text-protocol tool calls, feeds results back, and records activity', async () => {
		const storage = store.add(new InMemoryStorageService());
		const sent: ReachAssistantRequest[] = [];
		const responses: ReachAssistantResponse[] = [
			{ kind: 'reply', text: 'Let me check.\n```tool_call\n{"name": "assistant.get_current_time", "arguments": {}}\n```' },
			{ kind: 'reply', text: 'It is noon, give or take.', model: 'Qwen' },
		];
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_accountId: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				sent.push(request);
				return responses.shift()!;
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, emptyMcpService(), new class extends mock<IRequestService>() { }, fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		assert.strictEqual(await runs.send('account', 'What time is it?'), true);
		assert.strictEqual(sent.length, 2);
		assert.strictEqual(sent[1].messages.at(-1)?.role, 'user');
		assert.match(String(sent[1].messages.at(-1)?.content), /<tool_result name="assistant\.get_current_time">/);
		const turns = new AssistantConversationStore(storage).read('account').turns;
		assert.strictEqual(turns.length, 1);
		assert.strictEqual(turns[0].reply, 'It is noon, give or take.');
		assert.deepStrictEqual(turns[0].activity?.map(item => [item.tool, item.status]), [['assistant.get_current_time', 'done']]);
	});

	test('asks the user a clarifying question and feeds the answer back', async () => {
		const storage = store.add(new InMemoryStorageService());
		const sent: ReachAssistantRequest[] = [];
		const responses: ReachAssistantResponse[] = [
			{ kind: 'reply', text: 'One moment.\n```tool_call\n{"name": "assistant.ask_user", "arguments": {"question": "Which color?"}}\n```' },
			{ kind: 'reply', text: 'Blue it is.' },
		];
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_accountId: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				sent.push(request);
				return responses.shift()!;
			}
		};
		const questions: string[] = [];
		const quickInput = new class extends mock<IQuickInputService>() {
			override async input(options?: { title?: string }) {
				questions.push(options?.title ?? '');
				return 'Blue';
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, emptyMcpService(), new class extends mock<IRequestService>() { }, fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInput, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		assert.strictEqual(await runs.send('account', 'Pick a color.'), true);
		assert.deepStrictEqual(questions, ['Which color?']);
		assert.strictEqual(sent.length, 2);
		assert.match(String(sent[1].messages.at(-1)?.content), /The user answered: Blue/);
		const turns = new AssistantConversationStore(storage).read('account').turns;
		assert.strictEqual(turns[0].reply, 'Blue it is.');
		assert.deepStrictEqual(turns[0].activity?.map(item => [item.tool, item.status]), [['assistant.ask_user', 'done']]);
	});

	test('asks before write actions, runs them on Allow, and learns native tool_calls', async () => {
		const storage = store.add(new InMemoryStorageService());
		const sent: ReachAssistantRequest[] = [];
		const called: Record<string, unknown>[] = [];
		const writeTool = new class extends mock<IMcpTool>() {
			override readonly id = 'mcp_notes_write';
			override readonly visibility = McpToolVisibility.Model;
			override readonly definition = { name: 'mcp_notes_write', title: 'Write note', description: 'Writes a note', annotations: { destructiveHint: true }, inputSchema: { type: 'object' } } as never;
			override async call(params: Record<string, unknown>) {
				called.push(params);
				return { content: [{ type: 'text', text: 'written' }] } as never;
			}
		};
		const server = new class extends mock<IMcpServer>() {
			override readonly definition = { label: 'Notes' } as never;
			override readonly enablement = constObservable(ContributionEnablementState.EnabledWorkspace);
			override readonly serverMetadata = constObservable({ serverName: 'Notes', icons: undefined as never });
			override readonly tools = constObservable<IMcpTool[]>([writeTool]);
			override readonly prompts = constObservable([]);
		};
		const mcpService = new class extends mock<IMcpService>() {
			override readonly servers = constObservable<IMcpServer[]>([server]);
		};
		const approvals: IAssistantApprovalRequest[] = [];
		const responses: ReachAssistantResponse[] = [
			{ kind: 'reply', text: '', toolCalls: [{ id: 'call-1', name: 'mcp_notes_write', arguments: '{"note":"hi"}' }] },
			{ kind: 'reply', text: 'Note written.' },
		];
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_accountId: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				sent.push(request);
				return responses.shift()!;
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, mcpService, new class extends mock<IRequestService>() { }, fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		store.add(runs.onDidRequestApproval(request => {
			approvals.push(request);
			assert.strictEqual(runs.getPendingApproval('account')?.id, request.id);
			runs.respondApproval(request.id, 'allow');
			assert.strictEqual(runs.getPendingApproval('account'), undefined);
		}));
		assert.strictEqual(await runs.send('account', 'Write a note'), true);
		assert.strictEqual(approvals.length, 1);
		assert.strictEqual(approvals[0].tool, 'mcp_notes_write');
		assert.deepStrictEqual(called, [{ note: 'hi' }]);
		assert.strictEqual(sent.length, 2);
		const echoed = sent[1].messages.at(-2);
		assert.strictEqual(echoed?.role, 'assistant');
		assert.deepStrictEqual(echoed?.toolCalls, [{ id: 'call-1', name: 'mcp_notes_write', arguments: '{"note":"hi"}' }]);
		assert.deepStrictEqual(sent[1].messages.at(-1), { role: 'tool', toolCallId: 'call-1', name: 'mcp_notes_write', content: 'written' });
		const activity = new AssistantConversationStore(storage).read('account').turns[0].activity;
		assert.deepStrictEqual(activity?.map(item => item.status), ['done']);
	});

	test('posts a live plan checklist while a run executes', async () => {
		const storage = store.add(new InMemoryStorageService());
		const sent: ReachAssistantRequest[] = [];
		const release = new DeferredPromise<ReachAssistantResponse>();
		const responses: ReachAssistantResponse[] = [
			{ kind: 'reply', text: 'Planning.\n```tool_call\n{"name": "assistant.update_plan", "arguments": {"items": [{"step": "Scan files", "status": "inProgress"}, {"step": "Write report", "status": "pending"}]}}\n```' },
		];
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_accountId: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				sent.push(request);
				return responses.length ? responses.shift()! : release.p;
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, emptyMcpService(), new class extends mock<IRequestService>() { }, fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		const pending = runs.send('account', 'Do the work');
		await timeout(10);
		assert.deepStrictEqual(runs.getPendingDetail('account')?.plan, [
			{ step: 'Scan files', status: 'inProgress' },
			{ step: 'Write report', status: 'pending' },
		]);
		release.complete({ kind: 'reply', text: 'All done.' });
		assert.strictEqual(await pending, true);
		assert.match(String(sent.at(-1)?.messages.at(-1)?.content), /Plan updated: 0\/2 complete/);
	});

	test('carries a rejection note back to the model', async () => {
		const storage = store.add(new InMemoryStorageService());
		const sent: ReachAssistantRequest[] = [];
		const writeTool = new class extends mock<IMcpTool>() {
			override readonly id = 'mcp_notes_write';
			override readonly visibility = McpToolVisibility.Model;
			override readonly definition = { name: 'mcp_notes_write', title: 'Write note', description: 'Writes a note', annotations: { destructiveHint: true }, inputSchema: { type: 'object' } } as never;
		};
		const server = new class extends mock<IMcpServer>() {
			override readonly definition = { label: 'Notes' } as never;
			override readonly enablement = constObservable(ContributionEnablementState.EnabledWorkspace);
			override readonly serverMetadata = constObservable({ serverName: 'Notes', icons: undefined as never });
			override readonly tools = constObservable<IMcpTool[]>([writeTool]);
			override readonly prompts = constObservable([]);
		};
		const responses: ReachAssistantResponse[] = [
			{ kind: 'reply', text: '', toolCalls: [{ id: 'call-1', name: 'mcp_notes_write', arguments: '{"note":"hi"}' }] },
			{ kind: 'reply', text: 'Understood, skipped it.' },
		];
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_accountId: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				sent.push(request);
				return responses.shift()!;
			}
		};
		const mcpService = new class extends mock<IMcpService>() {
			override readonly servers = constObservable<IMcpServer[]>([server]);
		};
		const runs = store.add(new AssistantRuns(reach, storage, mcpService, new class extends mock<IRequestService>() { }, fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		store.add(runs.onDidRequestApproval(request => { runs.respondApproval(request.id, 'reject', 'Keep the note empty'); }));
		assert.strictEqual(await runs.send('account', 'Write a note'), true);
		assert.strictEqual(sent.length, 2);
		assert.match(String(sent[1].messages.at(-1)?.content), /Reason: Keep the note empty/);
		const activity = new AssistantConversationStore(storage).read('account').turns[0].activity;
		assert.deepStrictEqual(activity?.map(item => [item.status, item.detail]), [['rejected', 'Declined: Keep the note empty']]);
	});

	test('reads workspace files through the agent loop without leaving the workspace', async () => {
		const storage = store.add(new InMemoryStorageService());
		const sent: ReachAssistantRequest[] = [];
		const responses: ReachAssistantResponse[] = [
			{ kind: 'reply', text: '```tool_call\n{"name": "assistant.read_file", "arguments": {"path": "src/app.ts"}}\n```' },
			{ kind: 'reply', text: '```tool_call\n{"name": "assistant.read_file", "arguments": {"path": "../secret.txt"}}\n```' },
			{ kind: 'reply', text: 'The file exports an app.' },
		];
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_accountId: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				sent.push(request);
				return responses.shift()!;
			}
		};
		const files = fileServiceMock({ '/ws/src/app.ts': 'export const app = 1;\nexport const other = 2;' });
		const runs = store.add(new AssistantRuns(reach, storage, emptyMcpService(), new class extends mock<IRequestService>() { }, files, workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		assert.strictEqual(await runs.send('account', 'Read the app file'), true);
		const toolResults = sent.flatMap(request => request.messages.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('<tool_result')).map(m => m.content));
		assert.match(toolResults[0], /1: export const app = 1;/);
		assert.match(toolResults[1], /Paths must stay inside the workspace folder/);
	});

	test('writes workspace files after approval and blocks traversal', async () => {
		const storage = store.add(new InMemoryStorageService());
		const files: Record<string, string> = {};
		const responses: ReachAssistantResponse[] = [
			{ kind: 'reply', text: '```tool_call\n{"name": "assistant.write_file", "arguments": {"path": "notes/todo.md", "content": "# todo"}}\n```' },
			{ kind: 'reply', text: '```tool_call\n{"name": "assistant.write_file", "arguments": {"path": "../escape.txt", "content": "x"}}\n```' },
			{ kind: 'reply', text: 'Created the note; the other path was refused.' },
		];
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_accountId: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				return responses.shift()!;
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, emptyMcpService(), new class extends mock<IRequestService>() { }, fileServiceMock(files), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		store.add(runs.onDidRequestApproval(request => { runs.respondApproval(request.id, 'allow'); }));
		assert.strictEqual(await runs.send('account', 'Make a todo file'), true);
		assert.strictEqual(files['/ws/notes/todo.md'], '# todo');
		assert.strictEqual(Object.keys(files).length, 1);
		const toolResults = new AssistantConversationStore(storage).read('account').turns[0].activity;
		assert.deepStrictEqual(toolResults?.map(item => item.status), ['done', 'done']);
	});

	test('keeps an active request scoped to its starting worktree through approval', async () => {
		const storage = store.add(new InMemoryStorageService());
		const checkout = URI.parse('file:///worktree-feature');
		const project = URI.parse('file:///ws');
		const agentChats = upcastPartial<IAssistantAgentChats>({
			target: { workspace: project, worktree: { uri: checkout, label: 'feature' } },
			getWorktreeStatus: async () => 'ready',
		});
		const conversation = new AssistantConversationStore(storage);
		const taskId = conversation.createTask('account', agentChats.target);
		const files: Record<string, string> = { '/worktree-feature/.git': 'gitdir: /ws/.git/worktrees/feature', '/ws/notes.md': 'main checkout' };
		const responses: ReachAssistantResponse[] = [
			{ kind: 'reply', text: '', toolCalls: [{ id: 'write', name: 'assistant.write_file', arguments: '{"path":"notes.md","content":"feature checkout"}' }] },
			{ kind: 'reply', text: 'Updated the note.' },
			{ kind: 'reply', text: '', toolCalls: [{ id: 'resume-write', name: 'assistant.write_file', arguments: '{"path":"resumed.md","content":"resumed in feature checkout"}' }] },
			{ kind: 'reply', text: 'Resumed the task.' },
		];
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt() { return responses.shift()!; }
		};
		const runs = store.add(new AssistantRuns(reach, storage, emptyMcpService(), new class extends mock<IRequestService>() { }, fileServiceMock(files), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChats, assistantCommandStub, directMailStub, configurationStub));
		let argsPreview: string | undefined;
		store.add(runs.onDidRequestApproval(request => {
			argsPreview = request.argsPreview;
			agentChats.target = { workspace: project };
			runs.respondApproval(request.id, 'allow');
		}));
		assert.strictEqual(await runs.send('account', 'Update the note'), true);
		assert.ok(argsPreview?.includes(checkout.fsPath));
		assert.strictEqual(files['/ws/notes.md'], 'main checkout');
		assert.deepStrictEqual({ ...files }, { '/worktree-feature/.git': 'gitdir: /ws/.git/worktrees/feature', '/ws/notes.md': 'main checkout', '/worktree-feature/notes.md': 'feature checkout' });

		const reopened = store.add(new AssistantRuns(reach, storage, emptyMcpService(), new class extends mock<IRequestService>() { }, fileServiceMock(files), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChats, assistantCommandStub, directMailStub, configurationStub));
		store.add(reopened.onDidRequestApproval(request => {
			assert.ok(request.argsPreview.includes(checkout.fsPath));
			reopened.respondApproval(request.id, 'allow');
		}));
		conversation.setDraft('account', 'Unsent follow-up', taskId);
		assert.strictEqual(await reopened.send('account', 'Resume on the original checkout', taskId, { preserveDraft: true }), true);
		assert.strictEqual(conversation.read('account', taskId).draft, 'Unsent follow-up');
		assert.strictEqual(files['/worktree-feature/resumed.md'], 'resumed in feature checkout');
		assert.strictEqual(files['/ws/resumed.md'], undefined);
	});

	test('drains explicit follow-ups in order with their captured checkout and preserves a separate draft', async () => {
		const storage = store.add(new InMemoryStorageService());
		const conversation = new AssistantConversationStore(storage);
		const original = URI.file('/original-worktree');
		const other = URI.file('/other-worktree');
		const agentChats = upcastPartial<IAssistantAgentChats>({
			target: { worktree: { uri: original, label: 'original' } },
			getWorktreeStatus: async () => 'ready',
		});
		const waiting = new DeferredPromise<ReachAssistantResponse>();
		const finished = new DeferredPromise<void>();
		const submitted: string[] = [];
		const files: Record<string, string> = {};
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_account: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				const last = request.messages.at(-1);
				if (last?.role === 'tool') { return { kind: 'reply', text: 'Saved.' }; }
				const prompt = last?.content ?? '';
				submitted.push(prompt);
				if (prompt === 'First') { return waiting.p; }
				return { kind: 'reply', text: '', toolCalls: [{ id: 'write', name: 'assistant.write_file', arguments: JSON.stringify({ path: `${prompt}.txt`, content: prompt }) }] };
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, emptyMcpService(), new class extends mock<IRequestService>() { }, fileServiceMock(files), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChats, assistantCommandStub, directMailStub, configurationStub));
		store.add(runs.onDidRequestApproval(request => { runs.respondApproval(request.id, 'allow'); }));
		store.add(runs.onDidChange(account => {
			if (!runs.getPending(account) && conversation.read(account).turns.length === 3) { void finished.complete(); }
		}));
		const first = runs.send('account', 'First');
		assert.ok(runs.queuePrompt('account', 'Second'));
		assert.ok(runs.queuePrompt('account', 'Third'));
		assert.deepStrictEqual(conversation.read('account').queuedPrompts?.map(item => item.prompt), ['Second', 'Third']);
		agentChats.target = { worktree: { uri: other, label: 'other' } };
		conversation.setDraft('account', 'Draft to keep');
		await waiting.complete({ kind: 'reply', text: 'First finished.' });
		assert.ok(await first);
		await finished.p;
		assert.deepStrictEqual(submitted, ['First', 'Second', 'Third']);
		assert.deepStrictEqual(files, { '/original-worktree/Second.txt': 'Second', '/original-worktree/Third.txt': 'Third' });
		assert.strictEqual(conversation.read('account').draft, 'Draft to keep');
	});

	test('keeps queued messages paused after a stop and across a new runs service', async () => {
		const storage = store.add(new InMemoryStorageService());
		const conversation = new AssistantConversationStore(storage);
		const waiting = new DeferredPromise<ReachAssistantResponse>();
		const requests: string[] = [];
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_account: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				const prompt = request.messages.at(-1)?.content ?? '';
				requests.push(prompt);
				return prompt === 'Stop this' ? waiting.p : { kind: 'reply', text: 'Sent explicitly.' };
			}
		};
		const createRuns = () => store.add(new AssistantRuns(reach, storage, emptyMcpService(), new class extends mock<IRequestService>() { }, fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		const runs = createRuns();
		const pending = runs.send('account', 'Stop this');
		assert.ok(runs.queuePrompt('account', 'Keep this'));
		runs.stop('account');
		await waiting.complete({ kind: 'stopped' });
		assert.strictEqual(await pending, false);
		assert.deepStrictEqual(requests, ['Stop this']);
		const reopened = createRuns();
		assert.strictEqual(reopened.getPending('account'), undefined);
		assert.strictEqual(conversation.read('account').queuedPrompts?.[0].prompt, 'Keep this');
		const finished = new DeferredPromise<void>();
		store.add(reopened.onDidChange(account => {
			if (!reopened.getPending(account) && conversation.read(account).turns.length) { void finished.complete(); }
		}));
		assert.ok(reopened.sendQueuedPrompt('account'));
		await finished.p;
		assert.deepStrictEqual(requests, ['Stop this', 'Keep this']);
	});

	test('searches workspace contents through the search service', async () => {
		const storage = store.add(new InMemoryStorageService());
		const responses: ReachAssistantResponse[] = [
			{ kind: 'reply', text: '```tool_call\n{"name": "assistant.search_files", "arguments": {"pattern": "reachAssistant"}}\n```' },
			{ kind: 'reply', text: 'It lives in the platform layer.' },
		];
		const queries: unknown[] = [];
		const search = new class extends mock<ISearchService>() {
			override async textSearch(query: unknown) {
				queries.push(query);
				return {
					results: [{
						resource: URI.parse('file:///ws/src/app.ts'),
						results: [{ previewText: '  const reachAssistant = 1;  ', rangeLocations: [{ source: { startLineNumber: 4, startColumn: 0, endLineNumber: 4, endColumn: 0 }, preview: { startLineNumber: 4, startColumn: 0, endLineNumber: 4, endColumn: 0 } }] }],
					}],
					limitHit: false, messages: [], stats: undefined,
				} as never;
			}
		};
		const sent: ReachAssistantRequest[] = [];
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_accountId: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				sent.push(request);
				return responses.shift()!;
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, emptyMcpService(), new class extends mock<IRequestService>() { }, fileServiceMock(), workspaceServiceMock(), search, quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		assert.strictEqual(await runs.send('account', 'Find reachAssistant'), true);
		assert.strictEqual(queries.length, 1);
		const query = queries[0] as { contentPattern: { pattern: string }; folderQueries: { folder: URI }[] };
		assert.strictEqual(query.contentPattern.pattern, 'reachAssistant');
		assert.strictEqual(query.folderQueries[0].folder.toString(), 'file:///ws');
		const toolResults = sent.flatMap(request => request.messages.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('<tool_result')).map(m => m.content));
		assert.match(toolResults[0], /src\/app\.ts:5: const reachAssistant = 1;/);
	});

	test('starts a linked task through the agent loop after approval', async () => {
		const storage = store.add(new InMemoryStorageService());
		const checkout = URI.parse('file:///research-feature');
		const agentChats = upcastPartial<IAssistantAgentChats>({ target: { workspace: URI.parse('file:///ws'), worktree: { uri: checkout, label: 'research' } } });
		const responses: ReachAssistantResponse[] = [
			{ kind: 'reply', text: '```tool_call\n{"name": "assistant.create_task", "arguments": {"title": "Research", "instructions": "Look into the search API"}}\n```' },
			{ kind: 'reply', text: 'Started the research task.' },
			{ kind: 'reply', text: 'Task working.' },
		];
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_accountId: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				return responses.shift() ?? { kind: 'reply', text: 'Done.' };
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, emptyMcpService(), new class extends mock<IRequestService>() { }, fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChats, assistantCommandStub, directMailStub, configurationStub));
		store.add(runs.onDidRequestApproval(request => {
			agentChats.target = { workspace: URI.parse('file:///other-project') };
			runs.respondApproval(request.id, 'allow');
		}));
		assert.strictEqual(await runs.send('account', 'Kick off research'), true);
		const tasks = new AssistantConversationStore(storage).read('account').tasks;
		assert.strictEqual(tasks?.length, 1);
		assert.strictEqual(tasks?.[0].title, 'Research');
		assert.strictEqual(readAssistantTaskTarget(tasks?.[0])?.worktree?.uri.toString(), checkout.toString());
	});

	test('edits workspace files with unique-match guards', async () => {
		const storage = store.add(new InMemoryStorageService());
		const files: Record<string, string> = { '/ws/src/app.ts': 'let x = 1;\nlet y = 2;\nlet x = 3;' };
		const responses: ReachAssistantResponse[] = [
			{ kind: 'reply', text: '```tool_call\n{"name": "assistant.edit_file", "arguments": {"path": "src/app.ts", "old_text": "let x", "new_text": "const x"}}\n```' },
			{ kind: 'reply', text: '```tool_call\n{"name": "assistant.edit_file", "arguments": {"path": "src/app.ts", "old_text": "let y = 2;", "new_text": "const y = 4;"}}\n```' },
			{ kind: 'reply', text: 'Updated the y declaration; x was ambiguous.' },
		];
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_accountId: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				return responses.shift()!;
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, emptyMcpService(), new class extends mock<IRequestService>() { }, fileServiceMock(files), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		store.add(runs.onDidRequestApproval(request => { runs.respondApproval(request.id, 'allow'); }));
		assert.strictEqual(await runs.send('account', 'Fix the declarations'), true);
		assert.strictEqual(files['/ws/src/app.ts'], 'let x = 1;\nconst y = 4;\nlet x = 3;');
	});

	test('opens a workspace file at the requested line and column', async () => {
		const storage = store.add(new InMemoryStorageService());
		let opened: URI | string | undefined;
		const openerService = new class extends mock<IOpenerService>() {
			override async open(target: URI | string) { opened = target; return true; }
		};
		const catalog = collectAssistantTools({
			accountId: 'account', store: new AssistantConversationStore(storage), mcpService: emptyMcpService(),
			requestService: new class extends mock<IRequestService>() { }, fileService: fileServiceMock({ '/ws/src/app.ts': 'const ready = true;' }),
			workspaceService: workspaceServiceMock(), searchService: searchServiceMock(), openerService,
		});
		const tool = catalog.entries.get('assistant.open_file');
		assert.ok(tool?.kind === 'builtin');
		assert.strictEqual(await tool.run({ path: 'src/app.ts', line: 3, column: 2 }, CancellationToken.None), 'Opened app.ts at line 3 in the editor.');
		assert.deepStrictEqual(opened, URI.parse('file:///ws/src/app.ts#3,2'));
	});

	test('restores named workspace roots and returns searchable paths that read the right file', async () => {
		const storage = store.add(new InMemoryStorageService());
		const conversation = new AssistantConversationStore(storage);
		const fileRoots = [URI.file('/api/shared'), URI.file('/web/shared')];
		const markers = fileRoots.map(root => URI.joinPath(root, 'marker.txt'));
		const taskId = conversation.createTask('account', { fileRoots, fileRootNames: ['API', 'Web UI'], activeEditorFile: markers[0] });
		const target = readAssistantTaskTarget(conversation.read('account').tasks?.find(task => task.id === taskId));
		assert.deepStrictEqual(target?.fileRootNames, ['API', 'Web UI']);
		assert.strictEqual(target?.activeEditorFile?.toString(), markers[0].toString());
		const catalog = collectAssistantTools({
			accountId: 'account', store: conversation, mcpService: emptyMcpService(),
			requestService: new class extends mock<IRequestService>() { },
			fileService: fileServiceMock({ '/api/shared/marker.txt': 'API marker', '/web/shared/marker.txt': 'Web marker' }),
			workspaceService: workspaceServiceMock(), openerService: openerStub, agentChatTarget: target,
			searchService: upcastPartial<ISearchService>({
				fileSearch: async query => {
					assert.deepStrictEqual(query.folderQueries.map(folder => folder.folder.toString()), fileRoots.map(root => root.toString()));
					return { results: markers.map(resource => ({ resource })), messages: [] };
				},
			}),
		});
		const find = catalog.entries.get('assistant.find_files');
		const read = catalog.entries.get('assistant.read_file');
		assert.ok(find?.kind === 'builtin' && read?.kind === 'builtin');
		const paths = (await find.run({ pattern: 'marker.txt' }, CancellationToken.None)).split('\n');
		assert.deepStrictEqual(paths, ['API/marker.txt', 'Web UI/marker.txt']);
		for (const [i, marker] of ['API marker', 'Web marker'].entries()) {
			assert.strictEqual(await read.run({ path: paths[i] }, CancellationToken.None), '1: ' + marker);
		}
		assert.strictEqual(await read.run({ path: 'marker.txt' }, CancellationToken.None), '1: API marker');
		assert.match(await read.run({ path: 'shared/marker.txt' }, CancellationToken.None), /ambiguous/);
		assert.match(await read.run({ path: 'Web UI/../secret.txt' }, CancellationToken.None), /stay inside/);
	});

	test('gives duplicate root names stable prefixes that avoid existing names', () => {
		const fileRoots = [URI.file('/api/shared'), URI.file('/web/shared'), URI.file('/tests/shared (1)')];
		const folders = getAssistantWorkspaceFolders(workspaceServiceMock(), { fileRoots });
		assert.deepStrictEqual(folders.map(folder => folder.name), ['shared (2)', 'shared (3)', 'shared (1)']);
		assert.match(String(resolveAssistantWorkspacePath(folders, 'shared/check.txt')), /ambiguous/);
		assert.deepStrictEqual(resolveAssistantWorkspacePath(folders, 'shared (3)/check.txt'), URI.file('/web/shared/check.txt'));
	});

	if (isWindows) {
		test('formats live Windows editor paths against restored roots with lowercase drive letters', () => {
			const roots = [
				{ uri: URI.parse('file:///d:/fixture/service'), name: 'Service', originalName: 'Service' },
				{ uri: URI.parse('file:///d:/fixture/ui'), name: 'UI', originalName: 'UI' },
			];
			const liveFile = URI.file('D:\\fixture\\service\\main.ts');
			assert.strictEqual(formatAssistantWorkspacePath(roots, liveFile), 'Service/main.ts');
			assert.strictEqual(formatAssistantWorkspacePath(roots, URI.file('E:\\fixture\\service\\main.ts')), undefined);
			assert.strictEqual(formatAssistantWorkspacePath(roots, URI.file('D:\\fixture\\Service\\main.ts')), undefined);
		});
	}

	test('lists and reads linked tasks by id', async () => {
		const storage = store.add(new InMemoryStorageService());
		const conversation = new AssistantConversationStore(storage);
		const taskId = conversation.createTask('account');
		conversation.updateTask('account', taskId, { title: 'Research', status: 'completed', update: 'Found the API.' });
		conversation.appendTurn('account', { prompt: 'Look into the search API', reply: 'ISearchService does it.' }, taskId);
		const responses: ReachAssistantResponse[] = [
			{ kind: 'reply', text: '```tool_call\n{"name": "assistant.list_tasks", "arguments": {}}\n```' },
			{ kind: 'reply', text: '```tool_call\n{"name": "assistant.read_task", "arguments": {"id": "' + taskId + '"}}\n```' },
			{ kind: 'reply', text: 'Research found ISearchService.' },
		];
		const sent: ReachAssistantRequest[] = [];
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_accountId: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				sent.push(request);
				return responses.shift()!;
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, emptyMcpService(), new class extends mock<IRequestService>() { }, fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		assert.strictEqual(await runs.send('account', 'How is research going?'), true);
		const toolResults = sent.flatMap(request => request.messages.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('<tool_result')).map(m => m.content));
		assert.match(toolResults[0], /Research \[completed\] \(id: /);
		assert.match(toolResults[1], /ISearchService does it\./);
	});

	test('declines write actions without asking in safe-only mode', async () => {
		const storage = store.add(new InMemoryStorageService());
		const writeTool = new class extends mock<IMcpTool>() {
			override readonly id = 'mcp_notes_write';
			override readonly visibility = McpToolVisibility.Model;
			override readonly definition = { name: 'mcp_notes_write', annotations: { destructiveHint: true }, inputSchema: { type: 'object' } } as never;
			override call(): never { throw new Error('must not run'); }
		};
		const server = new class extends mock<IMcpServer>() {
			override readonly definition = { label: 'Notes' } as never;
			override readonly enablement = constObservable(ContributionEnablementState.EnabledWorkspace);
			override readonly serverMetadata = constObservable({ serverName: 'Notes', icons: undefined as never });
			override readonly tools = constObservable<IMcpTool[]>([writeTool]);
			override readonly prompts = constObservable([]);
		};
		const mcpService = new class extends mock<IMcpService>() {
			override readonly servers = constObservable<IMcpServer[]>([server]);
		};
		const conversation = new AssistantConversationStore(storage);
		conversation.allowTool('account', 'mcp_notes_write');
		conversation.setPermissionMode('account', 'safeOnly');
		const responses: ReachAssistantResponse[] = [
			{ kind: 'reply', text: '```tool_call\n{"name": "mcp_notes_write", "arguments": {"note":"x"}}\n```' },
			{ kind: 'reply', text: 'I could not write it — writes are disabled in this thread.' },
		];
		let approvalAsked = false;
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(_accountId: string, request: ReachAssistantRequest): Promise<ReachAssistantResponse> {
				return responses.shift()!;
			}
		};
		const runs = store.add(new AssistantRuns(reach, storage, mcpService, new class extends mock<IRequestService>() { }, fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChatsStub, assistantCommandStub, directMailStub, configurationStub));
		store.add(runs.onDidRequestApproval(() => { approvalAsked = true; }));
		assert.strictEqual(await runs.send('account', 'Write a note'), true);
		assert.strictEqual(approvalAsked, false);
		const activity = new AssistantConversationStore(storage).read('account').turns[0].activity;
		assert.deepStrictEqual(activity?.map(item => item.status), ['rejected']);
		assert.deepStrictEqual(conversation.read('account').allowedTools, ['mcp_notes_write']);
	});

	test('requires approval when an agent launch grant is revoked while Assistant is waiting for a model reply', async () => {
		const storage = store.add(new InMemoryStorageService());
		const conversation = new AssistantConversationStore(storage);
		conversation.allowTool('account', 'assistant.start_agent');
		const toolReply = new DeferredPromise<ReachAssistantResponse>();
		let requests = 0;
		const reach = new class extends mock<IReachSubscriptionConnection>() {
			override readonly onDidChangeAccount = Event.None;
			override async sendAssistantPrompt(): Promise<ReachAssistantResponse> {
				return requests++ === 0 ? toolReply.p : { kind: 'reply', text: 'Done.' };
			}
		};
		let launches = 0;
		const agentChats = upcastPartial<IAssistantAgentChats>({ start: async () => { launches++; return 'Started an agent'; } });
		const runs = store.add(new AssistantRuns(reach, storage, emptyMcpService(), new class extends mock<IRequestService>() { }, fileServiceMock(), workspaceServiceMock(), searchServiceMock(), quickInputStub, openerStub, agentChats, assistantCommandStub, directMailStub, configurationStub));
		const approvals: string[] = [];
		store.add(runs.onDidRequestApproval(request => {
			approvals.push(request.tool);
			runs.respondApproval(request.id, 'reject');
		}));
		const pending = runs.send('account', 'Start an agent');
		assert.strictEqual(requests, 1);
		conversation.setAllowedTools('account', []);
		await toolReply.complete({ kind: 'reply', text: '', toolCalls: [{ id: 'launch', name: 'assistant.start_agent', arguments: '{"prompt":"Check the build"}' }] });
		assert.strictEqual(await pending, true);
		assert.deepStrictEqual(approvals, ['assistant.start_agent']);
		assert.strictEqual(launches, 0);
	});

	test('remembers the worktree by local project and account, including when opened from its checkout', () => {
		const storage = store.add(new InMemoryStorageService());
		const project = URI.file('/project');
		const checkout = { uri: URI.file('/project-feature'), label: 'feature', identity: { gitDirectory: URI.file('/project/.git/worktrees/feature'), createdAt: 1 } };
		const first = new AssistantConversationStore(storage);
		first.setWorktreeSelection('account-a', project, checkout);
		first.setLastWorktreeProject('account-a', project);
		first.setWorktreeSelection('legacy-account', project, { uri: checkout.uri, label: checkout.label });

		const reopened = new AssistantConversationStore(storage);
		assert.strictEqual(reopened.getLastWorktreeProject('account-a')?.toString(), project.toString());
		for (const folder of [project, checkout.uri]) {
			const selection = reopened.getWorktreeSelection('account-a', folder);
			assert.ok(selection);
			assert.strictEqual(selection.project.toString(), project.toString());
			assert.strictEqual(selection.worktree.uri.toString(), checkout.uri.toString());
			assert.strictEqual(selection.worktree.label, checkout.label);
			assert.strictEqual(selection.worktree.identity?.gitDirectory.toString(), checkout.identity.gitDirectory.toString());
			assert.strictEqual(selection.worktree.identity.createdAt, checkout.identity.createdAt);
		}
		assert.strictEqual(reopened.getWorktreeSelection('account-a', URI.file('/other-project')), undefined);
		assert.strictEqual(reopened.getWorktreeSelection('account-b', project), undefined);
		assert.strictEqual(reopened.getLastWorktreeProject('account-b'), undefined);
		const legacy = reopened.getWorktreeSelection('legacy-account', project)?.worktree;
		assert.strictEqual(legacy?.uri.toString(), checkout.uri.toString());
		assert.strictEqual(legacy.identity, undefined);
		reopened.setWorktreeSelection('account-a', project, undefined);
		assert.strictEqual(reopened.getWorktreeSelection('account-a', checkout.uri), undefined);
	});

	test('restores the last open task only for its account and project', () => {
		const storage = store.add(new InMemoryStorageService());
		const first = new AssistantConversationStore(storage);
		const project = URI.file('/project');
		const other = URI.file('/other-project');
		const task = first.createTask('account-a');
		first.setLastOpenTask('account-a', project, task);
		const reopened = new AssistantConversationStore(storage);
		assert.strictEqual(reopened.getLastOpenTask('account-a', project), task);
		assert.strictEqual(reopened.getLastOpenTask('account-a', other), undefined);
		assert.strictEqual(reopened.getLastOpenTask('account-a', undefined), undefined);
		assert.strictEqual(reopened.getLastOpenTask('account-b', project), undefined);
		reopened.setLastOpenTask('account-a', project, undefined);
		assert.strictEqual(reopened.getLastOpenTask('account-a', project), undefined);

		reopened.setLastOpenTask('account-a', undefined, task);
		assert.strictEqual(reopened.getLastOpenTask('account-a', undefined), task);
		assert.strictEqual(reopened.getLastOpenTask('account-a', project), undefined);
		reopened.deleteTask('account-a', task);
		assert.strictEqual(reopened.getLastOpenTask('account-a', undefined), undefined);
	});

	test('uses the same conversation after reopening and keeps other accounts separate', () => {
		const storage = store.add(new InMemoryStorageService());
		const first = new AssistantConversationStore(storage);
		first.setInstructions('account-a', 'Keep replies short.');
		first.appendTurn('account-a', { prompt: 'Start here.', reply: 'Ready.' });
		first.appendTurn('account-b', { prompt: 'Another account.', reply: 'Ready.' });
		const reopened = new AssistantConversationStore(storage);
		reopened.appendTurn('account-a', { prompt: 'Continue.', reply: 'Continuing.' });
		const strip = (account: string) => {
			const convo = reopened.read(account);
			return { ...convo, turns: convo.turns.map(({ at: _at, ...turn }) => turn) };
		};
		assert.deepStrictEqual(strip('account-a'), {
			instructions: 'Keep replies short.',
			turns: [{ prompt: 'Start here.', reply: 'Ready.' }, { prompt: 'Continue.', reply: 'Continuing.' }],
		});
		assert.ok(reopened.read('account-a').turns.every(turn => typeof turn.at === 'number'));
		assert.deepStrictEqual(strip('account-b'), {
			instructions: '', turns: [{ prompt: 'Another account.', reply: 'Ready.' }],
		});
	});
});
