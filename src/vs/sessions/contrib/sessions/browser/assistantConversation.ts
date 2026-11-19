/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { parse, stringify } from '../../../../base/common/marshalling.js';
import { Schemas } from '../../../../base/common/network.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IChatDraft } from '../../../../workbench/contrib/chat/common/attachments/chatDraft.js';
import { fromStoredChatDraft, toStoredChatDraft } from '../../../../workbench/contrib/sessions/common/newChatDraftState.js';
import type { IAssistantAgentTarget } from './assistantAgentChats.js';
import type { AssistantRoutineDraft } from './assistantBriefingScheduler.js';
import type { IAssistantWorktree } from './assistantWorktree.js';

export type AssistantPermissionMode = 'routine' | 'safeOnly' | 'allowAll';

export interface IAssistantActivity {
	readonly tool: string;
	readonly label: string;
	readonly status: 'pending' | 'awaitingApproval' | 'running' | 'done' | 'rejected' | 'failed';
	readonly detail?: string;
	readonly durationMs?: number;
}

export interface IAssistantPlanItem {
	readonly step: string;
	readonly status: 'pending' | 'inProgress' | 'done';
}

interface IAssistantWorktreeSelection {
	readonly project: URI;
	readonly worktree: IAssistantWorktree;
}

function readUri(value: unknown): URI | undefined {
	if (typeof value !== 'string') { return undefined; }
	try {
		return URI.parse(value, true);
	} catch {
		return undefined;
	}
}

function readLocalPath(value: unknown): URI | undefined {
	const uri = readUri(value);
	return uri?.scheme === Schemas.file && uri.path.startsWith('/') && !uri.query && !uri.fragment ? uri : undefined;
}

interface IStoredWorktree {
	readonly uri?: unknown;
	readonly label?: unknown;
	readonly identity?: { readonly gitDirectory?: unknown; readonly createdAt?: unknown };
}

interface IStoredTaskTarget {
	readonly workspace?: string;
	readonly worktree?: IStoredWorktree;
	readonly fileRoots?: readonly string[];
	readonly fileRootNames?: readonly string[];
	readonly activeEditorFile?: string;
	readonly providerId?: string;
	readonly sessionTypeId?: string;
}

function storeWorktree(worktree: IAssistantWorktree): IStoredWorktree {
	return {
		uri: worktree.uri.toString(), label: worktree.label,
		identity: worktree.identity && { gitDirectory: worktree.identity.gitDirectory.toString(), createdAt: worktree.identity.createdAt },
	};
}

function readWorktree(raw: IStoredWorktree | undefined): IAssistantWorktree | undefined {
	const uri = readLocalPath(raw?.uri);
	if (!uri || typeof raw?.label !== 'string' || !raw.label) { return undefined; }
	const gitDirectory = readLocalPath(raw.identity?.gitDirectory);
	const createdAt = raw.identity?.createdAt;
	const identity = gitDirectory && typeof createdAt === 'number' && Number.isFinite(createdAt) ? { gitDirectory, createdAt } : undefined;
	return { uri, label: raw.label, identity };
}

export function storeAssistantTaskTarget(target: IAssistantAgentTarget): IStoredTaskTarget {
	return {
		workspace: target.workspace?.toString(), worktree: target.worktree && storeWorktree(target.worktree),
		fileRoots: target.fileRoots?.map(root => root.toString()), fileRootNames: target.fileRootNames, activeEditorFile: target.activeEditorFile?.toString(),
		providerId: target.providerId, sessionTypeId: target.sessionTypeId,
	};
}

export function readAssistantTaskTarget(task: IAssistantTask | undefined): IAssistantAgentTarget | undefined {
	return readAssistantTarget(task?.target);
}

