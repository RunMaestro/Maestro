import { normalizeWorktreePath } from '../../shared/worktreePaths';
import { useSessionStore, type SessionStore } from '../stores/sessionStore';
import { useBatchStore, type BatchStore } from '../stores/batchStore';
import { useComposerInputStore } from '../stores/composerInputStore';
import { useModalStore, type ModalStore } from '../stores/modalStore';
import { useUIStore, type UIStore } from '../stores/uiStore';
import { retirementSessionBlocker } from './worktreeRetirementInspection';
import { WorktreeRetirementFreeze } from './worktreeRetirementFreeze';
import { hasRetirementDialogs, registerRetirementStoreGuard } from './worktreeRetirementStoreGuard';

import {
	prepareSessionForPersistence,
	SESSION_PERSISTENCE_BASELINE_EVENT,
} from '../hooks/utils/useDebouncedPersistence';

import type { RendererRetirementRequest } from '../../shared/worktreeRetirement';
const freeze = new WorktreeRetirementFreeze();
const preparations = new Map<
	string,
	{
		token: string;
		release: () => void;
		parentSessionId: string;
		path: string;
		completed?: boolean;
	}
>();
let completion: SessionStore | undefined;
function fail(reason: string): never {
	throw new Error(`Worktree retirement: ${reason}`);
}

function modalBlocker(state: ModalStore): boolean {
	// The lifecycle details surface is read-only during preparation. All other
	// dialogs may hold a local draft or a callback with a stale checkout path.
	return [...state.modals].some(([id, entry]) => entry.open && id !== 'worktreePRDetails');
}

function editorBlocker(state: UIStore): boolean {
	return !!(state.editingSessionId || state.editingQueuedItemId || state.openPluginPanelId);
}

/** Freeze the actual stores before reading live drafts, queues and editors.
 * This revision is an input to Main's eventual token-owned transaction, never
 * standalone deletion authority. Main must revalidate ownership and its sender.
 */
