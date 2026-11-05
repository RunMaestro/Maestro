import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockSession } from '../../helpers/mockSession';
import type { AITab, BatchRunState, FilePreviewTab, QueuedItem } from '../../../renderer/types';
import { useSessionStore, updateAiTab } from '../../../renderer/stores/sessionStore';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import { useComposerInputStore } from '../../../renderer/stores/composerInputStore';
import { useModalStore, registerExternalDestination } from '../../../renderer/stores/modalStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useRetirementDialogState } from '../../../renderer/hooks/worktree/useRetirementDialogState';
import {
	prepareRendererRetirement,
	cancelRendererRetirement,
	isRendererRetirementCurrent,
} from '../../../renderer/services/worktreeRetirementPreparation';

const request = {
	sessionId: 'child',
	parentSessionId: 'parent',
	path: '/child',
	parentPath: '/parent',
	token: 'opaque',
};
const child = () => useSessionStore.getState().sessions.find((s) => s.id === 'child')!;
const prepare = () => {
	const result = prepareRendererRetirement(request);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.reason);
	return result;
};

beforeEach(() => {
	useSessionStore.setState({
		sessions: [
			createMockSession({
				id: 'child',
				cwd: '/child',
				projectRoot: '/child',
				fullPath: '/child',
				parentSessionId: 'parent',
				aiTabs: [{ id: 'tab', state: 'idle', inputValue: '', logs: [{ text: 'saved' }] } as AITab],
			}),
			createMockSession({
				id: 'parent',
				cwd: '/parent',
				projectRoot: '/parent',
				fullPath: '/parent',
			}),
			createMockSession({ id: 'other', cwd: '/other', projectRoot: '/other', fullPath: '/other' }),
		],
		activeSessionId: 'child',
		sessionsReadOk: true,
		initialLoadComplete: true,
	});
	useBatchStore.setState({ batchRunStates: {} });
	useComposerInputStore.setState({ aiValue: '', aiValueTabId: 'tab', terminalValue: '' });
	useModalStore.setState({ modals: new Map() });
	useUIStore.setState({
		editingSessionId: null,
		editingQueuedItemId: null,
		openPluginPanelId: null,
	});
});
afterEach(() => {
	cancelRendererRetirement('child', 'opaque');
});

