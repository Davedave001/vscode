/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Schemas } from '../../../../base/common/network.js';
import { derived, IObservable, IReader } from '../../../../base/common/observable.js';
import { isWindows } from '../../../../base/common/platform.js';
import { basename, isEqualOrParent, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { isContributionEnabled } from '../../../../workbench/contrib/chat/common/enablement.js';
import { IMcpServer, IMcpService, IMcpTool, McpConnectionState, McpServerTransportType, McpToolVisibility } from '../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { MCP } from '../../../../workbench/contrib/mcp/common/modelContextProtocol.js';
import { ISignalCDirectMail, ISignalCDirectMailConnection } from '../../../../workbench/contrib/mcp/browser/signalCDirectMail.js';
import { findSignalCAppConnection, ISignalCAppConnection, microsoft365WorkIq, signalCDirectMailConnections } from '../../../../workbench/contrib/mcp/common/signalCAppConnections.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { asTextOrError, IRequestService, NO_FETCH_TELEMETRY } from '../../../../platform/request/common/request.js';
import { AssistantNewsFeed, AssistantNewsScope, AssistantWeatherDay, AssistantWeatherForecast, AssistantWeatherLocation, normalizeAssistantWeatherLocation, ReachAssistantToolCall, ReachAssistantToolSpec } from '../../../../platform/native/common/native.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IOpenerService, withSelection } from '../../../../platform/opener/common/opener.js';
import { ISearchService, ITextQuery, QueryType, resultIsMatch } from '../../../../workbench/services/search/common/search.js';
import { assistantWorktreeError, type IAssistantAgentChats, type IAssistantAgentTarget } from './assistantAgentChats.js';
import { AssistantConversationStore, IAssistantPlanItem } from './assistantConversation.js';
import { ASSISTANT_NEWS_TOOL, getAssistantNewsHeadlines } from './assistantNews.js';
import { ASSISTANT_WEATHER_LOCATION_SETTING } from '../../../../workbench/contrib/sessions/common/sessionConfig.js';

const MAX_TOOLS = 32;
const MAX_FETCH_CHARS = 6_000;
export const ASSISTANT_WEATHER_TOOL = 'assistant.get_weather_forecast';
export const ASSISTANT_SET_WEATHER_LOCATION_TOOL = 'assistant.set_weather_location';
const CONNECTED_HISTORY_BUILTINS = new Set(['assistant.find_app_tools', 'assistant.list_connection_sources', 'assistant.get_current_time', 'assistant.propose_memory', ASSISTANT_NEWS_TOOL, ASSISTANT_WEATHER_TOOL]);
const WORK_IQ_READ_TOOLS = new Set(['fetch', 'get_schema', 'search_paths', 'retrieve']);
const WORK_IQ_APP_NAMES = microsoft365WorkIq.aliases.join('\n').toLowerCase();

export type AssistantToolEntry =
	| { readonly kind: 'mcp'; readonly name: string; readonly label: string; readonly safe: boolean; readonly tool: IMcpTool; readonly connectionId?: string }
	| { readonly kind: 'directMail'; readonly name: string; readonly label: string; readonly safe: true; readonly connectionId: string; readonly run: (args: Record<string, unknown>, token: CancellationToken) => Promise<string> }
	| { readonly kind: 'builtin'; readonly name: string; readonly label: string; readonly safe: boolean; readonly run: (args: Record<string, unknown>, token: CancellationToken) => Promise<string> };

export interface IAssistantToolContext {
	readonly accountId: string;
	readonly taskId?: string;
	readonly store: AssistantConversationStore;
	readonly requestService: IRequestService;
	readonly readNewsFeeds?: (scope: AssistantNewsScope) => Promise<readonly AssistantNewsFeed[]>;
	readonly readWeatherForecast?: (day: AssistantWeatherDay, location: AssistantWeatherLocation) => Promise<AssistantWeatherForecast>;
	readonly configuration?: IConfigurationService;
	readonly mcpService: IMcpService;
	readonly directMail?: ISignalCDirectMail;
	/** Lets discovery wait briefly for the quiet MCP startup already running for this turn. */
	readonly waitForAppTools?: (token: CancellationToken, ready?: IObservable<boolean>) => Promise<void>;
	readonly fileService: IFileService;
	readonly workspaceService: IWorkspaceContextService;
	readonly searchService: ISearchService;
	readonly openerService: IOpenerService;
	readonly agentChats?: IAssistantAgentChats;
	readonly agentChatTarget?: IAssistantAgentTarget;
	/** Opens the native setup UI for an app selected from the published catalog. */
	readonly connectApp?: (appId: string) => boolean;
	/** Starts a linked task conversation in the background; returns false if it could not start. */
	readonly startTask?: (taskId: string, prompt: string) => boolean;
	/** Asks the user a question and resolves with the answer; undefined when dismissed. */
	readonly askUser?: (question: string, options?: readonly string[]) => Promise<string | undefined>;
	/** Replaces the live plan checklist shown while a run executes. */
	readonly setPlan?: (items: readonly IAssistantPlanItem[]) => void;
	readonly connectedHistory?: boolean;
	readonly allowedServerIds?: ReadonlySet<string>;
	/** Stages a proposed routine for the user to edit and save. */
	readonly proposeRoutine?: (args: Record<string, unknown>) => string;
	/** Stages a sourced memory for review after a learning run. */
	readonly proposeMemory?: (note: string, tool: string, reference: string) => string;
}

export function readAssistantWeatherLocation(configuration: IConfigurationService | undefined): AssistantWeatherLocation | undefined {
	const value = configuration?.getValue<string>(ASSISTANT_WEATHER_LOCATION_SETTING);
	if (typeof value !== 'string') { return undefined; }
	const parts = value.split(',');
	if (parts.length < 2 || parts.length > 3) { return undefined; }
	const [city, regionOrCountry, country] = parts;
	return normalizeAssistantWeatherLocation(country === undefined
		? { city, country: regionOrCountry }
		: { city, subdivision: regionOrCountry, country });
}

export function assistantConnectionKey(server: IMcpServer): string {
	return JSON.stringify([server.collection.id, server.definition.id]);
}

export function findAssistantAppConnection(nameOrId: string): ISignalCAppConnection | undefined {
	const key = nameOrId.trim().toLowerCase();
	return Object.values(signalCDirectMailConnections).find(app => app.id === key || app.name.toLowerCase() === key)
		?? (['outlook', 'outlook.com', 'outlook (direct)', 'microsoft 365', 'microsoft 365 mail'].includes(key) ? signalCDirectMailConnections.outlook : key === 'gmail' ? signalCDirectMailConnections.gmail : findSignalCAppConnection(key));
}

function connectionProblem(server: IMcpServer, reader?: IReader): { reason: string; needsSignIn?: true } | undefined {
	if (!isContributionEnabled(server.enablement.read(reader))) {
		return { reason: localize('assistantTools.connectionDisabled', "Disabled") };
	}
	const state = server.connectionState.read(reader);
	if (McpConnectionState.needsSignIn(state)) {
		return { reason: McpConnectionState.toString(state), needsSignIn: true };
	}
	if (state.state === McpConnectionState.Kind.Error) {
		return { reason: localize('assistantTools.connectionError', "Connection error") };
	}
	return undefined;
}

interface IAssistantUnavailableConnection {
	readonly id?: string;
	readonly name: string;
	readonly reason: string;
	readonly needsSignIn?: true;
}

export function assistantUnavailableConnections(mcp: IMcpService, selected?: ReadonlySet<string>, checked?: ReadonlySet<string>, directMail?: readonly ISignalCDirectMailConnection[]): IAssistantUnavailableConnection[] {
	const missing = new Set(selected);
	const unavailable: IAssistantUnavailableConnection[] = [];
	for (const mail of directMail ?? []) {
		missing.delete(mail.id);
		if (mail.needsSignIn && !checked?.has(mail.id) && (!selected || selected.has(mail.id))) {
			unavailable.push({ id: mail.id, name: mail.label, reason: localize('assistantTools.mailSignIn', "Sign-in required"), needsSignIn: true });
		}
	}
	for (const server of mcp.servers.get()) {
		const id = assistantConnectionKey(server);
		missing.delete(id);
		if (checked?.has(id) || (selected ? !selected.has(id) : !isContributionEnabled(server.enablement.get()))) { continue; }
		const problem = connectionProblem(server);
		if (problem) { unavailable.push({ id, name: server.definition.label, ...problem }); }
	}
	for (const id of checked ?? []) { missing.delete(id); }
	if (missing.size) {
		const name = missing.size === 1 ? localize('assistantTools.oneMissingConnection', "1 saved connection") : localize('assistantTools.missingConnections', "{0} saved connections", missing.size);
		unavailable.push({ name, reason: localize('assistantTools.connectionRemoved', "No longer configured") });
	}
	return unavailable;
}

export interface IAssistantToolCatalog {
	readonly entries: ReadonlyMap<string, AssistantToolEntry>;
	readonly specs: readonly ReachAssistantToolSpec[];
	/** One-line-per-tool summary for the system prompt, used by models without native function calls. */
	readonly index: string;
	/** Usage guidance published by connected MCP servers, for the system prompt. */
	readonly instructions: readonly string[];
}

export function isWorkIqMcpServer(server: IMcpServer, reader?: IReader): boolean {
	const launch = server.readDefinitions?.().read(reader).server?.launch;
	return launch?.type === McpServerTransportType.HTTP && launch.uri.toString(true).replace(/\/$/, '') === microsoft365WorkIq.url;
}

export function safeMcpTool(tool: IMcpTool, workIq = false): boolean {
	const annotations = tool.definition.annotations;
	if (workIq) {
		return annotations?.destructiveHint !== true && annotations?.readOnlyHint !== false && WORK_IQ_READ_TOOLS.has(tool.definition.name);
	}
	return annotations?.readOnlyHint === true && annotations.destructiveHint !== true;
}

function getAssistantWorkspaceRoots(workspaceService: IWorkspaceContextService, target: IAssistantAgentTarget | undefined): URI[] {
	return target?.worktree ? [target.worktree.uri] : target?.fileRoots ? [...target.fileRoots] : workspaceService.getWorkspace().folders.map(folder => folder.uri);
}

export function captureAssistantTaskTarget(workspaceService: IWorkspaceContextService, target: IAssistantAgentTarget | undefined): IAssistantAgentTarget {
	if (target?.fileRoots) { return { ...target }; }
	const folders = workspaceService.getWorkspace().folders;
	return { ...target, fileRoots: folders.map(folder => folder.uri), fileRootNames: folders.map(folder => folder.name) };
}

export interface IAssistantWorkspaceFolder {
	readonly uri: URI;
	readonly name: string;
	readonly originalName: string;
}

/** Produces unambiguous path prefixes from the folder names saved with the task. */
export function getAssistantWorkspaceFolders(workspaceService: IWorkspaceContextService, target: IAssistantAgentTarget | undefined): readonly IAssistantWorkspaceFolder[] {
	const roots = getAssistantWorkspaceRoots(workspaceService, target);
	const names = target?.worktree ? [target.worktree.label] : target?.fileRoots ? target.fileRootNames : workspaceService.getWorkspace().folders.map(folder => folder.name);
	const validName = (value: string | undefined) => {
		const name = value?.trim();
		return name && name !== '.' && name !== '..' && !/[\\/]/.test(name) && !Array.from(name).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
			? name : undefined;
	};
	const labels = roots.map((uri, i) => validName(names?.[i]) ?? validName(basename(uri)) ?? `Folder ${i + 1}`);
	const counts = new Map<string, number>();
	for (const label of labels) { counts.set(label, (counts.get(label) ?? 0) + 1); }
	const assigned = new Set(labels);
	const suffixes = new Map<string, number>();
	return roots.map((uri, i) => {
		const originalName = labels[i];
		if (counts.get(originalName) === 1) { return { uri, name: originalName, originalName }; }
		let suffix = suffixes.get(originalName) ?? 0;
		let name: string;
		do { name = `${originalName} (${++suffix})`; } while (assigned.has(name));
		suffixes.set(originalName, suffix);
		assigned.add(name);
		return { uri, name, originalName };
	});
}

export function resolveAssistantWorkspacePath(folders: readonly IAssistantWorkspaceFolder[], path: unknown): URI | string {
	if (!folders.length) { return localize('assistantTools.noWorkspaceFolder', "No workspace folder is open."); }
	let relative = typeof path === 'string' && path.trim() ? path.trim() : '.';
	let root = folders[0].uri;
	if (folders.length > 1) {
		const [head, ...rest] = relative.split('/');
		let named = folders.find(folder => folder.name === head);
		if (!named && rest.length) {
			const matches = folders.filter(folder => folder.originalName === head || basename(folder.uri) === head);
			if (matches.length > 1) {
				return localize('assistantTools.ambiguousWorkspaceFolder', "Workspace folder \"{0}\" is ambiguous. Use a name from this list as the path prefix: {1}.", head, matches.map(folder => JSON.stringify(folder.name)).join(', '));
			}
			named = matches[0];
		}
		if (named) { root = named.uri; relative = rest.join('/') || '.'; }
	}
	const uri = URI.joinPath(root, relative);
	return isEqualOrParent(uri, root) ? uri : localize('assistantTools.outsideWorkspaceFolder', "Paths must stay inside the workspace folder.");
}

export function formatAssistantWorkspacePath(folders: readonly IAssistantWorkspaceFolder[], resource: URI): string | undefined {
	// A live editor URI and a URI restored from a task can use different drive-letter casing.
	const canonical = (uri: URI) => isWindows && uri.scheme === Schemas.file && !uri.authority && /^\/[A-Z]:/.test(uri.path) ? URI.parse(uri.toString()) : uri;
	const file = canonical(resource);
	let containing: IAssistantWorkspaceFolder | undefined;
	for (const folder of folders) {
		if (isEqualOrParent(file, canonical(folder.uri)) && (!containing || folder.uri.path.length > containing.uri.path.length)) {
			containing = folder;
		}
	}
	const relative = containing && relativePath(canonical(containing.uri), file);
	return relative !== undefined && containing ? folders.length > 1 ? `${containing.name}/${relative}` : relative : undefined;
}

function parameterSummary(schema: unknown): string {
	const parameters = schema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] } | undefined;
	const properties = parameters?.properties;
	if (!properties) { return ''; }
	const required = new Set(Array.isArray(parameters?.required) ? parameters.required : []);
	const parts = Object.keys(properties).slice(0, 8).map(key => `${key}${required.has(key) ? '' : '?'}:${properties[key]?.type ?? 'any'}`);
	return parts.length ? ` (args: ${parts.join(', ')})` : '';
}