export function prepareRendererRetirement(request: RendererRetirementRequest) {
	if (
		!request.sessionId ||
		!request.parentSessionId ||
		request.sessionId === request.parentSessionId ||
		!request.path ||
		!request.parentPath ||
		!request.token
	)
		return { ok: false as const, reason: 'missing retirement identity' };
	if (preparations.size)
		return { ok: false as const, reason: 'renderer preparation already active' };
	const protectedIds = new Set([request.sessionId, request.parentSessionId]);
	const release = registerRetirementStoreGuard((kind, previous, next) => {
		if (!freeze.isFrozen(request.sessionId)) return;
		switch (kind) {
			case 'sessions': {
				if (next === completion) return;
				const before = previous as SessionStore;
				const after = next as SessionStore;
				if (
					before.sessionsReadOk !== after.sessionsReadOk ||
					before.initialLoadComplete !== after.initialLoadComplete ||
					before.sessionReconciliationGeneration !== after.sessionReconciliationGeneration
				)
					fail('registration recovery is frozen');
				if (
					before.activeSessionId !== after.activeSessionId &&
					protectedIds.has(after.activeSessionId)
				) {
					const composer = useComposerInputStore.getState();
					if (composer.terminalValue || (composer.aiValue && composer.aiValueTabId === null))
						fail('composer ownership is frozen');
				}
				if (before.sessions === after.sessions) break;
				if (before.sessions.length !== after.sessions.length) fail('registration is frozen');
				if (new Set(after.sessions.map((session) => session.id)).size !== after.sessions.length)
					fail('duplicate registration is frozen');
				for (const session of after.sessions) {
					const old = before.sessions.find((candidate) => candidate.id === session.id);
					if (!old) fail('registration is frozen');
					if (protectedIds.has(session.id) && old !== session) fail('target session is frozen');
					if (
						old.cwd !== session.cwd ||
						old.projectRoot !== session.projectRoot ||
						old.fullPath !== session.fullPath ||
						old.parentSessionId !== session.parentSessionId ||
						old.sshRemoteId !== session.sshRemoteId ||
						old.sessionSshRemoteConfig !== session.sessionSshRemoteConfig
					)
						fail('checkout registration is frozen');
					// Renderer paths cannot prove that a file is not a symlink into
					// the target. The first supported mode requires all file tabs closed.
					if (session.filePreviewTabs.length) fail('file editor admission is frozen');
				}
				break;
			}
			case 'batch': {
				const before = previous as BatchStore;
				const after = next as BatchStore;
				for (const id of protectedIds)
					if (before.batchRunStates[id] !== after.batchRunStates[id]) fail('Auto Run is frozen');
				break;
			}
			case 'composer': {
				const after = next as ReturnType<typeof useComposerInputStore.getState>;
				const state = useSessionStore.getState();
				const owner = state.sessions.find((s) => s.aiTabs.some((t) => t.id === after.aiValueTabId));
				if (
					(after.aiValue && protectedIds.has(owner?.id ?? state.activeSessionId)) ||
					(after.terminalValue && protectedIds.has(state.activeSessionId))
				)
					fail('composer is frozen');
				break;
			}
			case 'modals':
				if (modalBlocker(next as ModalStore)) fail('editing dialog admission is frozen');
				break;
			case 'ui':
				if (editorBlocker(next as UIStore)) fail('editor admission is frozen');
		}
	});
	try {
		const result = freeze.prepare(request.sessionId, request.token, () => {
			const state = useSessionStore.getState();
			if (!state.sessionsReadOk || !state.initialLoadComplete) return 'registration not loaded';
			const child = state.sessions.filter((s) => s.id === request.sessionId);
			const parent = state.sessions.filter((s) => s.id === request.parentSessionId);
			if (
				child.length !== 1 ||
				parent.length !== 1 ||
				child[0].parentSessionId !== parent[0].id ||
				parent[0].parentSessionId ||
				[child[0], parent[0]].some(
					(session) => session.sshRemoteId || session.sessionSshRemoteConfig?.enabled
				) ||
				normalizeWorktreePath(child[0].cwd) !== normalizeWorktreePath(request.path) ||
				normalizeWorktreePath(child[0].projectRoot) !== normalizeWorktreePath(request.path) ||
				normalizeWorktreePath(parent[0].cwd) !== normalizeWorktreePath(request.parentPath)
			)
				return 'renderer registration differs from Main';
			if (
				hasRetirementDialogs() ||
				modalBlocker(useModalStore.getState()) ||
				editorBlocker(useUIStore.getState())
			)
				return 'open editing dialog';
			if (state.sessions.some((s) => s.filePreviewTabs.length)) return 'open file tabs';
			for (const session of [child[0], parent[0]]) {
				if (session.autoRunMode === 'edit' && session.autoRunContent) return 'Auto Run editor';
				const blocker = retirementSessionBlocker(
					session,
					useBatchStore.getState().batchRunStates[session.id],
					useComposerInputStore.getState(),
					state.activeSessionId === session.id
				);
				if (blocker) return blocker;
			}
			return undefined;
		});
		if (result.ok)
			preparations.set(request.sessionId, {
				token: request.token,
				release,
				parentSessionId: request.parentSessionId,
				path: request.path,
			});
		else release();
		if (result.ok) {
			const state = useSessionStore.getState();
			return {
				...result,
				snapshots: state.sessions
					.filter((s) => protectedIds.has(s.id))
					.map(prepareSessionForPersistence),
			};
		}
		return result;
	} catch (error) {
		cancelRendererRetirement(request.sessionId, request.token);
		release();
		throw error;
	}
}

export function isRendererRetirementCurrent(sessionId: string, token: string, revision: number) {
	return freeze.isCurrent(sessionId, token, revision);
}

/** Main sends this only after its archive and registration removal are durable.
 * Apply exactly one owned store replacement; never release the guard to call
 * ordinary setters. Duplicate replies are safe after transport uncertainty.
 */
export function completeRendererRetirement(
	sessionId: string,
	token: string,
	revision: number
): boolean {
	const preparation = preparations.get(sessionId);
	if (!preparation || !freeze.isCurrent(sessionId, token, revision)) return false;
	if (preparation.completed) return true;
	const state = useSessionStore.getState();
	if (!state.sessions.some((s) => s.id === preparation.parentSessionId)) return false;
	const sessions = state.sessions.filter((s) => s.id !== sessionId);
	completion = {
		...state,
		sessions,
		activeSessionId:
			state.activeSessionId === sessionId ? preparation.parentSessionId : state.activeSessionId,
		removedWorktreePaths: new Set([...state.removedWorktreePaths, preparation.path]),
	};
	try {
		useSessionStore.setState(completion, true);
	} finally {
		completion = undefined;
	}
	// The durable target snapshot is archived in Main. Preserve pending edits to
	// unrelated sessions while retiring this id from the debounce baseline.
	window.dispatchEvent(
		new CustomEvent(SESSION_PERSISTENCE_BASELINE_EVENT, {
			detail: { sessions: [], removedIds: [sessionId] },
		})
	);
	preparation.completed = true;
	return true;
}

/** Only Main's matching abort/completion may thaw an acknowledged preparation. */
export function cancelRendererRetirement(sessionId: string, token: string): boolean {
	const preparation = preparations.get(sessionId);
	if (!preparation || preparation.token !== token || !freeze.cancel(sessionId, token)) return false;
	preparations.delete(sessionId);
	preparation.release();
	return true;
}