describe('authoritative retirement store admission', () => {
	it('retains idle saved chat, scopes updates, and releases only the matching revision owner', () => {
		const before = child();
		const result = prepare();
		expect(child()).toBe(before);
		expect(child().aiTabs[0].logs[0].text).toBe('saved');
		expect(isRendererRetirementCurrent('child', 'opaque', result.revision)).toBe(true);
		expect(cancelRendererRetirement('child', 'foreign')).toBe(false);
		expect(() => useSessionStore.getState().updateSession('child', { name: 'changed' })).toThrow(
			'frozen'
		);
		useSessionStore.getState().updateSession('other', { name: 'unrelated' });
		expect(useSessionStore.getState().sessions[2].name).toBe('unrelated');
		expect(cancelRendererRetirement('child', 'opaque')).toBe(true);
		expect(isRendererRetirementCurrent('child', 'opaque', result.revision)).toBe(false);
		useSessionStore.getState().updateSession('child', { name: 'allowed' });
		expect(child().name).toBe('allowed');
		const second = prepare();
		expect(second.revision).toBeGreaterThan(result.revision);
		expect(isRendererRetirementCurrent('child', 'opaque', result.revision)).toBe(false);
	});

	it.each([
		'action',
		'direct',
		'functional',
		'replace',
		'tab',
		'setSessions',
		'remove',
		'duplicate',
	] as const)('refuses %s session setters before committing', (route) => {
		prepare();
		const state = useSessionStore.getState();
		const changed = state.sessions.map((s) =>
			s.id === 'child' ? { ...s, executionQueue: [{ content: 'late' } as QueuedItem] } : s
		);
		const update = () => {
			if (route === 'action')
				state.updateSession('child', { executionQueue: [{ content: 'late' } as QueuedItem] });
			if (route === 'direct') useSessionStore.setState({ sessions: changed });
			if (route === 'functional') useSessionStore.setState(() => ({ sessions: changed }));
			if (route === 'replace') useSessionStore.setState({ ...state, sessions: changed }, true);
			if (route === 'tab') updateAiTab('child', 'tab', (tab) => ({ ...tab, state: 'busy' }));
			if (route === 'setSessions') state.setSessions(changed);
			if (route === 'remove') state.removeSession('child');
			if (route === 'duplicate')
				useSessionStore.setState({
					sessions: [state.sessions[2], state.sessions[1], state.sessions[2]],
				});
		};
		expect(update).toThrow('frozen');
		expect(useSessionStore.getState().sessions).toBe(state.sessions);
	});

	it('fences the surviving parent, new registrations, recovery and alias moves', () => {
		prepare();
		expect(() => useSessionStore.getState().updateSession('parent', { cwd: '/moved' })).toThrow(
			'frozen'
		);
		expect(() => useSessionStore.getState().addSession(createMockSession())).toThrow('frozen');
		expect(() => useSessionStore.getState().updateSession('other', { cwd: '/alias' })).toThrow(
			'frozen'
		);
		expect(() => useSessionStore.setState({ sessionReconciliationGeneration: 99 })).toThrow(
			'frozen'
		);
	});

	it('blocks Auto Run reducers, direct batch setters, and composer writes', () => {
		prepare();
		expect(() =>
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'child',
				payload: {
					documents: ['task'],
					lockedDocuments: [],
					totalTasksAcrossAllDocs: 1,
					loopEnabled: false,
					folderPath: '/child',
					worktreeActive: false,
					startTime: 0,
					cumulativeTaskTimeMs: 0,
					accumulatedElapsedMs: 0,
					lastActiveTimestamp: 0,
				},
			})
		).toThrow('frozen');
		expect(() =>
			useBatchStore.getState().setBatchRunStates({ child: { isRunning: true } as BatchRunState })
		).toThrow('frozen');
		expect(() =>
			useBatchStore.setState({ batchRunStates: { parent: { isRunning: true } as BatchRunState } })
		).toThrow('frozen');
		expect(() => useComposerInputStore.getState().setAiValue('draft')).toThrow('frozen');
		expect(() => useComposerInputStore.setState({ terminalValue: 'ls' })).toThrow('frozen');
		useSessionStore.setState({ activeSessionId: 'other' });
		useComposerInputStore.getState().loadAiDraft(null, 'parked', 'off');
		expect(() => useSessionStore.setState({ activeSessionId: 'child' })).toThrow('frozen');
	});

	it('rejects late file tabs and dialogs before side effects while allowing the details surface', () => {
		prepare();
		const unregister = registerExternalDestination(() => {
			throw new Error('destination callback ran');
		});
		expect(() => useModalStore.getState().openModal('settings')).toThrow('frozen');
		unregister();
		useModalStore.getState().openModal('worktreePRDetails', { sessionId: 'child' });
		expect(() => useUIStore.setState({ editingQueuedItemId: 'item' })).toThrow('frozen');
		expect(() =>
			useSessionStore
				.getState()
				.updateSession('other', { filePreviewTabs: [{ path: '/alias/file' } as FilePreviewTab] })
		).toThrow('frozen');
	});

	it.each(['draft', 'held queue', 'batch', 'file', 'modal', 'editor', 'ownership', 'ssh'] as const)(
		'does not acknowledge %s and releases failed preparation',
		(blocker) => {
			if (blocker === 'draft') useComposerInputStore.getState().setAiValue('unsaved');
			if (blocker === 'held queue')
				useSessionStore
					.getState()
					.updateSession('child', { executionQueue: [{ paused: true } as QueuedItem] });
			if (blocker === 'batch')
				useBatchStore.setState({
					batchRunStates: { child: { isRunning: true, errorPaused: true } as BatchRunState },
				});
			if (blocker === 'file')
				useSessionStore
					.getState()
					.updateSession('other', { filePreviewTabs: [{} as FilePreviewTab] });
			if (blocker === 'modal') useModalStore.getState().openModal('promptComposer');
			if (blocker === 'editor') useUIStore.getState().setEditingQueuedItemId('draft');
			if (blocker === 'ownership')
				useSessionStore.getState().updateSession('child', { parentSessionId: 'stale' });
			if (blocker === 'ssh')
				useSessionStore.getState().updateSession('child', { sshRemoteId: 'remote' });
			expect(prepareRendererRetirement(request).ok).toBe(false);
			expect(isRendererRetirementCurrent('child', 'opaque', 1)).toBe(false);
			// A failed prepare must never strand ordinary work behind the guard.
			useSessionStore.getState().updateSession('child', { name: 'unfrozen' });
			expect(child().name).toBe('unfrozen');
		}
	);

	it('tracks local dialog ownership synchronously, before the modal layer can render', () => {
		const { result, unmount } = renderHook(() => useRetirementDialogState<{ draft: string }>());
		act(() => {
			result.current[1]({ draft: 'unsaved' });
			expect(prepareRendererRetirement(request)).toEqual({
				ok: false,
				reason: 'open editing dialog',
			});
		});
		act(() => result.current[1](null));
		prepare();
		expect(() => act(() => result.current[1]({ draft: 'late' }))).toThrow('frozen');
		expect(result.current[0]).toBeNull();
		cancelRendererRetirement('child', 'opaque');
		act(() => result.current[1]({ draft: 'before unmount' }));
		const delayedOpen = result.current[1];
		unmount();
		act(() => delayedOpen({ draft: 'read completed after unmount' }));
		prepare();
	});
});