export function readAssistantTarget(raw: IStoredTaskTarget | undefined): IAssistantAgentTarget | undefined {
	if (!raw || typeof raw !== 'object') { return undefined; }
	const fileRoots = Array.isArray(raw.fileRoots) ? raw.fileRoots.map(readUri).filter(uri => uri !== undefined) : [];
	const names = raw.fileRootNames;
	const fileRootNames = Array.isArray(names) && names.length === raw.fileRoots?.length && names.length === fileRoots.length
		&& names.every(name => typeof name === 'string') ? names : undefined;
	const activeEditorFile = readLocalPath(raw.activeEditorFile);
	return {
		workspace: readUri(raw.workspace), worktree: readWorktree(raw.worktree),
		fileRoots, ...(fileRootNames ? { fileRootNames } : {}),
		...(activeEditorFile ? { activeEditorFile } : {}),
		providerId: typeof raw.providerId === 'string' ? raw.providerId : undefined,
		sessionTypeId: typeof raw.sessionTypeId === 'string' ? raw.sessionTypeId : undefined,
	};
}

interface IAssistantQueuedPrompt {
	readonly id?: string;
	readonly prompt: string;
	readonly target: IStoredTaskTarget;
}

function isQueuedPrompt(item: IAssistantQueuedPrompt | undefined): item is IAssistantQueuedPrompt {
	return typeof item?.prompt === 'string' && !!item.prompt && !!item.target && typeof item.target === 'object';
}

export interface IAssistantTurn {
	readonly prompt: string;
	readonly reply: string;
	readonly routineId?: string;
	readonly routineRunId?: string;
	readonly routineDraft?: AssistantRoutineDraft;
	readonly unavailableConnections?: readonly { readonly id: string; readonly name: string; readonly needsSignIn?: true }[];
	readonly model?: string;
	readonly at?: number;
	readonly durationMs?: number;
	readonly activity?: readonly IAssistantActivity[];
	readonly plan?: readonly IAssistantPlanItem[];
}

export interface IAssistantConversation {
	readonly instructions: string;
	readonly draft?: string;
	readonly draftContext?: string;
	readonly queuedPrompts?: readonly IAssistantQueuedPrompt[];
	readonly startedQueuedPrompt?: IAssistantQueuedPrompt;
	readonly turns: readonly IAssistantTurn[];
	readonly modelId?: string;
	readonly tasks?: readonly IAssistantTask[];
	readonly agentChats?: readonly IAssistantAgentChat[];
	readonly permissionMode?: AssistantPermissionMode;
	readonly allowedTools?: readonly string[];
}

interface IAssistantAgentChat {
	readonly id: string;
	readonly resource: string;
	readonly title: string;
}

export interface IAssistantTask {
	readonly id: string;
	readonly title: string;
	readonly status: 'draft' | 'running' | 'completed' | 'stopped' | 'failed';
	readonly update?: string;
	readonly pinned?: boolean;
	/** The prompt the task last ran with; used to resume after an interruption. */
	readonly lastPrompt?: string;
	readonly target?: IStoredTaskTarget;
}

const PERMISSION_MODES: readonly AssistantPermissionMode[] = ['routine', 'safeOnly', 'allowAll'];

/** Stores one local conversation per verified SignalREACH account id. */
export class AssistantConversationStore {
	constructor(private readonly storage: IStorageService) { }

	onDidChange(accountId: string, disposables: DisposableStore, taskId?: string) {
		return this.storage.onDidChangeValue(StorageScope.PROFILE, this.key(accountId, taskId), disposables);
	}

