/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellationError, timeout } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, waitForState } from '../../../../base/common/observable.js';
import { posix } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, NotificationPriority, Severity } from '../../../../platform/notification/common/notification.js';
import { ILifecycleService, LifecyclePhase } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { ISessionsSetUpService } from '../../../browser/sessionsSetUpService.js';
import { WorkspaceSelectionOrigin } from '../../../../workbench/services/sessions/common/workspaceSelection.js';
import { ISessionsPartService } from '../../../../workbench/services/sessions/browser/sessionsPartService.js';
import { ISessionsService } from '../../../../workbench/contrib/sessions/browser/sessionsService.js';
import { IFocusedSessionHostService } from '../../../../workbench/services/sessions/browser/sessionHost.js';
import { ISessionsManagementService } from '../../../../workbench/contrib/sessions/common/sessionsManagement.js';
import { WorkspaceHandoffState } from '../../sessions/browser/sessionsWindowOpenTelemetry.js';
import { SessionsView, SessionsViewId } from '../../../../workbench/contrib/sessions/browser/views/sessionsView.js';
import { INewSessionComposerService } from '../../../../workbench/contrib/sessions/browser/newSessionComposerService.js';
import { IAgentsWindowDraft } from '../../../../platform/window/common/window.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { readNewChatDraftState } from '../../../../workbench/contrib/sessions/common/newChatDraftState.js';
import { IRemoteWorkspaceHandoffService } from '../../../common/remoteWorkspaceHandoff.js';
import { IAgentsWindowRemoteWorkspace } from './agentsWindowOpenIntent.js';
import { isSessionCreated } from '../../../../workbench/services/sessions/common/session.js';
import { ISessionDraftsService } from '../../../../workbench/contrib/sessions/browser/sessionDraftsService.js';
import { SESSIONS_DRAFTS_ENABLED_SETTING } from '../../../../workbench/contrib/sessions/common/sessionConfig.js';
import { ChatInputNotificationActionKind, ChatInputNotificationSeverity, IChatInputNotificationService } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputNotificationService.js';

export const WORKSPACE_HANDOFF_TIMEOUT_MS = 15_000;

const preservedWorkspaceNoticeId = 'agents.workspaceHandoff.preserved';
const openPreservedWorkspaceCommandId = 'sessions.workspaceHandoff.openPreservedWorkspace';

export interface IAgentsWindowWorkspaceHandoff {
	readonly folderUri?: URI;
	/**
	 * The workspace of a remote editor window. Its folder replaces {@link folderUri} once the
	 * remote agent host on the same machine provides it; otherwise a non-draft intent starts
	 * without a workspace rather than with an unrelated local one.
	 */
	readonly remote?: IAgentsWindowRemoteWorkspace;
	readonly preferDevContainer: boolean;
	readonly isDefault: boolean;
	readonly draft?: IAgentsWindowDraft;
	readonly noWorkspace?: boolean;
	readonly revealNewSession?: boolean;
	/** The first editor mode switch takes precedence over automatic picks made during startup. */
	readonly initialWorkspaceSwitch?: boolean;
	/** Called only when the composer actually applies this folder, including an explicit retry. */
	readonly onWorkspaceSelected?: (folder: URI) => void;
}

/** Keeps one opening intent alive until the target composer applies it or a newer user intent wins. */
export class AgentsWindowWorkspaceHandoff extends Disposable {
	private readonly _pending = this._register(new MutableDisposable<DisposableStore>());
	private readonly _notification = this._register(new MutableDisposable());
	private _cancelPending: ((state: WorkspaceHandoffState) => void) | undefined;
	private _startupProvidersRegistered = false;
	private _noticeVersion = 0;

	/**
	 * @param whenStartupProvidersRegistered Settles once the providers that register during startup have
	 * registered. Several of them can accept the same folder, so resolving earlier can pick whichever registered
	 * first instead of the preferred provider, for example Cloud instead of This Computer for a local folder.
	 */
	constructor(
		private readonly whenStartupProvidersRegistered: Promise<unknown>,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IFocusedSessionHostService private readonly _focusedSessionHostService: IFocusedSessionHostService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@ISessionsPartService private readonly sessionsPartService: ISessionsPartService,
		@ISessionsSetUpService private readonly sessionsSetUpService: ISessionsSetUpService,
		@INewSessionComposerService private readonly composerService: INewSessionComposerService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IViewsService private readonly viewsService: IViewsService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService,
		@IRemoteWorkspaceHandoffService private readonly remoteWorkspaceHandoffService: IRemoteWorkspaceHandoffService,
		@ISessionDraftsService private readonly sessionDraftsService: ISessionDraftsService,
		@IChatInputNotificationService private readonly inputNotifications: IChatInputNotificationService,
	) {
		super();
		this._register(lifecycleService.onWillShutdown(() => this.cancel()));
		whenStartupProvidersRegistered.finally(() => this._startupProvidersRegistered = true).catch(() => undefined);
	}