interface IAssistantAppTool {
	readonly app: string;
	readonly connectionLabel: string;
	readonly spec: ReachAssistantToolSpec;
	readonly entry: AssistantToolEntry;
	readonly guidance?: string;
}

export function collectAssistantTools(context: IAssistantToolContext): IAssistantToolCatalog {
	const entries = new Map<string, AssistantToolEntry>();
	const specs: ReachAssistantToolSpec[] = [];
	const indexLines: string[] = [];
	const instructions: string[] = [];
	let appTools: readonly IAssistantAppTool[] = [];
	let builtinToolCount = 0;
	let appFilter: ((tool: typeof appTools[number]) => boolean) | undefined;
	const offerAppTools = (tools: readonly IAssistantAppTool[]) => {
		specs.length = builtinToolCount;
		indexLines.length = builtinToolCount;
		const guidanceByApp = new Set<string>();
		for (const { spec, guidance } of tools.slice(0, MAX_TOOLS - builtinToolCount)) {
			specs.push(spec);
			indexLines.push(`- ${spec.name}: ${spec.description}${parameterSummary(spec.parameters)}`);
			if (guidance) { guidanceByApp.add(guidance); }
		}
		instructions.length = 0;
		instructions.push(...guidanceByApp);
	};
	const push = (entry: AssistantToolEntry, spec: ReachAssistantToolSpec) => {
		if (context.connectedHistory && !CONNECTED_HISTORY_BUILTINS.has(entry.name)) { return; }
		if (entries.has(entry.name) || entries.size >= MAX_TOOLS) { return; }
		entries.set(entry.name, entry);
		specs.push(spec);
		indexLines.push(`- ${entry.name}: ${spec.description}${parameterSummary(spec.parameters)}`);
	};
	const stringArg = (args: Record<string, unknown>, key: string) => typeof args[key] === 'string' ? args[key].trim() : '';
	const readNewsFeeds = context.readNewsFeeds;
	const readWeatherForecast = context.readWeatherForecast;
	if (readWeatherForecast) {
		const locationProperties = {
			city: { type: 'string', description: 'City name, e.g. Vancouver or New York.' },
			country: { type: 'string', description: 'Two-letter ISO country code, e.g. CA, US, or FR.' },
			subdivision: { type: 'string', description: 'Province, state, or region code when needed to distinguish cities, e.g. BC or NY.' },
		};
		const locationFromArgs = (args: Record<string, unknown>): AssistantWeatherLocation => ({
			city: stringArg(args, 'city'),
			country: stringArg(args, 'country'),
			subdivision: stringArg(args, 'subdivision') || undefined,
		});
		push({
			kind: 'builtin', name: ASSISTANT_WEATHER_TOOL, label: localize('assistantTools.weatherForecast', "The Weather Network forecast"), safe: true,
			run: async (args, token) => {
				const day = args.day ?? 'today';
				if (day !== 'today' && day !== 'tomorrow') { throw new Error(localize('assistantTools.weatherInvalidDay', "Choose today or tomorrow for the forecast.")); }
				if (token.isCancellationRequested) { throw new CancellationError(); }
				const hasRequestedLocation = args.city !== undefined || args.country !== undefined || args.subdivision !== undefined;
				const location = hasRequestedLocation
					? normalizeAssistantWeatherLocation(locationFromArgs(args))
					: readAssistantWeatherLocation(context.configuration);
				if (!location) {
					throw new Error(localize('assistantTools.weatherLocationRequired', "Specify a city and country, or set a default in Settings under Weather Location."));
				}
				const forecast = await readWeatherForecast(day, location);
				if (token.isCancellationRequested) { throw new CancellationError(); }
				return JSON.stringify(forecast);
			},
		}, {
			name: ASSISTANT_WEATHER_TOOL,
			description: 'Get the local forecast from The Weather Network for a specified city or the default weather location. Returns the local date, temperatures in Celsius, precipitation chance and conditions when available.',
			parameters: {
				type: 'object',
				properties: {
					...locationProperties,
					day: { type: 'string', enum: ['today', 'tomorrow'], description: 'The day in the forecast location. Defaults to today.' },
				},
			},
		});
		const configuration = context.configuration;
		if (configuration && !context.taskId) {
			push({
				kind: 'builtin', name: ASSISTANT_SET_WEATHER_LOCATION_TOOL,
				label: localize('assistantTools.setWeatherLocation', "Set default weather location"), safe: false,
				run: async (args, token) => {
					const location = normalizeAssistantWeatherLocation(locationFromArgs(args));
					if (!location) {
						throw new Error(localize('assistantTools.invalidWeatherLocation', "Enter a city and a two-letter country code. Include a region code if needed."));
					}
					if (token.isCancellationRequested) { throw new CancellationError(); }
					const value = [location.city, location.subdivision, location.country].filter(Boolean).join(', ');
					await configuration.updateValue(ASSISTANT_WEATHER_LOCATION_SETTING, value, ConfigurationTarget.USER);
					return localize('assistantTools.weatherLocationSaved', "Default weather location saved as {0}.", value);
				},
			}, {
				name: ASSISTANT_SET_WEATHER_LOCATION_TOOL,
				description: 'Save the default city for weather and briefings in user Settings. Use only when the user explicitly asks to set or change their default weather location.',
				parameters: { type: 'object', required: ['city', 'country'], properties: locationProperties },
			});
		}
	}
	if (readNewsFeeds) {
		push({
			kind: 'builtin', name: ASSISTANT_NEWS_TOOL, label: localize('assistantTools.newsHeadlines', "Get news headlines"), safe: true,
			run: (args, token) => getAssistantNewsHeadlines(readNewsFeeds, args.scope, token),
		}, {
			name: ASSISTANT_NEWS_TOOL,
			description: 'Read recent headlines, times, and article links from public CBC News and Global News RSS feeds. Use for current headlines and news briefings.',
			parameters: { type: 'object', properties: { scope: { type: 'string', enum: ['toronto', 'canada', 'world'], description: 'Headline region. Defaults to Canada.' } } },
		});
	}
	if (context.connectedHistory) {
		push({ kind: 'builtin', name: 'assistant.list_connection_sources', label: 'List history sources', safe: true, run: async (_args, token) => {
			// A ready connection does not imply the rest of the briefing sources are ready.
			await context.waitForAppTools?.(token);
			refreshAppTools();
			const available = [...new Set(appTools.map(tool => tool.connectionLabel))];
			const unavailable = assistantUnavailableConnections(context.mcpService, context.allowedServerIds, undefined, context.directMail?.connections.get()).map(({ name, reason }) => ({ name, reason }));
			return JSON.stringify({ available, unavailable });
		}
		}, {
			name: 'assistant.list_connection_sources',
			description: 'List available read-only connections and known connection problems. Use available labels with assistant.find_app_tools to discover their history tools.',
			parameters: { type: 'object', properties: {} },
		});
	}
	const proposeMemory = context.proposeMemory;
	if (proposeMemory) {
		push({ kind: 'builtin', name: 'assistant.propose_memory', label: 'Propose a memory for review', safe: true, run: async args =>
			proposeMemory(stringArg(args, 'note'), stringArg(args, 'tool'), stringArg(args, 'reference'))
		}, {
			name: 'assistant.propose_memory',
			description: 'Propose a durable preference for review. Use a read-only tool that returned evidence during this run and a source link or record ID that appears in its result.',
			parameters: { type: 'object', properties: {
				note: { type: 'string', description: 'A short, durable observation about how the user works.' },
				tool: { type: 'string', description: 'The exact name of the tool that returned the evidence.' },
				reference: { type: 'string', description: 'The exact HTTPS source link or record ID from the tool result.' },
			}, required: ['note', 'tool', 'reference'] },
		});
	}
	const proposeRoutine = context.proposeRoutine;
	if (proposeRoutine) {
		push({
			kind: 'builtin', name: 'assistant.propose_routine', label: localize('assistantTools.proposeRoutine', "Draft a routine"), safe: true,
			run: async args => proposeRoutine(args),
		}, {
			name: 'assistant.propose_routine',
			description: 'When the user asks for a recurring briefing, review or monitoring report, draft a read-only routine. The user reviews the draft, picks app connections and confirms the schedule. This tool does not start or schedule anything.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'A short display name.' },
					prompt: { type: 'string', description: 'Specific instructions for a recurring read-only report.' },
					cadence: { type: 'string', enum: ['daily', 'weekdays'] },
					hour: { type: 'integer', minimum: 0, maximum: 23, description: 'Optional local hour in 24-hour time.' },
					minute: { type: 'integer', minimum: 0, maximum: 59, description: 'Optional minute of the hour.' },
				},
				required: ['name', 'prompt'],
			},
		});
	}
	if (context.connectApp) {
		const connectApp = context.connectApp;
		push({ kind: 'builtin', name: 'assistant.connect_app', label: localize('assistantTools.connectApp', "Open app connection setup"), safe: false, run: async args => {
			const app = findAssistantAppConnection(stringArg(args, 'app'));
			if (!app) { return 'No matching app in the Signal-C catalog. The user can browse apps with /connect.'; }
			if (app.blocked) { return `${app.name}: ${app.blocked}`; }
			return connectApp(app.id)
				? `Opened setup for ${app.name}. The user can select an existing connection if one is listed or add a new connection. Ask them to finish the setup and any browser authorization, then send another request. Never ask for client secrets or tokens in chat.`
				: 'An app setup is already open. Ask the user to finish or close it first.';
		} }, {
			name: 'assistant.connect_app',
			description: 'Open the native app connection and OAuth setup when the user asks to connect an app. The user completes authorization in the app and browser.',
			parameters: { type: 'object', properties: { app: { type: 'string', description: 'The published app name or ID, for example Slack.' } }, required: ['app'] },
		});
	}
	push({ kind: 'builtin', name: 'assistant.find_app_tools', label: localize('assistantTools.findAppTools', "Find connected app tools"), safe: true, run: async (args, token) => {
		const app = stringArg(args, 'app').toLowerCase();
		const terms = stringArg(args, 'query').toLowerCase().split(/\s+/).filter(Boolean);
		const matches = (tool: typeof appTools[number]) => {
			const description = `${tool.spec.name} ${tool.spec.description}`.toLowerCase().replace(/[_-]+/g, ' ');
			return (!app || tool.app.includes(app)) && terms.every(term => description.includes(term));
		};
		refreshAppTools();
		let matching = appTools.filter(matches);
		if (!matching.length && context.waitForAppTools) {
			await context.waitForAppTools(token, connectedAppTools.map(tools => tools.some(matches)));
			refreshAppTools();
			matching = appTools.filter(matches);
		}
		if (!matching.length) { return 'No tools matched. Try fewer search terms or check whether the app is connected.'; }
		appFilter = matches;
		offerAppTools(matching);
		const offered = specs.slice(builtinToolCount).map(spec => `- ${spec.name}: ${spec.description}${parameterSummary(spec.parameters)}`);
		return `Available in the next request:\n${offered.join('\n')}${matching.length > offered.length ? '\nUse a more specific search to see other matching tools.' : ''}`;
	} }, {
		name: 'assistant.find_app_tools',
		description: 'Search tools from connected apps when the tools you need are not listed. Matching tools become available for your next call.',
		parameters: { type: 'object', properties: {
			app: { type: 'string', description: 'Optional app or configured connection, for example Slack.' },
			query: { type: 'string', description: 'Optional keywords describing what the tool should do, for example search messages.' },
		} },
	});
	const agentChats = context.agentChats;
	if (agentChats) {
		push({ kind: 'builtin', name: 'assistant.list_agents', label: 'List agent chats', safe: true, run: async () => agentChats.list(context.accountId, context.agentChatTarget) }, {
			name: 'assistant.list_agents', description: 'List available regular chat agent types and the IDs and statuses of agent chats started by Assistant.', parameters: { type: 'object', properties: {} },
		});
		push({ kind: 'builtin', name: 'assistant.start_agent', label: localize('assistantTools.startAgent', "Start an Agent Chat"), safe: false, run: (args, token) => agentChats.start(context.accountId, context.agentChatTarget, stringArg(args, 'prompt'), stringArg(args, 'title'), stringArg(args, 'agent_type') || undefined, token) }, {
			name: 'assistant.start_agent', description: 'Delegate a task to a regular agent chat in the background. Use assistant.read_agent with the returned ID to get the reply.',
			parameters: { type: 'object', properties: {
				prompt: { type: 'string', description: 'Task and relevant context to send to the agent.' },
				title: { type: 'string', description: 'Short title for the regular chat.' },
				agent_type: { type: 'string', description: 'Optional agent type ID from assistant.list_agents.' },
			}, required: ['prompt'] },
		});
		push({ kind: 'builtin', name: 'assistant.send_agent', label: localize('assistantTools.sendAgent', "Message an Agent Chat"), safe: false, run: args => agentChats.send(context.accountId, stringArg(args, 'id'), stringArg(args, 'prompt')) }, {
			name: 'assistant.send_agent', description: 'Send a follow-up message to an idle agent chat using its ID. The agent receives it in the same regular chat.',
			parameters: { type: 'object', properties: {
				id: { type: 'string', description: 'Agent chat ID returned by assistant.start_agent or assistant.list_agents.' },
				prompt: { type: 'string', description: 'Follow-up message for the agent.' },
			}, required: ['id', 'prompt'] },
		});
		push({ kind: 'builtin', name: 'assistant.read_agent', label: 'Read an agent chat', safe: true, run: (args, token) => agentChats.read(context.accountId, stringArg(args, 'id'), args.wait !== false, token) }, {
			name: 'assistant.read_agent', description: 'Read a regular agent chat’s latest reply or status. It can wait up to 25 seconds and reports if the agent needs user input in its chat.',
			parameters: { type: 'object', properties: {
				id: { type: 'string', description: 'Agent chat ID returned by assistant.start_agent or assistant.list_agents.' },
				wait: { type: 'boolean', description: 'Wait briefly for a running agent. Defaults to true.' },
			}, required: ['id'] },
		});
	}

	push({ kind: 'builtin', name: 'assistant.get_current_time', label: 'Current time', safe: true, run: async () => `${new Date().toISOString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})` }, {
		name: 'assistant.get_current_time', description: 'Get the current date, time and time zone.', parameters: { type: 'object', properties: {} },
	});
	push({ kind: 'builtin', name: 'assistant.ask_user', label: 'Ask the user', safe: true, run: async args => {
		if (context.taskId) { return 'Cannot ask the user inside a background task — answer from context or report progress instead.'; }
		if (!context.askUser) { return 'Asking the user is not available in this session.'; }
		const question = typeof args.question === 'string' ? args.question.trim().slice(0, 300) : '';
		if (!question) { return 'Nothing asked: the question was empty.'; }
		const options = Array.isArray(args.options)
			? args.options.filter((o): o is string => typeof o === 'string' && !!o.trim()).map(o => o.trim().slice(0, 120)).slice(0, 5)
			: undefined;
		const answer = await context.askUser(question, options?.length ? options : undefined);
		return answer === undefined ? 'The user dismissed the question without answering.' : `The user answered: ${answer.slice(0, 500)}`;
	}}, {
		name: 'assistant.ask_user', description: 'Ask the user a clarifying question and wait for the answer. Use only when truly blocked — prefer reasonable assumptions. Not available inside background tasks.', parameters: { type: 'object', properties: {
			question: { type: 'string', description: 'The question to ask the user.' },
			options: { type: 'array', items: { type: 'string' }, description: 'Optional 2-5 answer choices; the user may also type a free answer.' },
		}, required: ['question'] },
	});
	push({ kind: 'builtin', name: 'assistant.remember', label: 'Save to memory', safe: true, run: async args => {
		const note = typeof args.note === 'string' ? args.note.trim() : '';
		if (!note) { return 'Nothing saved: the note was empty.'; }
		const { added, total } = context.store.remember(context.accountId, [note]);
		return added ? `Saved to memory. Memory now has ${total} note(s).` : 'Already saved in memory.';
	} }, {
		name: 'assistant.remember', description: 'Save a fact about the user, their preferences, people or projects to long-term memory.',
		parameters: { type: 'object', properties: { note: { type: 'string', description: 'The fact to remember, written as one line.' } }, required: ['note'] },
	});
	push({ kind: 'builtin', name: 'assistant.list_tasks', label: 'List tasks', safe: true, run: async () => {
		const tasks = context.store.read(context.accountId).tasks ?? [];
		return tasks.length
			? tasks.map(task => `- ${task.title || '(untitled task)'} [${task.status}] (id: ${task.id})${task.update ? ` — ${task.update}` : ''}`).join('\n')
			: 'No linked tasks yet.';
	} }, {
		name: 'assistant.list_tasks', description: 'List the user\u2019s linked task conversations and their status.', parameters: { type: 'object', properties: {} },
	});
	push({ kind: 'builtin', name: 'assistant.read_task', label: 'Read a task', safe: true, run: async args => {
		const id = typeof args.id === 'string' ? args.id.trim() : '';
		const task = context.store.read(context.accountId).tasks?.find(task => task.id === id || task.title === id);
		if (!task) { return 'No task with that id or title. Use assistant.list_tasks to see task ids.'; }
		const last = context.store.read(context.accountId, task.id).turns.at(-1);
		return `Task "${task.title || '(untitled)'}" is ${task.status}.${task.update ? ` Latest update: ${task.update}` : ''}${last ? `\nLatest reply:\n${last.reply.slice(0, 3_000)}` : '\nNo replies yet.'}`;
	} }, {
		name: 'assistant.read_task', description: 'Read the status and latest reply of a linked task conversation.',
		parameters: { type: 'object', properties: { id: { type: 'string', description: 'The task id or title from assistant.list_tasks.' } }, required: ['id'] },
	});
	push({ kind: 'builtin', name: 'assistant.rename_task', label: 'Rename a task', safe: true, run: async args => {
		const title = typeof args.title === 'string' ? args.title.trim() : '';
		if (!title) { return 'The task needs a title.'; }
		const id = typeof args.id === 'string' ? args.id.trim() : context.taskId;
		const task = id ? context.store.read(context.accountId).tasks?.find(task => task.id === id || task.title === id) : undefined;
		if (!id || !task) { return 'Pass the task id or title from assistant.list_tasks.'; }
		context.store.updateTask(context.accountId, task.id, { title: title.slice(0, 100) });
		return `Renamed the task to "${title.slice(0, 100)}".`;
	} }, {
		name: 'assistant.rename_task', description: 'Rename a linked task (defaults to the current task).',
		parameters: { type: 'object', properties: {
			title: { type: 'string', description: 'The new task title.' },
			id: { type: 'string', description: 'Optional task id or title; defaults to this task.' },
		}, required: ['title'] },
	});
	push({ kind: 'builtin', name: 'assistant.report_progress', label: 'Report task progress', safe: true, run: async args => {
		if (!context.taskId) { return 'Progress updates are only available inside a task conversation.'; }
		const update = typeof args.update === 'string' ? args.update.trim() : '';
		if (!update) { return 'Nothing to report: the update was empty.'; }
		context.store.updateTask(context.accountId, context.taskId, { update: update.slice(0, 200) });
		return 'Progress reported.';
	} }, {
		name: 'assistant.report_progress', description: 'Post a short progress update that the user sees on this task in the task list.',
		parameters: { type: 'object', properties: { update: { type: 'string', description: 'One-line progress summary, e.g. "Scanning src/ for imports".' } }, required: ['update'] },
	});
	const worktree = context.agentChatTarget?.worktree;
	const workspaceFolders = getAssistantWorkspaceFolders(context.workspaceService, context.agentChatTarget);
	const workspaceRoots = workspaceFolders.map(folder => folder.uri);
	const worktreeError = async () => worktree && assistantWorktreeError(await context.agentChats?.getWorktreeStatus(worktree) ?? 'untrusted');
	const workspaceUri = async (rawPath: unknown): Promise<URI | string> => {
		const error = await worktreeError();
		return error ?? resolveAssistantWorkspacePath(workspaceFolders, rawPath);
	};
	push({ kind: 'builtin', name: 'assistant.list_files', label: 'List workspace files', safe: true, run: async args => {
		const uri = await workspaceUri(args.path);
		if (typeof uri === 'string') { return uri; }
		const depth = Math.min(Math.max(1, Number(args.depth) || 1), 3);
		try {
			const lines: string[] = [];
			const walk = async (dir: URI, prefix: string, level: number) => {
				const stat = await context.fileService.resolve(dir);
				if (!stat.isDirectory) { lines.push(prefix + (basename(dir) || '.')); return; }
				for (const child of stat.children ?? []) {
					if (lines.length >= 200) { return; }
					lines.push(prefix + child.name + (child.isDirectory ? '/' : ''));
					if (child.isDirectory && level < depth) { await walk(child.resource, `${prefix}${child.name}/`, level + 1); }
				}
			};
			await walk(uri, '', 1);
			if (!lines.length) { return '(empty directory)'; }
			return lines.slice(0, 200).join('\n') + (lines.length > 200 ? '\n… (truncated)' : '');
		} catch (error) {
			return `Could not list the directory: ${error instanceof Error ? error.message : String(error)}`;
		}
	} }, {
		name: 'assistant.list_files', description: 'List the entries of a directory inside the workspace folder.',
		parameters: { type: 'object', properties: {
			path: { type: 'string', description: 'Directory path relative to the workspace root (default: root).' },
			depth: { type: 'number', description: 'How many levels of subdirectories to expand (1–3, default 1).' },
		} },
	});
	push({ kind: 'builtin', name: 'assistant.read_file', label: 'Read a workspace file', safe: true, run: async args => {
		const uri = await workspaceUri(args.path);
		if (typeof uri === 'string') { return uri; }
		try {
			const content = await context.fileService.readFile(uri, { limits: { size: 64 * 1024 } });
			const lines = content.value.toString().split('\n');
			const offset = Math.min(Math.max(0, Number(args.offset) || 0), lines.length);
			const limit = Math.min(Math.max(1, Number(args.limit) || 200), 400);
			const slice = lines.slice(offset, offset + limit).map((line, i) => `${offset + i + 1}: ${line}`).join('\n');
			const more = lines.length - offset - limit;
			return more > 0 ? `${slice}\n… (${more} more lines — pass offset=${offset + limit} to continue)` : slice;
		} catch (error) {
			return `Could not read the file: ${error instanceof Error ? error.message : String(error)}`;
		}
	} }, {
		name: 'assistant.read_file', description: 'Read a UTF-8 text file inside the workspace folder with line numbers.',
		parameters: { type: 'object', properties: {
			path: { type: 'string', description: 'File path relative to the workspace root.' },
			offset: { type: 'number', description: 'Zero-based first line to return (default 0).' },
			limit: { type: 'number', description: 'Max lines to return (default 200, max 400).' },
		}, required: ['path'] },
	});
	const displayPath = (resource: URI): string => formatAssistantWorkspacePath(workspaceFolders, resource) ?? resource.path;
	push({ kind: 'builtin', name: 'assistant.find_files', label: 'Find files by name', safe: true, run: async (args, token) => {
		const error = await worktreeError();
		if (error) { return error; }
		if (!workspaceRoots.length) { return 'No workspace folder is open.'; }
		const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
		if (!pattern) { return 'A file-name pattern is required.'; }
		try {
			const complete = await context.searchService.fileSearch({
				type: QueryType.File, filePattern: pattern, folderQueries: workspaceRoots.map(folder => ({ folder })), maxResults: 50, sortByScore: true,
			}, token);
			const names = complete.results.slice(0, 50).map(match => displayPath(match.resource));
			return names.length ? names.join('\n') : 'No files matched.';
		} catch (error) {
			return `Search failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	} }, {
		name: 'assistant.find_files', description: 'Find files in the workspace by fuzzy file-name match.',
		parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'File-name pattern, e.g. "package.json" or "test".' } }, required: ['pattern'] },
	});
	push({ kind: 'builtin', name: 'assistant.search_files', label: 'Search file contents', safe: true, run: async (args, token) => {
		const error = await worktreeError();
		if (error) { return error; }
		if (!workspaceRoots.length) { return 'No workspace folder is open.'; }
		const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
		if (!pattern) { return 'A search pattern is required.'; }
		const query: ITextQuery = {
			type: QueryType.Text, contentPattern: { pattern }, folderQueries: workspaceRoots.map(folder => ({ folder })),
			previewOptions: { matchLines: 1, charsPerLine: 180 }, maxResults: 30, surroundingContext: 0,
			_reason: 'assistant.search_files',
		};
		if (typeof args.glob === 'string' && args.glob.trim()) {
			query.includePattern = { [args.glob.trim()]: true };
		}
		try {
			const complete = await context.searchService.textSearch(query, token);
			const lines: string[] = [];
			for (const fileMatch of complete.results) {
				const name = displayPath(fileMatch.resource);
				for (const result of fileMatch.results ?? []) {
					if (!resultIsMatch(result)) { continue; }
					const line = result.rangeLocations[0]?.source.startLineNumber ?? 0;
					lines.push(`${name}:${line + 1}: ${result.previewText.trim()}`);
					if (lines.length >= 40) { break; }
				}
				if (lines.length >= 40) { break; }
			}
			return lines.length
				? lines.join('\n') + (complete.limitHit ? '\n… (results truncated)' : '')
				: 'No matches.';
		} catch (error) {
			return `Search failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	} }, {
		name: 'assistant.search_files', description: 'Search text inside workspace files and return matching lines.',
		parameters: { type: 'object', properties: {
			pattern: { type: 'string', description: 'Text or regex pattern to search for.' },
			glob: { type: 'string', description: 'Optional file glob filter, e.g. "*.ts" or "src/**".' },
		}, required: ['pattern'] },
	});
	push({ kind: 'builtin', name: 'assistant.write_file', label: 'Write a workspace file', safe: false, run: async args => {
		const uri = await workspaceUri(args.path);
		if (typeof uri === 'string') { return uri; }
		const content = typeof args.content === 'string' ? args.content : undefined;
		if (content === undefined) { return 'The "content" argument is required.'; }
		if (content.length > 200_000) { return 'Refused: content exceeds 200 KB.'; }
		try {
			await context.fileService.writeFile(uri, VSBuffer.fromString(content));
			return `Wrote ${displayPath(uri)}: ${content.split('\n').length} lines, ${content.length} characters.`;
		} catch (error) {
			return `Could not write the file: ${error instanceof Error ? error.message : String(error)}`;
		}
	} }, {
		name: 'assistant.write_file', description: 'Create or overwrite a UTF-8 text file inside the workspace folder.',
		parameters: { type: 'object', properties: {
			path: { type: 'string', description: 'File path relative to the workspace root.' },
			content: { type: 'string', description: 'Full file contents.' },
		}, required: ['path', 'content'] },
	});
	push({ kind: 'builtin', name: 'assistant.edit_file', label: 'Edit a workspace file', safe: false, run: async args => {
		const uri = await workspaceUri(args.path);
		if (typeof uri === 'string') { return uri; }
		const oldText = typeof args.old_text === 'string' ? args.old_text : undefined;
		const newText = typeof args.new_text === 'string' ? args.new_text : undefined;
		if (oldText === undefined || newText === undefined) { return 'Both "old_text" and "new_text" are required.'; }
		if (!oldText) { return '"old_text" must not be empty.'; }
		try {
			const current = (await context.fileService.readFile(uri, { limits: { size: 256 * 1024 } })).value.toString();
			const occurrences = current.split(oldText).length - 1;
			if (!occurrences) { return 'The text to replace was not found in the file.'; }
			if (occurrences > 1 && args.replace_all !== true) { return `Found ${occurrences} occurrences of "old_text". Include more surrounding context or set "replace_all" to true.`; }
			const updated = occurrences > 1 ? current.split(oldText).join(newText) : current.replace(oldText, newText);
			await context.fileService.writeFile(uri, VSBuffer.fromString(updated));
			const added = newText.split('\n').length * occurrences;
			const removed = oldText.split('\n').length * occurrences;
			return `Edited ${displayPath(uri)}: +${added} −${removed} lines${occurrences > 1 ? ` across ${occurrences} occurrences` : ''}.`;
		} catch (error) {
			return `Could not edit the file: ${error instanceof Error ? error.message : String(error)}`;
		}
	} }, {
		name: 'assistant.edit_file', description: 'Replace an exact text span inside a workspace file, without rewriting the whole file.',
		parameters: { type: 'object', properties: {
			path: { type: 'string', description: 'File path relative to the workspace root.' },
			old_text: { type: 'string', description: 'Exact text to replace.' },
			new_text: { type: 'string', description: 'Replacement text.' },
			replace_all: { type: 'boolean', description: 'Replace every occurrence (default false: a unique match is required).' },
		}, required: ['path', 'old_text', 'new_text'] },
	});
	push({ kind: 'builtin', name: 'assistant.create_task', label: 'Start a linked task', safe: false, run: async args => {
		const instructions = (typeof args.instructions === 'string' ? args.instructions.trim() : '').slice(0, 4_000);
		if (!instructions) { return 'The task needs instructions to run.'; }
		const title = (typeof args.title === 'string' && args.title.trim() ? args.title.trim() : instructions).slice(0, 100);
		const taskId = context.store.createTask(context.accountId, captureAssistantTaskTarget(context.workspaceService, context.agentChatTarget));
		context.store.updateTask(context.accountId, taskId, { title });
		return context.startTask?.(taskId, instructions)
			? `Started task "${title}" as a linked conversation running in the background.`
			: `Created task "${title}". The user can open it from the task list to run it.`;
	} }, {
		name: 'assistant.create_task', description: 'Start a linked task conversation that runs in the background, e.g. for a longer piece of research or work.',
		parameters: { type: 'object', properties: {
			title: { type: 'string', description: 'Short task title.' },
			instructions: { type: 'string', description: 'The task prompt the assistant should complete.' },
		}, required: ['instructions'] },
	});
	push({ kind: 'builtin', name: 'assistant.web_fetch', label: 'Fetch a web page', safe: true, run: async (args, token) => {
		const url = typeof args.url === 'string' ? args.url.trim() : '';
		if (!/^https?:\/\//i.test(url)) { return 'Fetch failed: only http(s) URLs are supported.'; }
		try {
			const text = await asTextOrError(await context.requestService.request({ type: 'GET', url, followRedirects: 3, timeout: 15_000, callSite: NO_FETCH_TELEMETRY }, token));
			if (text === null) { return 'Fetch failed: empty response.'; }
			return htmlToText(text).slice(0, MAX_FETCH_CHARS);
		} catch (error) {
			return `Fetch failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	} }, {
		name: 'assistant.web_fetch', description: 'Fetch a public web page over http(s) and return its readable text content.',
		parameters: { type: 'object', properties: { url: { type: 'string', description: 'The absolute URL to fetch.' } }, required: ['url'] },
	});
	push({ kind: 'builtin', name: 'assistant.open_url', label: 'Open in browser', safe: false, run: async args => {
		const url = typeof args.url === 'string' ? args.url.trim() : '';
		if (!/^https?:\/\//i.test(url)) { return 'Only http(s) URLs can be opened.'; }
		try {
			await context.openerService.open(URI.parse(url));
			return `Opened ${url} in the user's browser.`;
		} catch (error) {
			return `Could not open the URL: ${error instanceof Error ? error.message : String(error)}`;
		}
	}}, {
		name: 'assistant.open_url', description: 'Open a public http(s) URL in the user\u2019s default browser — for example a page the user asks to see, or a link produced by another tool.',
		parameters: { type: 'object', properties: { url: { type: 'string', description: 'The absolute http(s) URL to open.' } }, required: ['url'] },
	});
	push({ kind: 'builtin', name: 'assistant.open_file', label: 'Open file in editor', safe: false, run: async args => {
		const uri = await workspaceUri(args.path);
		if (typeof uri === 'string') { return uri; }
		if (!(await context.fileService.exists(uri))) { return `No such file in the workspace: ${String(args.path ?? '')}`; }
		try {
			const line = Math.max(0, Math.floor(Number(args.line) || 0));
			const column = Math.max(1, Math.floor(Number(args.column) || 1));
			const target = line > 0 ? withSelection(uri, { startLineNumber: line, startColumn: column }) : uri;
			await context.openerService.open(target);
			return `Opened ${basename(uri)}${line > 0 ? ` at line ${line}` : ''} in the editor.`;
		} catch (error) {
			return `Could not open the file: ${error instanceof Error ? error.message : String(error)}`;
		}
	}}, {
		name: 'assistant.open_file', description: 'Reveal a workspace file in the editor — use after writing or editing a file the user should inspect, or when the user asks to see a file. Optionally jump to a line.',
		parameters: { type: 'object', properties: {
			path: { type: 'string', description: 'Workspace-relative path to open.' },
			line: { type: 'number', description: 'Optional 1-based line number to jump to.' },
			column: { type: 'number', description: 'Optional 1-based column (default 1).' },
		}, required: ['path'] },
	});
	push({ kind: 'builtin', name: 'assistant.update_plan', label: 'Update plan', safe: true, run: async args => {
		if (!context.setPlan) { return 'Planning is not available in this session.'; }
		const raw = Array.isArray(args.items) ? args.items : [];
		const items: IAssistantPlanItem[] = [];
		for (const entry of raw.slice(0, 8)) {
			const step = typeof (entry as { step?: unknown })?.step === 'string' ? (entry as { step: string }).step.trim().slice(0, 140) : '';
			const status = (entry as { status?: unknown })?.status;
			if (!step) { continue; }
			items.push({ step, status: status === 'inProgress' || status === 'done' ? status : 'pending' });
		}
		if (!items.length) { return 'Nothing posted: pass items as [{step, status}].'; }
		context.setPlan(items);
		return `Plan updated: ${items.filter(item => item.status === 'done').length}/${items.length} complete.`;
	}}, {
		name: 'assistant.update_plan', description: 'Post a plan for this request as a checklist the user watches live — set it at the start and keep statuses current as you work. For non-trivial, multi-step work.',
		parameters: { type: 'object', properties: {
			items: { type: 'array', description: 'The plan steps; at most one should be inProgress.', items: { type: 'object', properties: { step: { type: 'string', description: 'One short plan step.' }, status: { type: 'string', enum: ['pending', 'inProgress', 'done'] } }, required: ['step', 'status'] } },
		}, required: ['items'] },
	});

	const connectedAppTools = derived(reader => {
		const available = new Map<string, IAssistantAppTool>();
		const directMail = context.directMail;
		for (const connection of directMail?.connections.read(reader) ?? []) {
			if (connection.needsSignIn || (context.allowedServerIds && !context.allowedServerIds.has(connection.id))) { continue; }
			const name = `assistant.${connection.provider}_read`;
			available.set(name, {
				app: connection.label.toLowerCase(), connectionLabel: connection.label,
				entry: {
					kind: 'directMail', name, label: connection.label, safe: true, connectionId: connection.id,
					run: (args, token) => directMail!.read(connection, args, token),
				},
				spec: {
					name, description: `Read ${connection.label} inbox or sent mail. Search messages, use previews or get an individual message body by its returned ID.`,
					parameters: { type: 'object', properties: {
						folder: { type: 'string', enum: ['inbox', 'sent', 'all'], description: 'Mailbox folder to read. Defaults to inbox.' },
						query: { type: 'string', description: 'Optional search query, for example a sender, subject or keywords.' },
						limit: { type: 'number', description: 'Number of messages to list, from 1 to 10. Defaults to 5.' },
						messageId: { type: 'string', description: 'The ID of one message to read. Omit this argument when searching or listing.' },
					} },
				},
			});
		}
		for (const server of context.mcpService.servers.read(reader)) {
			if (context.connectedHistory ? connectionProblem(server, reader) : !isContributionEnabled(server.enablement.read(reader))) { continue; }
			const connectionId = context.connectedHistory ? assistantConnectionKey(server) : undefined;
			if (context.allowedServerIds && (!connectionId || !context.allowedServerIds.has(connectionId))) { continue; }
			const serverMetadata = server.serverMetadata.read(reader);
			const serverLabel = serverMetadata?.serverName ?? server.definition.label;
			const connectionLabel = server.definition.label;
			const workIq = isWorkIqMcpServer(server, reader);
			const searchableApp = [serverLabel.toLowerCase(), connectionLabel.toLowerCase(), ...(workIq ? [WORK_IQ_APP_NAMES] : [])].join('\n');
			const guidance = !context.connectedHistory && serverMetadata?.serverInstructions ? `${serverLabel}: ${serverMetadata.serverInstructions}`.slice(0, 2000) : undefined;
			for (const tool of server.tools.read(reader)) {
				if (!(tool?.visibility & McpToolVisibility.Model) || entries.get(tool.id)?.kind === 'builtin' || available.has(tool.id)) { continue; }
				const definition = tool.definition as MCP.Tool | undefined;
				if (!definition?.name) { continue; }
				const safe = safeMcpTool(tool, workIq);
				if (context.connectedHistory && !safe) { continue; }
				const description = workIq && definition.name === 'fetch'
					? 'Search Outlook email (/me/messages or /me/mailFolders/sentitems/messages), calendar (/me/calendarView), Teams chats (/me/chats), OneDrive or SharePoint using relative Microsoft 365 paths.'
					: definition.description || definition.title || definition.name;
				available.set(tool.id, {
					app: searchableApp,
					connectionLabel,
					guidance,
					entry: { kind: 'mcp', name: tool.id, label: `${context.connectedHistory ? connectionLabel : serverLabel} · ${definition.title ?? definition.name}`, safe, tool, connectionId },
					spec: { name: tool.id, description: `${context.connectedHistory ? connectionLabel : serverLabel}: ${description}`.slice(0, 240), parameters: definition.inputSchema },
				});
			}
		}
		return [...available.values()];
	});

	builtinToolCount = specs.length;
	refreshAppTools();
	return { entries, specs, get index() { return indexLines.join('\n'); }, instructions };

	function refreshAppTools(): void {
		const next = connectedAppTools.get();
		for (const { spec } of appTools) { entries.delete(spec.name); }
		appTools = next;
		for (const { entry } of appTools) { entries.set(entry.name, entry); }
		offerAppTools(appFilter ? appTools.filter(appFilter) : appTools);
	}
}

const TOOL_CALL_BLOCK = /```tool_call\s*\r?\n([\s\S]*?)```/g;

export interface ITextToolCall {
	readonly name: string;
	readonly args: Record<string, unknown>;
}

/** Parses the fenced fallback protocol models use when native function calls are unavailable. */
export function parseTextToolCalls(text: string): { calls: ITextToolCall[]; errors: string[]; display: string } {
	const calls: ITextToolCall[] = [];
	const errors: string[] = [];
	const display = text.replace(TOOL_CALL_BLOCK, (_block, json: string) => {
		try {
			const parsed = JSON.parse(json) as { name?: unknown; arguments?: unknown; args?: unknown };
			const args = parsed.arguments ?? parsed.args ?? {};
			if (typeof parsed.name !== 'string' || !parsed.name) {
				errors.push('a tool_call block is missing the "name" field');
			} else if (typeof args !== 'object' || args === null || Array.isArray(args)) {
				errors.push(`tool_call for "${parsed.name}" must pass "arguments" as an object`);
			} else {
				calls.push({ name: parsed.name, args: args as Record<string, unknown> });
			}
		} catch {
			errors.push('a tool_call block contained invalid JSON');
		}
		return '';
	}).trim();
	return { calls, errors, display };
}

export function serializeMcpToolResult(result: MCP.CallToolResult): string {
	const parts: string[] = [];
	for (const item of result.content ?? []) {
		switch (item.type) {
			case 'text': parts.push(item.text); break;
			case 'image': parts.push('[image returned by tool — images cannot be displayed here]'); break;
			case 'audio': parts.push('[audio returned by tool — audio cannot be played here]'); break;
			case 'resource': {
				const resource = item.resource;
				const text = (resource as { text?: unknown } | undefined)?.text;
				parts.push(`[resource ${resource?.uri ?? ''}]${typeof text === 'string' ? `\n${text}` : ''}`);
				break;
			}
			case 'resource_link': parts.push(`[link ${item.uri}]${item.name ? ` ${item.name}` : ''}`); break;
			default: parts.push(`[${(item as { type?: string }).type ?? 'unknown'} content returned by tool]`);
		}
	}
	if (result.structuredContent !== undefined) {
		parts.push(JSON.stringify(result.structuredContent));
	}
	const text = parts.filter(part => typeof part === 'string' && part.length).join('\n') || '(tool returned no content)';
	return text;
}

export function argsFromCall(call: ReachAssistantToolCall): Record<string, unknown> {
	if (!call.arguments) { return {}; }
	try {
		const parsed = JSON.parse(call.arguments);
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script\s*>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style\s*>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, '\'')
		.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n').trim();
}