	read(accountId: string, taskId?: string): IAssistantConversation {
		const raw = this.storage.getObject<Partial<IAssistantConversation>>(this.key(accountId, taskId), StorageScope.PROFILE);
		return {
			instructions: typeof raw?.instructions === 'string' ? raw.instructions : '',
			...(typeof raw?.draft === 'string' && raw.draft ? { draft: raw.draft } : {}),
			...(typeof raw?.draftContext === 'string' && raw.draftContext ? { draftContext: raw.draftContext } : {}),
			...(Array.isArray(raw?.queuedPrompts) ? { queuedPrompts: raw.queuedPrompts.filter(isQueuedPrompt) } : {}),
			...(isQueuedPrompt(raw?.startedQueuedPrompt) ? { startedQueuedPrompt: raw.startedQueuedPrompt } : {}),
			turns: Array.isArray(raw?.turns) ? raw.turns.filter(turn => typeof turn?.prompt === 'string' && typeof turn.reply === 'string') : [],
			...(typeof raw?.modelId === 'string' && raw.modelId ? { modelId: raw.modelId } : {}),
			...(!taskId && Array.isArray(raw?.tasks) ? { tasks: raw.tasks.filter(task => typeof task?.id === 'string' && typeof task.title === 'string') } : {}),
			...(!taskId && Array.isArray(raw?.agentChats) ? { agentChats: raw.agentChats.filter(chat => typeof chat?.id === 'string' && typeof chat.resource === 'string' && typeof chat.title === 'string') } : {}),
			...(typeof raw?.permissionMode === 'string' && (PERMISSION_MODES as readonly string[]).includes(raw.permissionMode) ? { permissionMode: raw.permissionMode } : {}),
			...(Array.isArray(raw?.allowedTools) ? { allowedTools: raw.allowedTools.filter((tool): tool is string => typeof tool === 'string') } : {}),
		};
	}

	getLastWorktreeProject(accountId: string): URI | undefined {
		return readLocalPath(this.storage.get(`sessions.assistant.lastWorktreeProject.${encodeURIComponent(accountId)}`, StorageScope.PROFILE));
	}

	setLastWorktreeProject(accountId: string, project: URI | undefined): void {
		const key = `sessions.assistant.lastWorktreeProject.${encodeURIComponent(accountId)}`;
		if (project?.scheme === Schemas.file) {
			this.storage.store(key, project.toString(), StorageScope.PROFILE, StorageTarget.MACHINE);
		} else {
			this.storage.remove(key, StorageScope.PROFILE);
		}
	}

	getLastOpenTask(accountId: string, project: URI | undefined): string | undefined {
		const saved = this.storage.getObject<{ id?: unknown; project?: unknown }>(this.openTaskKey(accountId), StorageScope.PROFILE);
		if (typeof saved?.id !== 'string') { return undefined; }
		const sameProject = saved.project === undefined ? project === undefined : !!project && extUriBiasedIgnorePathCase.isEqual(readUri(saved.project), project);
		return sameProject && this.read(accountId).tasks?.some(task => task.id === saved.id) ? saved.id : undefined;
	}

	setLastOpenTask(accountId: string, project: URI | undefined, taskId: string | undefined): void {
		const key = this.openTaskKey(accountId);
		if (taskId) {
			this.storage.store(key, { id: taskId, project: project?.toString() }, StorageScope.PROFILE, StorageTarget.MACHINE);
		} else {
			this.storage.remove(key, StorageScope.PROFILE);
		}
	}

	private openTaskKey(accountId: string): string {
		return `sessions.assistant.lastOpenTask.${encodeURIComponent(accountId)}`;
	}

	getWorktreeSelection(accountId: string, project: URI): IAssistantWorktreeSelection | undefined {
		const selections = this.readWorktreeSelections(accountId);
		return selections.find(selection => extUriBiasedIgnorePathCase.isEqual(project, selection.project))
			?? selections.find(selection => extUriBiasedIgnorePathCase.isEqual(project, selection.worktree.uri));
	}