	cancel(): void {
		this._cancelPending?.('superseded');
		this._pending.clear();
		this._notification.clear();
	}

	async selectWorkspace(intent: IAgentsWindowWorkspaceHandoff, onState: (state: WorkspaceHandoffState) => void): Promise<void> {
		this.cancel();
		const store = new DisposableStore();
		this._pending.value = store;
		const source = new CancellationTokenSource();
		let finished = false;
		const cancel = (state: WorkspaceHandoffState) => {
			if (!finished && !source.token.isCancellationRequested) {
				onState(state);
				source.cancel();
			}
		};
		this._cancelPending = cancel;
		store.add(toDisposable(() => {
			cancel('cancelled');
			source.dispose(true);
			if (this._cancelPending === cancel) {
				this._cancelPending = undefined;
			}
		}));
		const selectionVersion = this.composerService.userWorkspaceSelectionVersion.get();
		const navigationVersion = this.composerService.userNavigationVersion.get();
		const draftInputVersion = this.composerService.draftInputVersion.get();
		const navigationRequest = this.sessionsService.navigationRequest.get();
		store.add(autorun(reader => {
			const currentNavigation = this.sessionsService.navigationRequest.read(reader);
			if (this.composerService.userWorkspaceSelectionVersion.read(reader) !== selectionVersion
				|| this.composerService.userNavigationVersion.read(reader) !== navigationVersion
				|| (intent.draft && this.composerService.draftInputVersion.read(reader) !== draftInputVersion)
				|| (currentNavigation !== navigationRequest && currentNavigation?.token !== source.token)) {
				cancel('userChanged');
			}
		}));
		store.add(Event.once(this.sessionsManagementService.onWillSendRequest)(() => cancel('sessionAlreadyCreated')));
		store.add(Event.once(this.composerService.onWillSendRequest)(() => cancel('sessionAlreadyCreated')));
		let restoreComplete = this.sessionsService.initialRestoreComplete.get();
		let previousSession = this._focusedSessionHostService.focusedHost.get().session.get();
		let previousCreated = isSessionCreated(previousSession);
		store.add(autorun(reader => {
			const restored = this.sessionsService.initialRestoreComplete.read(reader);
			const session = this._focusedSessionHostService.focusedHost.read(reader).session.read(reader);
			const created = isSessionCreated(session, reader);
			if (restoreComplete && created && (session !== previousSession || !previousCreated)) {
				cancel('sessionAlreadyCreated');
			}
			restoreComplete = restored;
			previousSession = session;
			previousCreated = created;
		}));
		try {
			if ((intent.initialWorkspaceSwitch || (intent.draft && !intent.revealNewSession)) && this._hasDraftInput()) {
				onState('preservedSession');
				return;
			}
			const startRemoteResolution = () => {
				const resolution = intent.remote?.folder ? this.remoteWorkspaceHandoffService.resolveFolder(intent.remote.folder, source.token) : undefined;
				resolution?.catch(() => undefined);
				return resolution;
			};
			// Registering and connecting the remote host runs while setup and the session view get ready. An inferred
			// default waits for restore instead, so it never adds or connects a host for a window that keeps its session.
			const inferredDefault = intent.isDefault && !intent.draft && !intent.revealNewSession;
			let remoteResolution = inferredDefault ? undefined : startRemoteResolution();
			onState('waitingForSetup');
			await raceCancellationError(this.sessionsSetUpService.whenWelcomeDone(), source.token);
			if (source.token.isCancellationRequested) {
				return;
			}
			onState('waitingForSessionView');
			if (inferredDefault) {
				await waitForState(this.sessionsService.initialRestoreComplete, complete => complete, undefined, source.token);
				if (isSessionCreated(this._focusedSessionHostService.focusedHost.get().session.get()) || this._hasDraftInput()) {
					onState('preservedSession');
					return;
				}
				remoteResolution = startRemoteResolution();
			} else {
				await raceCancellationError(this.lifecycleService.when(LifecyclePhase.Restored), source.token);
				if (source.token.isCancellationRequested) {
					return;
				}
				if ((intent.initialWorkspaceSwitch || (intent.draft && !intent.revealNewSession)) && this._hasDraftInput()) {
					onState('preservedSession');
					return;
				}
				if (!intent.draft || intent.revealNewSession) {
					// Navigation can rebind the mounted composer before its draft is restored.
					const preserveDraft = intent.revealNewSession && this._hasDraftInput();
					await this.sessionsService.openNewSession({ cancelRestore: true }, source.token);
					if (preserveDraft) {
						if (!source.token.isCancellationRequested) {
							onState('preservedSession');
						}
						return;
					}
				}
			}

			let folderUri = intent.folderUri;
			let remoteUnavailableReason: string | undefined;
			if (remoteResolution) {
				onState('waitingForProvider');
				const resolution = await raceCancellationError(remoteResolution, source.token);
				folderUri = resolution.folderUri ?? folderUri;
				remoteUnavailableReason = resolution.unavailableReason;
			}
			if (folderUri && !this._startupProvidersRegistered) {
				onState('waitingForProvider');
				await raceCancellationError(this.whenStartupProvidersRegistered.catch(() => undefined), source.token);
			}
			// A remote editor window must not fall back to an unrelated local folder.
			const remoteWithoutFolder = !!intent.remote && !intent.draft && !folderUri;
			let draftNeedsNavigation = !!intent.draft && !intent.revealNewSession;
			let noWorkspaceNeedsSelection = !!intent.noWorkspace || remoteWithoutFolder;
			const deadline = Date.now() + WORKSPACE_HANDOFF_TIMEOUT_MS;
			while (!source.token.isCancellationRequested) {
				const currentSession = this._focusedSessionHostService.focusedHost.get().session.get();
				if ((!intent.draft && isSessionCreated(currentSession)) || ((intent.isDefault || intent.initialWorkspaceSwitch || intent.draft || intent.revealNewSession) && this._hasDraftInput())) {
					onState('preservedSession');
					return;
				}

				const resolved = folderUri ? this.sessionsManagementService.resolveWorkspace(folderUri) : undefined;
				const providerReady = !folderUri || !!resolved;
				if (draftNeedsNavigation && providerReady) {
					await this.sessionsService.openNewSession({ cancelRestore: true }, source.token);
					draftNeedsNavigation = false;
					if (source.token.isCancellationRequested) {
						return;
					}
				}
				const session = this._focusedSessionHostService.focusedHost.get().session.get();
				if (!draftNeedsNavigation && isSessionCreated(session)) {
					onState('preservedSession');
					return;
				}
				const view = draftNeedsNavigation ? undefined : this.sessionsPartService.getSessionView(session?.sessionId);
				if (noWorkspaceNeedsSelection && view) {
					const result = view.selectNoWorkspace({ userSelection: false, preserveNavigation: true, isDefault: intent.isDefault && !intent.draft });
					if (intent.draft) {
						noWorkspaceNeedsSelection = false;
						continue;
					}
					if (result === 'preserved') {
						onState('preservedSession');
						return;
					}
					if (result === 'applied') {
						if (remoteWithoutFolder) {
							onState(remoteUnavailableReason ? 'providerUnavailable' : 'unsupportedWorkspace');
							this._showRemoteUnavailable(intent, remoteUnavailableReason);
						} else {
							onState('applied');
						}
						return;
					}
				}
				const options = {
					providerId: resolved?.providerId,
					preferDevContainer: intent.preferDevContainer,
					selectionOrigin: (intent.isDefault || intent.initialWorkspaceSwitch) && !intent.draft ? WorkspaceSelectionOrigin.WindowContext : WorkspaceSelectionOrigin.WindowOpen,
					isDefault: intent.isDefault && !intent.draft,
				};
				const result = intent.draft
					? providerReady ? await view?.applyDraft(intent.draft, folderUri, options, source.token) : undefined
					: resolved && folderUri ? view?.selectWorkspace(folderUri, options) : undefined;
				if (source.token.isCancellationRequested) {
					return;
				}
				if (result === 'preserved') {
					onState('preservedSession');
					return;
				}
				if (result === 'applied') {
					onState('applied');
					if (folderUri) {
						intent.onWorkspaceSelected?.(folderUri);
						this.viewsService.getViewWithId<SessionsView>(SessionsViewId)?.sessionsControl?.setOpenWindowSourceFolder(folderUri);
					}
					return;
				}
				const state = !providerReady ? 'waitingForProvider' : !view ? 'waitingForSessionView' : 'selectionRequested';
				onState(state);
				if (Date.now() >= deadline) {
					onState(!providerReady ? 'providerUnavailable' : !view ? 'viewUnavailable' : 'selectionNotApplied');
					this.logService.warn(`[AgentsHandoff] Workspace selection timed out: ${state}`);
					if (intent.draft || !intent.isDefault) {
						this._showRecovery(intent, onState);
					}
					return;
				}
				// View construction and provider readiness can finish independently of lifecycle phases.
				await timeout(100, source.token);
			}
		} catch (error) {
			if (!source.token.isCancellationRequested && !isCancellationError(error)) {
				onState('error');
				if (intent.draft) {
					this.logService.error('[AgentsHandoff] Draft handoff failed');
				} else {
					this.logService.error('[AgentsHandoff] Workspace selection failed', error);
				}
				if (intent.draft || !intent.isDefault) {
					this._showRecovery(intent, onState);
				}
			}
		} finally {
			finished = true;
			if (this._pending.value === store) {
				this._cancelPending = undefined;
				this._pending.clear();
			}
		}
	}

