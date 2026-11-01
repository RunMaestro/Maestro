/**
 * @file useFileTreeManagement.test.ts
 * @description Unit tests for the useFileTreeManagement hook
 *
 * Tests cover:
 * - refreshFileTree success/error flows
 * - refreshGitFileState git metadata + history refresh
 * - filteredFileTree fuzzy filtering behavior
 * - initial file tree load on active session change
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
	useFileTreeManagement,
	type UseFileTreeManagementDeps,
} from '../../../renderer/hooks/git/useFileTreeManagement';
import type { Session } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { withWorkingDirectory } from '../../../renderer/utils/agentWorkingDirectory';
import type { FileNode } from '../../../renderer/types/fileTree';
import type { RightPanelHandle } from '../../../renderer/components/RightPanel';
import type { RefObject, SetStateAction } from 'react';
import {
	loadFileTree,
	loadFileTreeRemoteBatched,
	compareFileTrees,
} from '../../../renderer/utils/fileExplorer';
import { gitService } from '../../../renderer/services/git';
import { useFileExplorerStore } from '../../../renderer/stores/fileExplorerStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { logger } from '../../../renderer/utils/logger';
import { isWebDesktop } from '../../../renderer/utils/runtimeContext';
import { BridgeTransportError, WEB_BRIDGE_STATE_EVENT } from '../../../shared/bridgeError';

vi.mock('../../../renderer/utils/fileExplorer', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../renderer/utils/fileExplorer')>();
	return {
		...actual,
		loadFileTree: vi.fn(),
		loadFileTreeRemoteBatched: vi.fn(),
		compareFileTrees: vi.fn(),
	};
});

/** Wrap a tree array into the shape loadFileTree now returns. */
const asResult = (tree: FileNode[], truncated = false) => ({
	tree,
	truncated,
	filesFound: tree.length,
});

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		isRepo: vi.fn(),
		getBranches: vi.fn(),
		getTags: vi.fn(),
	},
}));

// Switching agents cancels an in-flight walk ONLY in the browser build, where
// every readDir shares one WebSocket. The real `isWebDesktop` memoizes its
// answer on first call, so drive it through the module mock rather than by
// poking `window.__MAESTRO_CONFIG__` mid-test.
vi.mock('../../../renderer/utils/runtimeContext', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../renderer/utils/runtimeContext')>();
	return { ...actual, isWebDesktop: vi.fn(() => false) };
});

/** Run the enclosing test as the browser build instead of Electron. */
const asWebDesktop = () => vi.mocked(isWebDesktop).mockReturnValue(true);

// ============================================================================
// Test Helpers
// ============================================================================

// createMockSession imported from shared helper

const createSessionsState = (initialSessions: Session[]) => {
	let sessions = initialSessions;
	const sessionsRef = { current: sessions };
	const setSessions = vi.fn((updater: SetStateAction<Session[]>) => {
		sessions = typeof updater === 'function' ? updater(sessions) : updater;
		sessionsRef.current = sessions;
	});

	return {
		getSessions: () => sessions,
		sessionsRef,
		setSessions,
	};
};

const createDeps = (
	state: ReturnType<typeof createSessionsState>,
	overrides: Partial<UseFileTreeManagementDeps> = {}
): UseFileTreeManagementDeps => ({
	sessionsRef: state.sessionsRef,
	setSessions: state.setSessions,
	activeSessionId: state.getSessions()[0]?.id ?? null,
	activeSession: state.getSessions()[0] ?? null,
	rightPanelRef: { current: { refreshHistoryPanel: vi.fn() } },
	...overrides,
});

// ============================================================================
// Tests
// ============================================================================