	setWorktreeSelection(accountId: string, project: URI, worktree: IAssistantWorktree | undefined): void {
		const selections = this.readWorktreeSelections(accountId).filter(selection => !extUriBiasedIgnorePathCase.isEqual(project, selection.project));
		if (worktree) {
			selections.unshift({ project, worktree });
		}
		this.storage.store(`sessions.assistant.worktreeSelections.${encodeURIComponent(accountId)}`, selections.map(selection => ({
			project: selection.project.toString(), ...storeWorktree(selection.worktree),
		})), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private readWorktreeSelections(accountId: string): IAssistantWorktreeSelection[] {
		const raw = this.storage.getObject<readonly (IStoredWorktree & { project?: unknown })[]>(`sessions.assistant.worktreeSelections.${encodeURIComponent(accountId)}`, StorageScope.PROFILE);
		if (!Array.isArray(raw)) { return []; }
		const selections: IAssistantWorktreeSelection[] = [];
		for (const entry of raw) {
			const project = readLocalPath(entry?.project);
			const worktree = readWorktree(entry);
			if (project && worktree) { selections.push({ project, worktree }); }
		}
		return selections;
	}

	setInstructions(accountId: string, instructions: string): void {
		this.write(accountId, { ...this.read(accountId), instructions });
	}

	remember(accountId: string, notes: readonly string[]): { added: number; total: number } {
		const lines = this.read(accountId).instructions.split('\n').filter(line => line.trim());
		const originalLength = lines.length;
		for (const note of notes) {
			if (note && !lines.some(line => line.replace(/^-\s*/, '') === note)) {
				lines.push(`- ${note}`);
			}
		}
		const added = lines.length - originalLength;
		if (added) {
			this.setInstructions(accountId, lines.join('\n').slice(-4_000));
		}
		return { added, total: lines.length };
	}

	setDraft(accountId: string, draft: string, taskId?: string): void {
		this.setComposerDraft(accountId, { inputText: draft, attachments: [] }, taskId);
	}

	readComposerDraft(accountId: string, taskId?: string): IChatDraft {
		const current = this.read(accountId, taskId);
		if (current.draftContext) {
			try { return fromStoredChatDraft(parse(current.draftContext)); }
			catch { /* A malformed attachment draft can still restore its plain text. */ }
		}
		return { inputText: current.draft ?? '', attachments: [] };
	}

	/** The prepared prompt keys retry and completion while the editable composer keeps its attachment references. */
	setComposerDraft(accountId: string, input: IChatDraft, taskId?: string, preparedPrompt?: string): void {
		const current = this.read(accountId, taskId);
		const draftContext = input.attachments.length || input.references?.length ? stringify(toStoredChatDraft(input)) : undefined;
		const savedPrompt = draftContext && draftContext === current.draftContext ? current.draft : undefined;
		const draft = preparedPrompt ?? savedPrompt ?? input.inputText;
		if ((current.draft ?? '') !== draft || current.draftContext !== draftContext) {
			this.write(accountId, { ...current, draft, draftContext }, taskId);
		}
	}

	queuePrompt(accountId: string, taskId: string | undefined, prompt: string, target: IAssistantAgentTarget): void {
		const conversation = this.read(accountId, taskId);
		this.write(accountId, { ...conversation, queuedPrompts: [...(conversation.queuedPrompts ?? []), { id: generateUuid(), prompt, target: storeAssistantTaskTarget(target) }] }, taskId);
	}

	startQueuedPrompt(accountId: string, taskId: string | undefined, id: string): boolean {
		const conversation = this.read(accountId, taskId);
		if (conversation.startedQueuedPrompt) { return conversation.startedQueuedPrompt.id === id; }
		const [next, ...remaining] = conversation.queuedPrompts ?? [];
		if (!next || (next.id && next.id !== id)) { return false; }
		this.write(accountId, { ...conversation, queuedPrompts: remaining, startedQueuedPrompt: { ...next, id } }, taskId);
		return true;
	}

	takeQueuedPrompt(accountId: string, taskId: string | undefined, includeStarted: boolean): IAssistantQueuedPrompt | undefined {
		const conversation = this.read(accountId, taskId);
		if (includeStarted && conversation.startedQueuedPrompt) {
			this.write(accountId, { ...conversation, startedQueuedPrompt: undefined }, taskId);
			return conversation.startedQueuedPrompt;
		}
		const [next, ...remaining] = conversation.queuedPrompts ?? [];
		if (next) { this.write(accountId, { ...conversation, queuedPrompts: remaining }, taskId); }
		return next;
	}

	setModel(accountId: string, modelId: string | undefined, taskId?: string): void {
		this.write(accountId, { ...this.read(accountId, taskId), modelId }, taskId);
	}

	setPermissionMode(accountId: string, mode: AssistantPermissionMode, taskId?: string): void {
		this.write(accountId, { ...this.read(accountId, taskId), permissionMode: mode }, taskId);
	}

	allowTool(accountId: string, tool: string, taskId?: string): void {
		const current = this.read(accountId, taskId);
		const allowed = current.allowedTools ?? [];
		if (!allowed.includes(tool)) {
			this.write(accountId, { ...current, allowedTools: [...allowed, tool] }, taskId);
		}
	}

	setAllowedTools(accountId: string, allowedTools: readonly string[], taskId?: string): void {
		this.write(accountId, { ...this.read(accountId, taskId), allowedTools: [...allowedTools] }, taskId);
	}

	clearTurns(accountId: string, taskId?: string): void {
		this.write(accountId, { ...this.read(accountId, taskId), turns: [] }, taskId);
	}

	popTurn(accountId: string, taskId?: string): IAssistantTurn | undefined {
		const current = this.read(accountId, taskId);
		const last = current.turns.at(-1);
		if (last) { this.write(accountId, { ...current, turns: current.turns.slice(0, -1) }, taskId); }
		return last;
	}

	truncateTurns(accountId: string, keep: number, taskId?: string): void {
		const current = this.read(accountId, taskId);
		if (keep < current.turns.length) { this.write(accountId, { ...current, turns: current.turns.slice(0, keep) }, taskId); }
	}

	createTask(accountId: string, target?: IAssistantAgentTarget): string {
		const current = this.read(accountId);
		const id = generateUuid();
		this.write(accountId, { ...current, tasks: [...(current.tasks ?? []), { id, title: '', status: 'draft', target: target && storeAssistantTaskTarget(target) }] });
		if (current.modelId) { this.setModel(accountId, current.modelId, id); }
		return id;
	}

	addAgentChat(accountId: string, resource: string, title: string): string {
		const current = this.read(accountId);
		const id = generateUuid();
		this.write(accountId, { ...current, agentChats: [...(current.agentChats ?? []), { id, resource, title }] });
		return id;
	}

	updateTask(accountId: string, taskId: string, change: Partial<Omit<IAssistantTask, 'id'>>): void {
		const current = this.read(accountId);
		this.write(accountId, { ...current, tasks: current.tasks?.map(task => task.id === taskId ? { ...task, ...change } : task) });
	}

	deleteTask(accountId: string, taskId: string): void {
		const current = this.read(accountId);
		this.write(accountId, { ...current, tasks: current.tasks?.filter(task => task.id !== taskId) });
		this.storage.remove(this.key(accountId, taskId), StorageScope.PROFILE);
	}

	appendTurn(accountId: string, turn: IAssistantTurn, taskId?: string, completedQueueId?: string): void {
		const current = this.read(accountId, taskId);
		const settled = completedQueueId && current.startedQueuedPrompt?.id === completedQueueId;
		this.write(accountId, { ...current, turns: [...current.turns, { at: Date.now(), ...turn }], ...(settled ? { startedQueuedPrompt: undefined } : {}) }, taskId);
	}

	private write(accountId: string, conversation: IAssistantConversation, taskId?: string): void {
		this.storage.store(this.key(accountId, taskId), conversation, StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private key(accountId: string, taskId?: string): string {
		if (!accountId) {
			throw new Error('A verified SignalREACH account id is required.');
		}
		return taskId
			? `sessions.assistant.taskConversation.${encodeURIComponent(accountId)}.${encodeURIComponent(taskId)}`
			: `sessions.assistant.conversation.${encodeURIComponent(accountId)}`;
	}
}