	private _hasDraftInput(): boolean {
		const activeSession = this._focusedSessionHostService.focusedHost.get().session.get();
		if (!isSessionCreated(activeSession) && !activeSession?.isQuickChat?.get()) {
			const mountedInput = this.composerService.getDraftInputStateForSession(activeSession?.resource);
			if (mountedInput !== undefined) {
				return mountedInput;
			}
		}
		const savedDraft = readNewChatDraftState(this.storageService);
		return !!savedDraft && (!!savedDraft.inputText || savedDraft.attachments.length > 0);
	}

	/** Offers an explicit way to continue after an automatic workspace switch preserves the current session. */
	promptOpenPreservedWorkspace(target: Pick<IAgentsWindowWorkspaceHandoff, 'folderUri' | 'remote' | 'preferDevContainer' | 'onWorkspaceSelected'>): void {
		const message = localize('agentsHandoff.sessionPreserved', "Agents kept the current session. Start a new session to open another workspace.");
		if (!target.folderUri && !target.remote?.folder) {
			this.notificationService.info(message);
			return;
		}

		const hasDraft = this._hasDraftInput();
		const draftSettings = hasDraft && !this.sessionDraftsService.enabled.get();
		const notice = new DisposableStore();
		const host = this._focusedSessionHostService.focusedHost.get();
		const composer = this.composerService.activeComposer.get();
		const inputUri = composer && !isSessionCreated(host.session.get()) && this.composerService.getComposer(host) === composer ? composer.inputUri : undefined;
		const choice = draftSettings
			? {
				label: localize('agentsHandoff.openDraftSettings', "Open Draft Settings"),
				run: () => this.commandService.executeCommand('workbench.action.openSettings', `@id:${SESSIONS_DRAFTS_ENABLED_SETTING}`),
			}
			: {
				label: hasDraft ? localize('agentsHandoff.saveAndOpenWorkspace', "Save Draft and Open Workspace") : localize('agentsHandoff.openWorkspace', "Open Workspace"),
				run: async () => {
					if (this._hasDraftInput()) {
						try {
							const saved = this.sessionDraftsService.enabled.get() && this.sessionDraftsService.stowAndClear(undefined, { keepScheduledPreview: true });
							if (!saved) {
								this.notificationService.info(localize('agentsHandoff.couldNotStowDraft', "Agents kept the current draft because it could not be saved to Drafts."));
								return;
							}
						} catch (error) {
							this.notificationService.error(error);
							return;
						}
					}
					await this.selectWorkspace({ ...target, isDefault: false, revealNewSession: true }, () => {});
				},
			};
		let running = false;
		const activate = async () => {
			if (this._notification.value !== notice || running) {
				return;
			}
			running = true;
			try {
				await choice.run();
			} finally {
				if (this._notification.value === notice) {
					this._notification.clear();
				}
			}
		};
		this._notification.value = notice;
		const notification = this.notificationService.prompt(Severity.Info, message, [{ label: choice.label, run: activate }], inputUri ? { priority: NotificationPriority.SILENT } : undefined);
		notice.add(toDisposable(() => notification.close()));
		notice.add(Event.once(notification.onDidClose)(() => {
			if (!notice.isDisposed && this._notification.value === notice) {
				this._notification.clear();
			}
		}));
		notice.add(Event.once(this.composerService.onWillSendRequest)(() => this._notification.clear()));
		if (inputUri) {
			const version = ++this._noticeVersion;
			const folderPath = target.folderUri?.path ?? target.remote?.folder?.path;
			const folderName = folderPath && (posix.basename(folderPath) || folderPath);
			notice.add(CommandsRegistry.registerCommand(openPreservedWorkspaceCommandId, (_accessor, requestedVersion: unknown) => {
				if (requestedVersion === version && this._notification.value === notice && this.composerService.activeComposer.get() === composer) {
					return activate();
				}
				return undefined;
			}));
			this.inputNotifications.setNotification({
				id: preservedWorkspaceNoticeId,
				inputUri,
				severity: ChatInputNotificationSeverity.Info,
				message: hasDraft ? localize('agentsHandoff.inlineDraftKept', "Your draft stayed in this workspace.") : localize('agentsHandoff.inlineWorkspaceKept', "Agents kept this workspace."),
				description: folderName ? localize('agentsHandoff.inlineRequestedWorkspace', "The switch requested {0}.", folderName) : undefined,
				actions: [{ kind: ChatInputNotificationActionKind.Command, label: choice.label, primary: true, commandId: openPreservedWorkspaceCommandId, commandArgs: [version], keepOpen: true }],
				dismissible: true,
				onDismiss: () => { if (this._notification.value === notice) { this._notification.clear(); } },
				autoDismissOnMessage: true,
			});
			notice.add(toDisposable(() => this.inputNotifications.deleteNotification(preservedWorkspaceNoticeId)));
		}
		const navigationVersion = this.composerService.userNavigationVersion.get();
		const selectionVersion = this.composerService.userWorkspaceSelectionVersion.get();
		notice.add(autorun(reader => {
			const navigation = this.composerService.userNavigationVersion.read(reader);
			const selection = this.composerService.userWorkspaceSelectionVersion.read(reader);
			if (navigation !== navigationVersion || selection !== selectionVersion) {
				this._notification.clear();
			}
		}));
	}