describe('useFileTreeManagement', () => {
	let originalHistory: typeof window.maestro.history | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		// clearAllMocks wipes call history but keeps implementations, so a test
		// that opted into the browser build would leak into the next one.
		vi.mocked(isWebDesktop).mockReturnValue(false);
		useFileExplorerStore.setState({ fileTreeFilter: '' });
		// Most tests assume sessions are loaded (safety timeout can fire)
		useSessionStore.setState({ sessionsLoaded: true });
		originalHistory = window.maestro.history as typeof window.maestro.history | undefined;
		window.maestro = {
			...window.maestro,
			history: {
				reload: vi.fn().mockResolvedValue(true),
			},
		};
	});

	afterEach(() => {
		delete (window as unknown as Record<string, unknown>).__MAESTRO_BRIDGE_STATE__;
		useSessionStore.setState({ sessionsLoaded: false, initialFileTreeReady: false });
		if (originalHistory) {
			window.maestro.history = originalHistory;
		} else {
			delete (window.maestro as { history?: unknown }).history;
		}
	});

	it('does not scan while restoring and refreshes the retained tree after recovery', async () => {
		const bridge = window as unknown as Record<string, unknown>;
		bridge.__MAESTRO_BRIDGE_STATE__ = 'restoring';
		const tree: FileNode[] = [{ name: 'retained.txt', type: 'file' }];
		const state = createSessionsState([createMockSession({ fileTree: tree })]);
		vi.mocked(loadFileTree).mockResolvedValue(asResult(tree));
		vi.mocked(compareFileTrees).mockReturnValue({ totalChanges: 0 } as any);
		const { result } = renderHook(() => useFileTreeManagement(createDeps(state)));
		await act(async () => {
			await result.current.refreshFileTree(state.getSessions()[0].id);
		});
		expect(loadFileTree).not.toHaveBeenCalled();
		expect(state.getSessions()[0].fileTree).toBe(tree);
		await act(async () => {
			bridge.__MAESTRO_BRIDGE_STATE__ = 'connected';
			window.dispatchEvent(
				new CustomEvent('maestro:bridge-state', { detail: { state: 'connected' } })
			);
		});
		expect(loadFileTree).toHaveBeenCalledOnce();
	});

	it.each([
		{
			label: 'Load all tree',
			tree: [{ name: 'retained.txt', type: 'file' }] as FileNode[],
			loadedCap: Infinity,
		},
		{ label: 'legacy loaded-empty tree', tree: [] as FileNode[], loadedCap: undefined },
	])(
		'does not queue an initial refresh for a $label during recovery',
		async ({ tree, loadedCap }) => {
			const bridge = window as unknown as Record<string, unknown>;
			bridge.__MAESTRO_BRIDGE_STATE__ = 'restoring';
			const state = createSessionsState([
				createMockSession({
					fileTree: tree,
					fileTreeLoadedCap: loadedCap,
					fileTreeStats: { fileCount: tree.length, folderCount: 0, totalSize: 0 },
				}),
			]);
			vi.mocked(loadFileTree).mockResolvedValue(asResult([]));
			vi.mocked(compareFileTrees).mockReturnValue({ totalChanges: tree.length } as any);
			renderHook(() => useFileTreeManagement(createDeps(state)));
			await act(async () => {
				bridge.__MAESTRO_BRIDGE_STATE__ = 'connected';
				window.dispatchEvent(new CustomEvent(WEB_BRIDGE_STATE_EVENT));
			});
			expect(loadFileTree).not.toHaveBeenCalled();
			expect(state.getSessions()[0].fileTree).toBe(tree);
			expect(state.getSessions()[0].fileTreeLoadedCap).toBe(loadedCap);
		}
	);

	it('preserves a completed empty Load all tree without stats on mount and reconnect', async () => {
		const bridge = window as unknown as Record<string, unknown>;
		bridge.__MAESTRO_BRIDGE_STATE__ = 'connected';
		const state = createSessionsState([
			createMockSession({ fileTree: [], fileTreeLoadedCap: Infinity, fileTreeStats: undefined }),
		]);
		vi.mocked(loadFileTree).mockResolvedValue(asResult([]));
		const { rerender } = renderHook(() => useFileTreeManagement(createDeps(state)));
		await act(async () => {});
		expect(loadFileTree).not.toHaveBeenCalled();
		await act(async () => {
			bridge.__MAESTRO_BRIDGE_STATE__ = 'restoring';
			window.dispatchEvent(new CustomEvent(WEB_BRIDGE_STATE_EVENT));
			rerender();
		});
		await act(async () => {
			bridge.__MAESTRO_BRIDGE_STATE__ = 'connected';
			window.dispatchEvent(new CustomEvent(WEB_BRIDGE_STATE_EVENT));
		});
		expect(loadFileTree).not.toHaveBeenCalled();
		expect(state.getSessions()[0].fileTreeLoadedCap).toBe(Infinity);
	});

	it('queues an unloaded initial tree until the bridge recovers', async () => {
		const bridge = window as unknown as Record<string, unknown>;
		bridge.__MAESTRO_BRIDGE_STATE__ = 'restoring';
		const tree: FileNode[] = [{ name: 'loaded.txt', type: 'file' }];
		const state = createSessionsState([createMockSession()]);
		vi.mocked(loadFileTree).mockResolvedValue(asResult(tree));
		vi.mocked(compareFileTrees).mockReturnValue({ totalChanges: 1 } as any);
		renderHook(() => useFileTreeManagement(createDeps(state)));
		expect(loadFileTree).not.toHaveBeenCalled();
		await act(async () => {
			bridge.__MAESTRO_BRIDGE_STATE__ = 'connected';
			window.dispatchEvent(new CustomEvent(WEB_BRIDGE_STATE_EVENT));
		});
		expect(loadFileTree).toHaveBeenCalledOnce();
		expect(state.getSessions()[0].fileTree).toEqual(tree);
	});

	it.each([false, true])(
		'keeps one recovery read in flight when early stats rerender the real store (explicit Load all: %s)',
		async (explicit) => {
			const bridge = window as unknown as Record<string, unknown>;
			bridge.__MAESTRO_BRIDGE_STATE__ = explicit ? 'connected' : 'restoring';
			const previous = useSessionStore.getState();
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
			const sessionsRef = { current: useSessionStore.getState().sessions };
			const unsubscribe = useSessionStore.subscribe((state) => {
				sessionsRef.current = state.sessions;
			});
			const tree: FileNode[] = [{ name: 'loaded.txt', type: 'file' }];
			let resolveTree: ((value: ReturnType<typeof asResult>) => void) | undefined;
			vi.mocked(compareFileTrees).mockReturnValue({ totalChanges: 1 } as any);
			if (explicit) {
				vi.mocked(loadFileTree).mockImplementationOnce(async () => {
					bridge.__MAESTRO_BRIDGE_STATE__ = 'restoring';
					throw new BridgeTransportError('Disconnected', 'BRIDGE_DISCONNECTED', 'read-only');
				});
				vi.mocked(window.maestro.fs.directorySize).mockResolvedValueOnce({
					fileCount: 1,
					folderCount: 0,
					totalSize: 1,
				});
			}
			vi.mocked(window.maestro.fs.directorySize).mockResolvedValueOnce({
				fileCount: 2,
				folderCount: 0,
				totalSize: 2,
			});
			vi.mocked(loadFileTree).mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveTree = resolve;
					})
			);
			const { result, unmount } = renderHook(() =>
				useFileTreeManagement({
					sessionsRef,
					setSessions: useSessionStore.getState().setSessions,
					activeSessionId: session.id,
					rightPanelRef: { current: null },
				})
			);
			try {
				if (explicit) {
					await act(async () => {});
					await act(async () => {
						await result.current.refreshFileTree(session.id, { maxEntriesOverride: Infinity });
					});
				}
				await act(async () => {
					bridge.__MAESTRO_BRIDGE_STATE__ = 'connected';
					window.dispatchEvent(new CustomEvent(WEB_BRIDGE_STATE_EVENT));
				});
				expect(useSessionStore.getState().sessions[0].fileTreeStats).toBeDefined();
				if (!explicit) expect(useSessionStore.getState().sessions[0].fileTreeLoading).toBe(true);
				expect(loadFileTree).toHaveBeenCalledTimes(explicit ? 2 : 1);
				await act(async () => resolveTree?.(asResult(tree)));
				expect(loadFileTree).toHaveBeenCalledTimes(explicit ? 2 : 1);
				expect(useSessionStore.getState().sessions[0].fileTree).toEqual(tree);
				expect(useSessionStore.getState().sessions[0].fileTreeLoadedCap).toBe(
					explicit ? Infinity : 100_000
				);
				expect(useSessionStore.getState().sessions[0].fileTreeLoading).toBe(false);
			} finally {
				unmount();
				unsubscribe();
				useSessionStore.setState({
					sessions: previous.sessions,
					activeSessionId: previous.activeSessionId,
				});
			}
		}
	);

	it.each([
		{ label: 'initial request only', explicit: false, options: undefined },
		{ label: 'explicit default refresh', explicit: true, options: undefined },
		{ label: 'explicit Load all', explicit: true, options: { maxEntriesOverride: Infinity } },
	])(
		'rechecks a queued $label after authoritative tree hydration',
		async ({ explicit, options }) => {
			const bridge = window as unknown as Record<string, unknown>;
			bridge.__MAESTRO_BRIDGE_STATE__ = 'restoring';
			const tree: FileNode[] = [{ name: 'hydrated.txt', type: 'file' }];
			const state = createSessionsState([createMockSession()]);
			vi.mocked(loadFileTree).mockResolvedValue(asResult(tree));
			vi.mocked(compareFileTrees).mockReturnValue({ totalChanges: 0 } as any);
			const { result, rerender } = renderHook(() => useFileTreeManagement(createDeps(state)));
			await act(async () => {
				if (explicit) await result.current.refreshFileTree(state.getSessions()[0].id, options);
				state.setSessions((sessions) =>
					sessions.map((session) => ({
						...session,
						fileTree: tree,
						fileTreeLoadedCap: Infinity,
						fileTreeStats: { fileCount: 1, folderCount: 0, totalSize: 1 },
					}))
				);
				rerender();
			});
			await act(async () => {
				bridge.__MAESTRO_BRIDGE_STATE__ = 'connected';
				window.dispatchEvent(new CustomEvent(WEB_BRIDGE_STATE_EVENT));
			});
			expect(loadFileTree).toHaveBeenCalledTimes(explicit ? 1 : 0);
			expect(state.getSessions()[0].fileTreeLoadedCap).toBe(
				explicit ? (options?.maxEntriesOverride ?? 100_000) : Infinity
			);
		}
	);

	it.each(['before', 'after'])(
		'does not replay a connected initial timeout after its timed retry and a later Load all (stats resolve %s the timeout)',
		async (statsTiming) => {
			vi.useFakeTimers();
			const bridge = window as unknown as Record<string, unknown>;
			bridge.__MAESTRO_BRIDGE_STATE__ = 'connected';
			const tree: FileNode[] = [{ name: 'loaded.txt', type: 'file' }];
			const state = createSessionsState([createMockSession()]);
			const error = new BridgeTransportError('Read timed out', 'BRIDGE_TIMEOUT', 'read-only');
			vi.mocked(loadFileTree).mockRejectedValueOnce(error).mockResolvedValue(asResult(tree));
			const stats = { fileCount: 1, folderCount: 0, totalSize: 1 };
			let resolveStats: ((value: typeof stats) => void) | undefined;
			vi.mocked(window.maestro.fs.directorySize).mockImplementationOnce(() =>
				statsTiming === 'before'
					? Promise.resolve(stats)
					: new Promise((resolve) => {
							resolveStats = resolve;
						})
			);
			vi.mocked(compareFileTrees).mockReturnValue({ totalChanges: 0 } as any);
			const { result, rerender, unmount } = renderHook(() =>
				useFileTreeManagement(createDeps(state))
			);
			try {
				await act(async () => {});
				await act(async () => resolveStats?.(stats));
				expect(loadFileTree).toHaveBeenCalledOnce();
				expect(state.getSessions()[0].fileTreeStats).toEqual(stats);
				expect(state.getSessions()[0].fileTreeRetryAt).toBe(Date.now() + 20_000);
				rerender();
				await act(async () => vi.advanceTimersByTime(19_999));
				expect(loadFileTree).toHaveBeenCalledOnce();
				await act(async () => vi.advanceTimersByTime(1));
				await act(async () => rerender());
				expect(loadFileTree).toHaveBeenCalledTimes(2);
				expect(state.getSessions()[0].fileTreeRetryAt).toBeUndefined();
				await act(async () => {
					await result.current.refreshFileTree(state.getSessions()[0].id, {
						maxEntriesOverride: Infinity,
					});
				});
				expect(loadFileTree).toHaveBeenCalledTimes(3);
				expect(state.getSessions()[0].fileTreeLoadedCap).toBe(Infinity);
				await act(async () => {
					bridge.__MAESTRO_BRIDGE_STATE__ = 'restoring';
					window.dispatchEvent(new CustomEvent(WEB_BRIDGE_STATE_EVENT));
					bridge.__MAESTRO_BRIDGE_STATE__ = 'connected';
					window.dispatchEvent(new CustomEvent(WEB_BRIDGE_STATE_EVENT));
				});
				expect(loadFileTree).toHaveBeenCalledTimes(3);
				expect(state.getSessions()[0].fileTreeLoadedCap).toBe(Infinity);
			} finally {
				unmount();
				vi.useRealTimers();
			}
		}
	);

	it('resumes the full SSH load after a partial tree and successful stats arrive before disconnection', async () => {
		const bridge = window as unknown as Record<string, unknown>;
		bridge.__MAESTRO_BRIDGE_STATE__ = 'connected';
		const partialTree: FileNode[] = [{ name: 'partial.txt', type: 'file' }];
		const fullTree: FileNode[] = [...partialTree, { name: 'completed.txt', type: 'file' }];
		const state = createSessionsState([createMockSession({ sshRemoteId: 'ssh-1' })]);
		let rejectFullLoad: ((error: Error) => void) | undefined;
		vi.mocked(loadFileTree).mockResolvedValueOnce(asResult(partialTree));
		vi.mocked(loadFileTreeRemoteBatched)
			.mockImplementationOnce(
				() =>
					new Promise((_, reject) => {
						rejectFullLoad = reject;
					})
			)
			.mockResolvedValue(asResult(fullTree));
		vi.mocked(compareFileTrees).mockReturnValue({ totalChanges: 1 } as any);
		const { rerender } = renderHook(() => useFileTreeManagement(createDeps(state)));
		await act(async () => {});
		expect(state.getSessions()[0].fileTree).toEqual(partialTree);
		expect(state.getSessions()[0].fileTreeStats).toBeDefined();
		expect(state.getSessions()[0].fileTreeLoadedCap).toBeUndefined();
		await act(async () => {
			bridge.__MAESTRO_BRIDGE_STATE__ = 'restoring';
			rejectFullLoad?.(
				new BridgeTransportError('Disconnected', 'BRIDGE_DISCONNECTED', 'read-only')
			);
		});
		rerender();
		await act(async () => {
			bridge.__MAESTRO_BRIDGE_STATE__ = 'connected';
			window.dispatchEvent(new CustomEvent(WEB_BRIDGE_STATE_EVENT));
		});
		expect(loadFileTreeRemoteBatched).toHaveBeenCalledTimes(2);
		expect(state.getSessions()[0].fileTree).toEqual(fullTree);
		expect(state.getSessions()[0].fileTreeLoadedCap).toBe(100_000);
	});

	it('defers inactive initial trees until selection instead of scanning all visited agents on reconnect', async () => {
		const bridge = window as unknown as Record<string, unknown>;
		bridge.__MAESTRO_BRIDGE_STATE__ = 'restoring';
		const tree: FileNode[] = [{ name: 'loaded.txt', type: 'file' }];
		const state = createSessionsState([
			createMockSession({ id: 'first' }),
			createMockSession({ id: 'second' }),
		]);
		vi.mocked(loadFileTree).mockResolvedValue(asResult(tree));
		vi.mocked(compareFileTrees).mockReturnValue({ totalChanges: 1 } as any);
		const { rerender } = renderHook(
			({ activeId }) =>
				useFileTreeManagement(
					createDeps(state, {
						activeSessionId: activeId,
						activeSession: state.getSessions().find((session) => session.id === activeId),
					})
				),
			{ initialProps: { activeId: 'first' } }
		);
		rerender({ activeId: 'second' });
		await act(async () => {
			bridge.__MAESTRO_BRIDGE_STATE__ = 'connected';
			window.dispatchEvent(new CustomEvent(WEB_BRIDGE_STATE_EVENT));
		});
		expect(loadFileTree).toHaveBeenCalledOnce();
		expect(state.getSessions()[0].fileTree).toEqual([]);
		expect(state.getSessions()[1].fileTree).toEqual(tree);
		await act(async () => rerender({ activeId: 'first' }));
		expect(loadFileTree).toHaveBeenCalledTimes(2);
		expect(state.getSessions()[0].fileTree).toEqual(tree);
	});

	it.each([false, true])(
		'cancels initial-only queued work while retaining an explicit refresh: %s',
		async (explicit) => {
			const bridge = window as unknown as Record<string, unknown>;
			bridge.__MAESTRO_BRIDGE_STATE__ = 'restoring';
			const state = createSessionsState([createMockSession()]);
			vi.mocked(loadFileTree).mockResolvedValue(asResult([]));
			vi.mocked(compareFileTrees).mockReturnValue({ totalChanges: 0 } as any);
			const { result } = renderHook(() => useFileTreeManagement(createDeps(state)));
			await act(async () => {
				if (explicit)
					await result.current.refreshFileTree(state.getSessions()[0].id, {
						maxEntriesOverride: Infinity,
					});
				result.current.cancelFileTreeLoad(state.getSessions()[0].id);
				bridge.__MAESTRO_BRIDGE_STATE__ = 'connected';
				window.dispatchEvent(new CustomEvent(WEB_BRIDGE_STATE_EVENT));
			});
			expect(loadFileTree).toHaveBeenCalledTimes(explicit ? 1 : 0);
			if (explicit) expect(state.getSessions()[0].fileTreeLoadedCap).toBe(Infinity);
		}
	);

	it.each([200_000, Infinity])(
		'keeps the requested entry cap %s when polling also queues a refresh during recovery',
		async (maxEntriesOverride) => {
			const bridge = window as unknown as Record<string, unknown>;
			bridge.__MAESTRO_BRIDGE_STATE__ = 'restoring';
			const tree: FileNode[] = [{ name: 'retained.txt', type: 'file' }];
			const state = createSessionsState([createMockSession({ fileTree: tree })]);
			vi.mocked(loadFileTree).mockResolvedValue(asResult(tree));
			vi.mocked(compareFileTrees).mockReturnValue({ totalChanges: 0 } as any);
			const { result } = renderHook(() =>
				useFileTreeManagement(createDeps(state, { activeSession: null, activeSessionId: null }))
			);
			const sessionId = state.getSessions()[0].id;
			await act(async () => {
				await result.current.refreshFileTree(sessionId, { maxEntriesOverride, skipStats: true });
				await result.current.refreshFileTree(sessionId);
				await result.current.refreshFileTree(sessionId, { maxEntriesOverride: 150_000 });
			});
			expect(loadFileTree).not.toHaveBeenCalled();
			await act(async () => {
				bridge.__MAESTRO_BRIDGE_STATE__ = 'connected';
				window.dispatchEvent(new CustomEvent('maestro:bridge-state'));
			});
			expect(loadFileTree).toHaveBeenCalledOnce();
			expect(vi.mocked(loadFileTree).mock.calls[0][6]).toBe(maxEntriesOverride);
			expect(state.getSessions()[0].fileTreeLoadedCap).toBe(maxEntriesOverride);
			// A coalesced normal refresh still requires its directory stats.
			expect(window.maestro.fs.directorySize).toHaveBeenCalledOnce();
		}
	);

	it('preserves refresh options when a reconnect interrupts an in-flight load', async () => {
		const bridge = window as unknown as Record<string, unknown>;
		bridge.__MAESTRO_BRIDGE_STATE__ = 'connected';
		const tree: FileNode[] = [{ name: 'retained.txt', type: 'file' }];
		const state = createSessionsState([createMockSession({ fileTree: tree })]);
		vi.mocked(loadFileTree)
			.mockImplementationOnce(async () => {
				bridge.__MAESTRO_BRIDGE_STATE__ = 'restoring';
				throw new BridgeTransportError('Reconnecting', 'BRIDGE_RECONNECTING');
			})
			.mockResolvedValue(asResult(tree));
		vi.mocked(compareFileTrees).mockReturnValue({ totalChanges: 0 } as any);
		const { result } = renderHook(() =>
			useFileTreeManagement(createDeps(state, { activeSession: null, activeSessionId: null }))
		);
		await act(async () => {
			await result.current.refreshFileTree(state.getSessions()[0].id, {
				maxEntriesOverride: Infinity,
				skipStats: true,
			});
		});
		await act(async () => {
			bridge.__MAESTRO_BRIDGE_STATE__ = 'connected';
			window.dispatchEvent(new CustomEvent('maestro:bridge-state'));
		});
		expect(loadFileTree).toHaveBeenCalledTimes(2);
		expect(vi.mocked(loadFileTree).mock.calls[1][6]).toBe(Infinity);
		expect(window.maestro.fs.directorySize).not.toHaveBeenCalled();
	});

	it('retains the working tree and avoids error logs for a reconnect racing a refresh', async () => {
		const tree: FileNode[] = [{ name: 'retained.txt', type: 'file' }];
		const state = createSessionsState([createMockSession({ fileTree: tree })]);
		vi.mocked(loadFileTree).mockImplementation(async () => {
			(window as unknown as Record<string, unknown>).__MAESTRO_BRIDGE_STATE__ = 'restoring';
			throw new Error(
				'Not submitted: restoring authoritative host state. Your current work is retained.'
			);
		});
		const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
		const { result } = renderHook(() => useFileTreeManagement(createDeps(state)));
		await act(async () => {
			await result.current.refreshFileTree(state.getSessions()[0].id);
		});
		expect(state.getSessions()[0].fileTree).toBe(tree);
		expect(state.getSessions()[0].fileTreeError).toBeUndefined();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it('surfaces a read timeout while connected instead of waiting for a reconnect event', async () => {
		(window as unknown as Record<string, unknown>).__MAESTRO_BRIDGE_STATE__ = 'connected';
		const state = createSessionsState([createMockSession({ fileTree: [] })]);
		const error = new BridgeTransportError(
			'Bridge request timed out: fs:readDir',
			'BRIDGE_TIMEOUT',
			'read-only',
			'fs:readDir'
		);
		vi.mocked(loadFileTree).mockRejectedValue(error);
		const { result } = renderHook(() =>
			useFileTreeManagement(createDeps(state, { activeSession: null, activeSessionId: null }))
		);
		await act(async () => {
			await result.current.refreshFileTree(state.getSessions()[0].id);
		});
		expect(state.getSessions()[0].fileTreeError).toContain(error.message);
		expect(state.getSessions()[0].fileTree).toEqual([]);
	});

	it('refreshFileTree updates tree and returns changes', async () => {
		const initialTree: FileNode[] = [{ name: 'old.txt', type: 'file' }];
		const nextTree: FileNode[] = [{ name: 'new.txt', type: 'file' }];
		const changes = {
			totalChanges: 1,
			newFiles: 1,
			newFolders: 0,
			removedFiles: 0,
			removedFolders: 0,
		};

		vi.mocked(loadFileTree).mockResolvedValue(asResult(nextTree));
		vi.mocked(compareFileTrees).mockReturnValue(changes);

		const state = createSessionsState([createMockSession({ fileTree: initialTree })]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		let returnedChanges: typeof changes | undefined;
		await act(async () => {
			returnedChanges = await result.current.refreshFileTree(state.getSessions()[0].id);
		});

		// For local sessions (no sshRemoteId), sshContext and localOptions are undefined.
		// loadFullTree always forwards an 8th `signal` arg (undefined when caller omits extras).
		expect(loadFileTree).toHaveBeenCalledWith(
			'/test/project',
			5,
			0,
			undefined,
			undefined,
			undefined,
			100_000,
			undefined
		);
		expect(compareFileTrees).toHaveBeenCalledWith(initialTree, nextTree);
		expect(returnedChanges).toEqual(changes);
		expect(state.getSessions()[0].fileTree).toEqual(nextTree);
		expect(state.getSessions()[0].fileTreeError).toBeUndefined();
	});

	describe('refreshFileTree fileTree identity (#1180)', () => {
		it('preserves the existing fileTree reference when a refresh reports no structural changes', async () => {
			const existingTree: FileNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [{ name: 'index.ts', type: 'file' }],
				},
			];
			const reloadedTree: FileNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [{ name: 'index.ts', type: 'file' }],
				},
			];
			const noChanges = {
				totalChanges: 0,
				newFiles: 0,
				newFolders: 0,
				removedFiles: 0,
				removedFolders: 0,
			};

			vi.mocked(loadFileTree).mockResolvedValue(asResult(reloadedTree));
			vi.mocked(compareFileTrees).mockReturnValue(noChanges);

			const session = createMockSession({
				fileTree: existingTree,
				fileTreeStats: {
					fileCount: 1,
					folderCount: 1,
					totalSize: 128,
				},
			});
			const state = createSessionsState([session]);
			const deps = createDeps(state);
			const { result } = renderHook(() => useFileTreeManagement(deps));

			let returnedChanges: typeof noChanges | undefined;
			await act(async () => {
				returnedChanges = await result.current.refreshFileTree(session.id);
			});

			expect(compareFileTrees).toHaveBeenCalledWith(existingTree, reloadedTree);
			expect(returnedChanges).toEqual(noChanges);
			expect(state.getSessions()[0].fileTree).toBe(existingTree);
			expect(state.getSessions()[0].fileTree).not.toBe(reloadedTree);
		});

		it('replaces the fileTree reference when a refresh reports structural changes', async () => {
			const existingTree: FileNode[] = [{ name: 'old.txt', type: 'file' }];
			const reloadedTree: FileNode[] = [
				{ name: 'old.txt', type: 'file' },
				{ name: 'new.txt', type: 'file' },
			];
			const changes = {
				totalChanges: 2,
				newFiles: 1,
				newFolders: 0,
				removedFiles: 1,
				removedFolders: 0,
			};

			vi.mocked(loadFileTree).mockResolvedValue(asResult(reloadedTree));
			vi.mocked(compareFileTrees).mockReturnValue(changes);

			const session = createMockSession({
				fileTree: existingTree,
				fileTreeStats: {
					fileCount: 1,
					folderCount: 0,
					totalSize: 64,
				},
			});
			const state = createSessionsState([session]);
			const deps = createDeps(state);
			const { result } = renderHook(() => useFileTreeManagement(deps));

			let returnedChanges: typeof changes | undefined;
			await act(async () => {
				returnedChanges = await result.current.refreshFileTree(session.id);
			});

			expect(compareFileTrees).toHaveBeenCalledWith(existingTree, reloadedTree);
			expect(returnedChanges).toEqual(changes);
			expect(state.getSessions()[0].fileTree).toBe(reloadedTree);
			expect(state.getSessions()[0].fileTree).not.toBe(existingTree);
		});
	});

	describe('opening a folder the depth cap cut off', () => {
		const cappedTree: FileNode[] = [
			{ name: 'a', type: 'folder', children: [{ name: 'b', type: 'folder', children: [] }] },
		];
		const stats = { fileCount: 0, folderCount: 2, totalSize: 0 };

		const renderWithExpansion = (maxDepth: number) => {
			vi.mocked(loadFileTree).mockResolvedValue(asResult(cappedTree));
			vi.mocked(compareFileTrees).mockReturnValue({
				totalChanges: 0,
				newFiles: 0,
				newFolders: 0,
				removedFiles: 0,
				removedFolders: 0,
			});
			const state = createSessionsState([
				createMockSession({ fileTree: cappedTree, fileTreeStats: stats, fileExplorerExpanded: [] }),
			]);
			const { rerender } = renderHook(
				(deps: UseFileTreeManagementDeps) => useFileTreeManagement(deps),
				{
					initialProps: createDeps(state, { fileExplorerMaxDepth: maxDepth }),
				}
			);
			const expand = (paths: string[]) => {
				state.setSessions((prev) => prev.map((s) => ({ ...s, fileExplorerExpanded: paths })));
				rerender(createDeps(state, { fileExplorerMaxDepth: maxDepth }));
			};
			return { expand };
		};

		it('rescans with the expanded folders and skips the stats scan', async () => {
			const { expand } = renderWithExpansion(2);
			vi.mocked(window.maestro.fs.directorySize).mockClear();

			await act(async () => {
				expand(['a', 'a/b']);
			});

			await waitFor(() => {
				expect(loadFileTree).toHaveBeenCalledWith(
					'/test/project',
					2,
					0,
					undefined,
					undefined,
					{ expandedPaths: ['a', 'a/b'] },
					100_000,
					undefined
				);
			});
			expect(window.maestro.fs.directorySize).not.toHaveBeenCalled();
		});

		it('does not rescan when the opened folder is above the cap', async () => {
			const { expand } = renderWithExpansion(5);

			await act(async () => {
				expand(['a', 'a/b']);
			});

			expect(loadFileTree).not.toHaveBeenCalled();
		});
	});

	it('refreshFileTree handles load errors', async () => {
		vi.mocked(loadFileTree).mockRejectedValue(new Error('boom'));

		const state = createSessionsState([
			createMockSession({ fileTree: [{ name: 'keep', type: 'file' }] }),
		]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		let returnedChanges: unknown;
		await act(async () => {
			returnedChanges = await result.current.refreshFileTree(state.getSessions()[0].id);
		});

		expect(returnedChanges).toBeUndefined();
		// Refresh errors preserve the existing file tree (transient failures shouldn't wipe data)
		expect(state.getSessions()[0].fileTree).toEqual([{ name: 'keep', type: 'file' }]);
	});

	it('refreshGitFileState refreshes git metadata and history', async () => {
		const nextTree: FileNode[] = [{ name: 'src', type: 'folder', children: [] }];

		vi.mocked(loadFileTree).mockResolvedValue(asResult(nextTree));
		// This asserts the tree is REPLACED, so it has to say so: clearAllMocks keeps
		// implementations, and the #1180 identity guard preserves the old reference
		// whenever compareFileTrees reports no changes. Inheriting a previous test's
		// zeroed mock is what made this pass or fail on test order.
		vi.mocked(compareFileTrees).mockReturnValue({
			totalChanges: 1,
			newFiles: 1,
			newFolders: 0,
			removedFiles: 0,
			removedFolders: 0,
		});
		vi.mocked(gitService.isRepo).mockResolvedValue(true);
		vi.mocked(gitService.getBranches).mockResolvedValue(['main']);
		vi.mocked(gitService.getTags).mockResolvedValue(['v1.0.0']);

		const session = createMockSession({
			inputMode: 'terminal',
			shellCwd: '/test/shell',
			fileTree: [{ name: 'existing', type: 'file' }],
		});
		const state = createSessionsState([session]);
		const rightPanelRef: RefObject<RightPanelHandle | null> = {
			current: { refreshHistoryPanel: vi.fn() },
		};
		const deps = createDeps(state, { rightPanelRef });
		const { result } = renderHook(() => useFileTreeManagement(deps));

		await act(async () => {
			await result.current.refreshGitFileState(session.id);
		});

		// loadFileTree always uses projectRoot (treeRoot), not shellCwd.
		// Git operations use shellCwd when inputMode is 'terminal'.
		// loadFullTree always forwards an 8th `signal` arg (undefined when caller omits extras).
		expect(loadFileTree).toHaveBeenCalledWith(
			'/test/project',
			5,
			0,
			undefined,
			undefined,
			undefined,
			100_000,
			undefined
		);
		expect(gitService.isRepo).toHaveBeenCalledWith('/test/shell', undefined);
		expect(gitService.getBranches).toHaveBeenCalledWith('/test/shell', undefined);
		expect(gitService.getTags).toHaveBeenCalledWith('/test/shell', undefined);
		expect(window.maestro.history.reload).toHaveBeenCalled();
		expect(rightPanelRef.current?.refreshHistoryPanel).toHaveBeenCalled();

		const updated = state.getSessions()[0];
		expect(updated.fileTree).toEqual(nextTree);
		expect(updated.isGitRepo).toBe(true);
		expect(updated.gitBranches).toEqual(['main']);
		expect(updated.gitTags).toEqual(['v1.0.0']);
		expect(updated.gitRefsCacheTime).toEqual(expect.any(Number));
	});

	it('filters file tree by fuzzy match and keeps matching folders', () => {
		const fileTree: FileNode[] = [
			{
				name: 'docs',
				type: 'folder',
				children: [
					{ name: 'readme.md', type: 'file' },
					{ name: 'guide.txt', type: 'file' },
				],
			},
			{
				name: 'src',
				type: 'folder',
				children: [{ name: 'index.ts', type: 'file' }],
			},
			{ name: 'notes.txt', type: 'file' },
		];

		useFileExplorerStore.setState({ fileTreeFilter: 'read' });
		const state = createSessionsState([createMockSession({ fileTree })]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		expect(result.current.filteredFileTree).toEqual([
			{
				name: 'docs',
				type: 'folder',
				children: [{ name: 'readme.md', type: 'file' }],
			},
		]);
	});

	it('loads file tree on mount when active session tree is empty', async () => {
		const nextTree: FileNode[] = [{ name: 'loaded.txt', type: 'file' }];

		vi.mocked(loadFileTree).mockResolvedValue(asResult(nextTree));

		const state = createSessionsState([createMockSession({ fileTree: [] })]);
		const deps = createDeps(state);
		renderHook(() => useFileTreeManagement(deps));

		await waitFor(() => {
			// loadFileTree is called with (path, maxDepth, currentDepth, sshContext, onProgress, localOptions, maxEntries, signal)
			expect(loadFileTree).toHaveBeenCalledWith(
				'/test/project',
				5,
				0,
				undefined,
				expect.any(Function),
				undefined,
				100_000,
				expect.any(AbortSignal)
			);
			expect(state.getSessions()[0].fileTree).toEqual(nextTree);
		});
	});

	it('routes SSH refresh through the batched find loader', async () => {
		const nextTree: FileNode[] = [{ name: 'remote-file.txt', type: 'file' }];
		const changes = {
			totalChanges: 0,
			newFiles: 0,
			newFolders: 0,
			removedFiles: 0,
			removedFolders: 0,
		};

		vi.mocked(loadFileTree).mockResolvedValue(asResult(nextTree));
		vi.mocked(loadFileTreeRemoteBatched).mockResolvedValue(asResult(nextTree));
		vi.mocked(compareFileTrees).mockReturnValue(changes);

		// Create session with SSH context
		const sshSession = createMockSession({
			fileTree: [],
			sshRemoteId: 'my-ssh-remote',
			remoteCwd: '/remote/project',
		});
		const state = createSessionsState([sshSession]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		// The initial-load effect fires a shallow loadFileTree pass for SSH on mount.
		// That's tested separately ("fires shallow load before batched full load …");
		// here we only care about what the *refresh* path dispatches.
		vi.mocked(loadFileTree).mockClear();
		vi.mocked(loadFileTreeRemoteBatched).mockClear();

		await act(async () => {
			await result.current.refreshFileTree(sshSession.id);
		});

		// Verify SSH refresh dispatches to the batched loader (not recursive readDir)
		expect(loadFileTreeRemoteBatched).toHaveBeenCalledWith(
			'/test/project',
			expect.objectContaining({
				maxDepth: 5,
				maxEntries: 100_000,
				sshRemoteId: 'my-ssh-remote',
			})
		);
		// Recursive loadFileTree must NOT be called for SSH refreshes - the whole
		// point of the batched loader is to skip the per-directory round-trips.
		expect(loadFileTree).not.toHaveBeenCalled();
	});

	it('fires shallow load before batched full load for SSH sessions on initial mount', async () => {
		const shallowTree: FileNode[] = [
			{ name: 'src', type: 'folder', children: [] },
			{ name: 'README.md', type: 'file' },
		];
		const fullTree: FileNode[] = [
			{
				name: 'src',
				type: 'folder',
				children: [{ name: 'index.ts', type: 'file' }],
			},
			{ name: 'README.md', type: 'file' },
		];

		// Shallow pass goes through loadFileTree (depth=1, single readDir round-trip).
		vi.mocked(loadFileTree).mockResolvedValueOnce(asResult(shallowTree));
		// Full pass goes through the batched find-based loader.
		vi.mocked(loadFileTreeRemoteBatched).mockResolvedValueOnce(asResult(fullTree));

		const mockDirectorySize = vi.fn().mockResolvedValue({
			fileCount: 2,
			folderCount: 1,
			totalSize: 1000,
		});

		const originalFs = window.maestro?.fs;
		window.maestro = {
			...window.maestro,
			fs: {
				...originalFs,
				directorySize: mockDirectorySize,
			},
		};

		const sshSession = createMockSession({
			fileTree: [],
			sshRemoteId: 'my-ssh-remote',
			remoteCwd: '/remote/project',
		});
		const state = createSessionsState([sshSession]);
		const deps = createDeps(state);

		renderHook(() => useFileTreeManagement(deps));

		await waitFor(() => {
			// Shallow load: depth=1, no entry cap, recursive readDir path.
			expect(loadFileTree).toHaveBeenCalledWith(
				'/test/project',
				1,
				0,
				expect.objectContaining({ sshRemoteId: 'my-ssh-remote' }),
				undefined,
				undefined,
				Number.POSITIVE_INFINITY,
				expect.any(AbortSignal)
			);
			// Full load: dispatched to batched find-based loader.
			expect(loadFileTreeRemoteBatched).toHaveBeenCalledWith(
				'/test/project',
				expect.objectContaining({
					maxDepth: 5,
					maxEntries: 100_000,
					sshRemoteId: 'my-ssh-remote',
					signal: expect.any(AbortSignal),
				})
			);
		});

		// After both complete, final tree should be the full tree
		await waitFor(() => {
			expect(state.getSessions()[0].fileTree).toEqual(fullTree);
			expect(state.getSessions()[0].fileTreeLoading).toBe(false);
		});

		if (originalFs) {
			window.maestro.fs = originalFs;
		}
	});

	it('does not fire shallow load for local sessions on initial mount', async () => {
		const fullTree: FileNode[] = [{ name: 'loaded.txt', type: 'file' }];
		vi.mocked(loadFileTree).mockResolvedValue(asResult(fullTree));

		const state = createSessionsState([createMockSession({ fileTree: [] })]);
		const deps = createDeps(state);

		renderHook(() => useFileTreeManagement(deps));

		await waitFor(() => {
			expect(state.getSessions()[0].fileTree).toEqual(fullTree);
		});

		// loadFileTree should only be called once (full load, no shallow pass)
		expect(loadFileTree).toHaveBeenCalledTimes(1);
		expect(loadFileTree).toHaveBeenCalledWith(
			'/test/project',
			5,
			0,
			undefined,
			expect.any(Function), // onProgress
			undefined,
			100_000,
			expect.any(AbortSignal)
		);
	});

	it('clears the spinner when a refresh overtakes an in-flight initial load', async () => {
		// The initial load owns the spinner. A refresh bumps the load sequence and
		// orphans it, so the refresh has to put the spinner down itself.
		let resolveInitial: (value: ReturnType<typeof asResult>) => void = () => {};
		const pendingInitial = new Promise<ReturnType<typeof asResult>>((resolve) => {
			resolveInitial = resolve;
		});
		const refreshedTree: FileNode[] = [{ name: 'fresh.txt', type: 'file' }];
		vi.mocked(loadFileTree)
			.mockReturnValueOnce(pendingInitial)
			.mockResolvedValue(asResult(refreshedTree));
		vi.mocked(compareFileTrees).mockReturnValue({ added: [], removed: [], modified: [] });

		const state = createSessionsState([createMockSession({ fileTree: [] })]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		await waitFor(() => {
			expect(state.getSessions()[0].fileTreeLoading).toBe(true);
		});

		await act(async () => {
			await result.current.refreshFileTree(state.getSessions()[0].id);
		});

		expect(state.getSessions()[0].fileTree).toEqual(refreshedTree);
		expect(state.getSessions()[0].fileTreeLoading).toBe(false);
		expect(state.getSessions()[0].fileTreeLoadingProgress).toBeUndefined();

		// The orphaned initial load settling afterwards must not resurrect the spinner.
		await act(async () => {
			resolveInitial(asResult([{ name: 'stale.txt', type: 'file' }]));
			await Promise.resolve();
		});
		expect(state.getSessions()[0].fileTree).toEqual(refreshedTree);
		expect(state.getSessions()[0].fileTreeLoading).toBe(false);
	});

	it('discards a scan that finishes after the agent moved to another directory', async () => {
		// The move (withWorkingDirectory) clears the tree and puts the spinner
		// down. If the scan it orphaned resolves BEFORE the auto-loader gets to
		// start a fresh one, it is not yet stale by sequence number - so the
		// writes must check the root instead, or the old project's tree and
		// stats land on the relocated agent (and the stats then block a reload).
		let resolveLoad: (value: ReturnType<typeof asResult>) => void = () => {};
		const pending = new Promise<ReturnType<typeof asResult>>((resolve) => {
			resolveLoad = resolve;
		});
		vi.mocked(loadFileTree).mockReturnValue(pending);
		let resolveStats: (value: {
			fileCount: number;
			folderCount: number;
			totalSize: number;
		}) => void = () => {};
		vi.mocked(window.maestro.fs.directorySize).mockReturnValue(
			new Promise((resolve) => {
				resolveStats = resolve;
			})
		);

		const state = createSessionsState([
			createMockSession({ fileTree: [], cwd: '/projects/old', projectRoot: '/projects/old' }),
		]);
		const deps = createDeps(state);
		renderHook(() => useFileTreeManagement(deps));

		await waitFor(() => {
			expect(state.getSessions()[0].fileTreeLoading).toBe(true);
		});

		// Relocate without re-rendering the hook: no new load has started yet.
		state.setSessions((prev) => prev.map((s) => withWorkingDirectory(s, '/projects/new')));

		await act(async () => {
			resolveLoad(asResult([{ name: 'old-project.txt', type: 'file' }]));
			resolveStats({ fileCount: 1, folderCount: 0, totalSize: 10 });
			await Promise.resolve();
		});

		const moved = state.getSessions()[0];
		expect(moved.projectRoot).toBe('/projects/new');
		expect(moved.fileTree).toEqual([]);
		expect(moved.fileTreeStats).toBeUndefined();
		expect(moved.fileTreeLoading).toBe(false);
	});

	it('does not schedule a retry on the new directory when the old scan fails after a move', async () => {
		let rejectLoad: (reason: Error) => void = () => {};
		const pending = new Promise<ReturnType<typeof asResult>>((_resolve, reject) => {
			rejectLoad = reject;
		});
		vi.mocked(loadFileTree).mockReturnValue(pending);

		const state = createSessionsState([
			createMockSession({ fileTree: [], cwd: '/projects/old', projectRoot: '/projects/old' }),
		]);
		const deps = createDeps(state);
		renderHook(() => useFileTreeManagement(deps));

		await waitFor(() => {
			expect(state.getSessions()[0].fileTreeLoading).toBe(true);
		});

		state.setSessions((prev) => prev.map((s) => withWorkingDirectory(s, '/projects/new')));

		await act(async () => {
			rejectLoad(new Error('EACCES'));
			await Promise.resolve();
		});

		const moved = state.getSessions()[0];
		expect(moved.fileTreeError).toBeUndefined();
		expect(moved.fileTreeRetryAt).toBeUndefined();
		expect(moved.fileTreeLoading).toBe(false);
	});

	it('cancelFileTreeLoad aborts the in-flight load signal and clears loading state', async () => {
		// Hold the load open so we can cancel while it's pending.
		let resolveLoad: (value: ReturnType<typeof asResult>) => void = () => {};
		const pending = new Promise<ReturnType<typeof asResult>>((resolve) => {
			resolveLoad = resolve;
		});
		vi.mocked(loadFileTree).mockReturnValue(pending);

		const state = createSessionsState([createMockSession({ fileTree: [] })]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		// Wait until the auto-load effect has kicked off and marked the session as loading.
		await waitFor(() => {
			expect(state.getSessions()[0].fileTreeLoading).toBe(true);
			expect(loadFileTree).toHaveBeenCalled();
		});

		// Grab the AbortSignal passed into loadFileTree and confirm it starts unaborted.
		const callArgs = vi.mocked(loadFileTree).mock.calls[0];
		const signal = callArgs[callArgs.length - 1] as AbortSignal;
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal.aborted).toBe(false);

		// Cancel and verify the signal aborted and the UI state was cleared.
		await act(async () => {
			result.current.cancelFileTreeLoad(state.getSessions()[0].id);
		});

		expect(signal.aborted).toBe(true);
		expect(state.getSessions()[0].fileTreeLoading).toBe(false);
		expect(state.getSessions()[0].fileTreeLoadingProgress).toBeUndefined();

		// Resolve the pending load so the promise machinery settles cleanly.
		resolveLoad(asResult([]));
	});

	it('cancels an unfinished tree load when the active session changes (web-desktop)', async () => {
		asWebDesktop();
		let resolveFirst: (value: ReturnType<typeof asResult>) => void = () => {};
		let resolveSecond: (value: ReturnType<typeof asResult>) => void = () => {};
		const firstPending = new Promise<ReturnType<typeof asResult>>((resolve) => {
			resolveFirst = resolve;
		});
		const secondPending = new Promise<ReturnType<typeof asResult>>((resolve) => {
			resolveSecond = resolve;
		});
		vi.mocked(loadFileTree).mockReturnValueOnce(firstPending).mockReturnValueOnce(secondPending);

		const firstSession = createMockSession({ id: 'session-a', fileTree: [] });
		const secondSession = createMockSession({ id: 'session-b', fileTree: [] });
		const state = createSessionsState([firstSession, secondSession]);
		const baseDeps = createDeps(state);
		const { rerender } = renderHook(
			({ activeSessionId, activeSession }: { activeSessionId: string; activeSession: Session }) =>
				useFileTreeManagement({ ...baseDeps, activeSessionId, activeSession }),
			{
				initialProps: { activeSessionId: firstSession.id, activeSession: firstSession },
			}
		);

		await waitFor(() => expect(loadFileTree).toHaveBeenCalledTimes(1));
		const firstSignal = vi.mocked(loadFileTree).mock.calls[0].at(-1) as AbortSignal;
		expect(firstSignal.aborted).toBe(false);

		rerender({ activeSessionId: secondSession.id, activeSession: secondSession });

		await waitFor(() => {
			expect(firstSignal.aborted).toBe(true);
			expect(loadFileTree).toHaveBeenCalledTimes(2);
		});
		expect(
			state.getSessions().find((session) => session.id === firstSession.id)?.fileTreeLoading
		).toBe(false);

		await act(async () => {
			resolveFirst(asResult([{ name: 'stale.txt', type: 'file' }]));
			resolveSecond(asResult([{ name: 'current.txt', type: 'file' }]));
			await Promise.all([firstPending, secondPending]);
		});

		expect(state.getSessions().find((session) => session.id === firstSession.id)?.fileTree).toEqual(
			[]
		);
		expect(
			state.getSessions().find((session) => session.id === secondSession.id)?.fileTree
		).toEqual([{ name: 'current.txt', type: 'file' }]);
	});

	it('keeps an unfinished tree load running when the active session changes on desktop', async () => {
		// Electron issues readDir over per-call IPC with no shared choke point, so
		// switching agents is not a reason to throw away a walk in progress. The
		// load must finish and land its tree even though the user is looking at a
		// different agent - otherwise coming back restarts the whole scan.
		let resolveFirst: (value: ReturnType<typeof asResult>) => void = () => {};
		const firstPending = new Promise<ReturnType<typeof asResult>>((resolve) => {
			resolveFirst = resolve;
		});
		vi.mocked(loadFileTree)
			.mockReturnValueOnce(firstPending)
			.mockReturnValue(Promise.resolve(asResult([{ name: 'b.txt', type: 'file' }])));

		const firstSession = createMockSession({ id: 'session-a', fileTree: [] });
		const secondSession = createMockSession({ id: 'session-b', fileTree: [] });
		const state = createSessionsState([firstSession, secondSession]);
		const baseDeps = createDeps(state);
		const { rerender } = renderHook(
			({ activeSessionId, activeSession }: { activeSessionId: string; activeSession: Session }) =>
				useFileTreeManagement({ ...baseDeps, activeSessionId, activeSession }),
			{ initialProps: { activeSessionId: firstSession.id, activeSession: firstSession } }
		);

		await waitFor(() => expect(loadFileTree).toHaveBeenCalledTimes(1));
		const firstSignal = vi.mocked(loadFileTree).mock.calls[0].at(-1) as AbortSignal;

		rerender({ activeSessionId: secondSession.id, activeSession: secondSession });
		await waitFor(() => expect(loadFileTree).toHaveBeenCalledTimes(2));

		// The walk it left behind is untouched: still marked loading, not aborted.
		expect(firstSignal.aborted).toBe(false);
		expect(
			state.getSessions().find((session) => session.id === firstSession.id)?.fileTreeLoading
		).toBe(true);

		await act(async () => {
			resolveFirst(asResult([{ name: 'a.txt', type: 'file' }]));
			await firstPending;
		});

		// And it still lands, so switching back shows a finished tree rather than
		// starting the scan over.
		expect(state.getSessions().find((session) => session.id === firstSession.id)).toMatchObject({
			fileTree: [{ name: 'a.txt', type: 'file' }],
			fileTreeLoading: false,
		});
	});

	it('does not let an old A load clear a newer A load after an A to B to A switch', async () => {
		// Web-desktop only: the restart this guards against exists because the
		// switch away cancelled A. On Electron nothing cancels, so there is never
		// a second A load to be clobbered by the first.
		asWebDesktop();
		let resolveFirst: (value: ReturnType<typeof asResult>) => void = () => {};
		let resolveSecond: (value: ReturnType<typeof asResult>) => void = () => {};
		let resolveThird: (value: ReturnType<typeof asResult>) => void = () => {};
		const firstPending = new Promise<ReturnType<typeof asResult>>((resolve) => {
			resolveFirst = resolve;
		});
		const secondPending = new Promise<ReturnType<typeof asResult>>((resolve) => {
			resolveSecond = resolve;
		});
		const thirdPending = new Promise<ReturnType<typeof asResult>>((resolve) => {
			resolveThird = resolve;
		});
		vi.mocked(loadFileTree)
			.mockReturnValueOnce(firstPending)
			.mockReturnValueOnce(secondPending)
			.mockReturnValueOnce(thirdPending);

		const firstSession = createMockSession({ id: 'session-a', fileTree: [] });
		const secondSession = createMockSession({ id: 'session-b', fileTree: [] });
		const state = createSessionsState([firstSession, secondSession]);
		const baseDeps = createDeps(state);
		const { rerender } = renderHook(
			({ activeSessionId, activeSession }: { activeSessionId: string; activeSession: Session }) =>
				useFileTreeManagement({ ...baseDeps, activeSessionId, activeSession }),
			{ initialProps: { activeSessionId: firstSession.id, activeSession: firstSession } }
		);

		await waitFor(() => expect(loadFileTree).toHaveBeenCalledTimes(1));
		rerender({ activeSessionId: secondSession.id, activeSession: secondSession });
		await waitFor(() => expect(loadFileTree).toHaveBeenCalledTimes(2));
		rerender({ activeSessionId: firstSession.id, activeSession: firstSession });
		await waitFor(() => expect(loadFileTree).toHaveBeenCalledTimes(3));

		await act(async () => {
			resolveFirst(asResult([{ name: 'stale-a.txt', type: 'file' }]));
			await firstPending;
		});
		expect(
			state.getSessions().find((session) => session.id === firstSession.id)?.fileTreeLoading
		).toBe(true);

		await act(async () => {
			resolveSecond(asResult([{ name: 'stale-b.txt', type: 'file' }]));
			resolveThird(asResult([{ name: 'current-a.txt', type: 'file' }]));
			await Promise.all([secondPending, thirdPending]);
		});
		expect(state.getSessions().find((session) => session.id === firstSession.id)).toMatchObject({
			fileTree: [{ name: 'current-a.txt', type: 'file' }],
			fileTreeLoading: false,
		});
	});

	it('ignores load progress and completion after unmount', async () => {
		let resolveLoad: (value: ReturnType<typeof asResult>) => void = () => {};
		const pending = new Promise<ReturnType<typeof asResult>>((resolve) => {
			resolveLoad = resolve;
		});
		vi.mocked(loadFileTree).mockReturnValue(pending);

		const state = createSessionsState([createMockSession({ fileTree: [] })]);
		const { unmount } = renderHook(() => useFileTreeManagement(createDeps(state)));
		await waitFor(() => expect(loadFileTree).toHaveBeenCalledOnce());
		await act(async () => {});

		const onProgress = vi.mocked(loadFileTree).mock.calls[0][4] as
			| ((progress: {
					directoriesScanned: number;
					filesFound: number;
					currentDirectory: string;
			  }) => void)
			| undefined;
		const writesBeforeUnmount = state.setSessions.mock.calls.length;
		unmount();

		await act(async () => {
			onProgress?.({ directoriesScanned: 1, filesFound: 1, currentDirectory: '/stale' });
			resolveLoad(asResult([{ name: 'stale.txt', type: 'file' }]));
			await pending;
		});

		expect(state.setSessions).toHaveBeenCalledTimes(writesBeforeUnmount);
	});

	it('decouples stats from tree display in initial load', async () => {
		const fullTree: FileNode[] = [{ name: 'file.txt', type: 'file' }];

		// Tree resolves immediately
		vi.mocked(loadFileTree).mockResolvedValue(asResult(fullTree));

		// Stats resolve after a delay
		let resolveStats: (value: {
			fileCount: number;
			folderCount: number;
			totalSize: number;
		}) => void;
		const statsPromise = new Promise<{ fileCount: number; folderCount: number; totalSize: number }>(
			(resolve) => {
				resolveStats = resolve;
			}
		);
		const mockDirectorySize = vi.fn().mockReturnValue(statsPromise);

		const originalFs = window.maestro?.fs;
		window.maestro = {
			...window.maestro,
			fs: {
				...originalFs,
				directorySize: mockDirectorySize,
			},
		};

		const state = createSessionsState([createMockSession({ fileTree: [] })]);
		const deps = createDeps(state);

		renderHook(() => useFileTreeManagement(deps));

		// Tree should be set before stats resolve
		await waitFor(() => {
			expect(state.getSessions()[0].fileTree).toEqual(fullTree);
			expect(state.getSessions()[0].fileTreeLoading).toBe(false);
		});

		// Stats should not be set yet
		expect(state.getSessions()[0].fileTreeStats).toBeUndefined();

		// Now resolve stats
		await act(async () => {
			resolveStats!({ fileCount: 5, folderCount: 2, totalSize: 10000 });
			// Allow microtasks to flush
			await new Promise((resolve) => setTimeout(resolve, 10));
		});

		// Stats should now be populated
		expect(state.getSessions()[0].fileTreeStats).toEqual({
			fileCount: 5,
			folderCount: 2,
			totalSize: 10000,
		});

		if (originalFs) {
			window.maestro.fs = originalFs;
		}
	});

	it('fetches stats for sessions with file tree but no stats (migration)', async () => {
		// Mock directorySize for the migration
		const mockDirectorySize = vi.fn().mockResolvedValue({
			fileCount: 100,
			folderCount: 20,
			totalSize: 5000000,
		});

		const originalFs = window.maestro?.fs;
		window.maestro = {
			...window.maestro,
			fs: {
				...originalFs,
				directorySize: mockDirectorySize,
			},
		};

		// Create session with file tree but no stats (simulating pre-Dec 2025 session)
		const sessionWithTreeNoStats = createMockSession({
			fileTree: [{ name: 'existing.txt', type: 'file' }],
			fileTreeStats: undefined,
			fileTreeError: undefined,
			fileTreeLoading: false,
		});
		const state = createSessionsState([sessionWithTreeNoStats]);
		const deps = createDeps(state);

		renderHook(() => useFileTreeManagement(deps));

		// Wait for the migration effect to run
		await waitFor(() => {
			expect(mockDirectorySize).toHaveBeenCalledWith(
				'/test/project',
				undefined,
				undefined,
				undefined
			);
		});

		// Verify stats were populated
		await waitFor(() => {
			const updated = state.getSessions()[0];
			expect(updated.fileTreeStats).toEqual({
				fileCount: 100,
				folderCount: 20,
				totalSize: 5000000,
			});
		});

		// Restore original
		if (originalFs) {
			window.maestro.fs = originalFs;
		}
	});

	it('does not fire file-tree safety timeout until sessionsLoaded is true', () => {
		vi.useFakeTimers();

		// Start with sessionsLoaded = false (simulates startup before sessions restore)
		delete (window as unknown as Record<string, unknown>).__MAESTRO_BRIDGE_STATE__;
		useSessionStore.setState({ sessionsLoaded: false, initialFileTreeReady: false });

		const state = createSessionsState([createMockSession({ fileTree: [] })]);
		const deps = createDeps(state);

		renderHook(() => useFileTreeManagement(deps));

		// Advance past the 5-second file-tree timeout but not the 8-second backstop
		act(() => {
			vi.advanceTimersByTime(6000);
		});

		// initialFileTreeReady should still be false - gated timer hasn't started yet
		expect(useSessionStore.getState().initialFileTreeReady).toBe(false);

		// Now mark sessions as loaded
		act(() => {
			useSessionStore.setState({ sessionsLoaded: true });
		});

		// Advance just under the 5-second threshold
		act(() => {
			vi.advanceTimersByTime(1900);
		});
		expect(useSessionStore.getState().initialFileTreeReady).toBe(false);

		// Advance past the gated 5-second threshold (total 7.9s from mount)
		act(() => {
			vi.advanceTimersByTime(200);
		});

		// The backstop hasn't fired yet (only 8.1s from mount, but the gated timer has)
		expect(useSessionStore.getState().initialFileTreeReady).toBe(true);

		vi.useRealTimers();
	});

	it('absolute backstop fires at 8s even if sessionsLoaded is never set', () => {
		vi.useFakeTimers();

		// sessionsLoaded stays false - simulates a stuck session restoration
		delete (window as unknown as Record<string, unknown>).__MAESTRO_BRIDGE_STATE__;
		useSessionStore.setState({ sessionsLoaded: false, initialFileTreeReady: false });

		const state = createSessionsState([createMockSession({ fileTree: [] })]);
		const deps = createDeps(state);

		renderHook(() => useFileTreeManagement(deps));

		// At 7.9s - backstop hasn't fired yet
		act(() => {
			vi.advanceTimersByTime(7900);
		});
		expect(useSessionStore.getState().initialFileTreeReady).toBe(false);

		// At 8s - backstop fires
		act(() => {
			vi.advanceTimersByTime(200);
		});
		expect(useSessionStore.getState().initialFileTreeReady).toBe(true);

		vi.useRealTimers();
	});

	it('does not fetch stats when session already has stats', async () => {
		const mockDirectorySize = vi.fn();

		const originalFs = window.maestro?.fs;
		window.maestro = {
			...window.maestro,
			fs: {
				...originalFs,
				directorySize: mockDirectorySize,
			},
		};

		// Create session with both file tree and stats (no migration needed)
		const sessionWithStats = createMockSession({
			fileTree: [{ name: 'existing.txt', type: 'file' }],
			fileTreeStats: {
				fileCount: 50,
				folderCount: 10,
				totalSize: 1000000,
			},
		});
		const state = createSessionsState([sessionWithStats]);
		const deps = createDeps(state);

		renderHook(() => useFileTreeManagement(deps));

		// Migration should NOT run since stats exist
		// Give it a moment to not be called
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(mockDirectorySize).not.toHaveBeenCalled();

		// Restore original
		if (originalFs) {
			window.maestro.fs = originalFs;
		}
	});

	it('repaints filteredFileTree when store fileTree refreshes without an injected activeSession', () => {
		const initialTree: FileNode[] = [{ name: 'old.txt', type: 'file' }];
		const nextTree: FileNode[] = [{ name: 'new.txt', type: 'file' }];
		const session = createMockSession({ fileTree: initialTree });

		useSessionStore.setState({
			sessions: [session],
			activeSessionId: session.id,
			sessionsLoaded: true,
		});

		const state = createSessionsState([session]);
		const { result } = renderHook(() =>
			useFileTreeManagement({
				sessionsRef: state.sessionsRef,
				setSessions: state.setSessions,
				activeSessionId: session.id,
				// Omit activeSession: exercise the self-sourced store path.
				rightPanelRef: {
					current: { refreshHistoryPanel: vi.fn() },
				} as RefObject<RightPanelHandle | null>,
			})
		);

		expect(result.current.filteredFileTree).toEqual(initialTree);

		act(() => {
			useSessionStore.setState({
				sessions: [{ ...session, fileTree: nextTree }],
				activeSessionId: session.id,
			});
		});

		expect(result.current.filteredFileTree).toEqual(nextTree);
	});
});