	private _showRecovery(intent: IAgentsWindowWorkspaceHandoff, onState: (state: WorkspaceHandoffState) => void): void {
		const notification = this.notificationService.prompt(Severity.Warning,
			intent.draft
				? localize('agentsHandoff.draftUnavailable', "The draft could not be copied to the Agents Window. Your prompt and attachments are still in the editor. Try again or choose a workspace to continue.")
				: localize('agentsHandoff.workspaceUnavailable', "The workspace could not be selected. Try again or choose a workspace to continue."),
			[
				{ label: localize('agentsHandoff.retry', "Retry"), run: () => this.selectWorkspace(intent, onState) },
				{ label: localize('agentsHandoff.chooseWorkspace', "Choose Workspace"), run: () => this.commandService.executeCommand('workbench.action.sessions.newSession.pickFolderQuickPick') },
			]);
		this._notification.value = toDisposable(() => notification.close());
	}

	/** Explains why the remote editor window's folder is not selected after starting without a workspace. */
	private _showRemoteUnavailable(intent: IAgentsWindowWorkspaceHandoff, reason: string | undefined): void {
		const message = reason
			? localize('agentsHandoff.remoteUnavailable', "The folder of your remote window could not be opened in the Agents Window. {0}", reason)
			: intent.remote?.kind === 'codespaces'
				? localize('agentsHandoff.codespacesUnsupported', "The Agents Window cannot open folders from GitHub Codespaces yet. Choose a workspace to continue.")
				: localize('agentsHandoff.remoteUnsupported', "The Agents Window cannot open folders from this kind of remote yet. Choose a workspace to continue.");
		const notification = this.notificationService.prompt(Severity.Warning, message, [
			{ label: localize('agentsHandoff.chooseWorkspace', "Choose Workspace"), run: () => this.commandService.executeCommand('workbench.action.sessions.newSession.pickFolderQuickPick') },
		]);
		this._notification.value = toDisposable(() => notification.close());
	}
}
