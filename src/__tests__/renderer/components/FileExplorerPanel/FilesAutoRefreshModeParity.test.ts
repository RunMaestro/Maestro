/**
 * Parity (R7): the Files panel picks up a folder made outside Maestro by the same
 * rule in every mode. The third live pass saw the SSH agent's new folder only after
 * Refresh while the local and hosted ones showed it; the fourth measured all three
 * at the same auto-refresh tick. The code has one timer for every agent and no file
 * watcher for any mode, and a hosted agent reads its tree over the same SSH loader
 * as an SSH one. This locks that in: the real refresh under the real timer, in all
 * three modes, with the same output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { SetStateAction } from 'react';
import {
	useFileTreeManagement,
	type UseFileTreeManagementDeps,
} from '../../../../renderer/hooks/git/useFileTreeManagement';
import {
	DEFAULT_FILE_TREE_AUTO_REFRESH_SECONDS,
	fileTreeAutoRefreshSeconds,
	useAutoRefresh,
} from '../../../../renderer/components/FileExplorerPanel/hooks/useAutoRefresh';
import {
	compareFileTrees,
	loadFileTree,
	loadFileTreeRemoteBatched,
} from '../../../../renderer/utils/fileExplorer';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { Session } from '../../../../renderer/types';
import type { FileNode } from '../../../../renderer/types/fileTree';
import { AGENT_MODES, createModeSession, type AgentMode } from '../../../helpers/mockSession';

vi.mock('../../../../renderer/utils/fileExplorer', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../../renderer/utils/fileExplorer')>();
	return {
		...actual,
		loadFileTree: vi.fn(),
		loadFileTreeRemoteBatched: vi.fn(),
		compareFileTrees: vi.fn(),
	};
});

vi.mock('../../../../renderer/services/git', () => ({
	gitService: { isRepo: vi.fn(), getBranches: vi.fn(), getTags: vi.fn() },
}));

vi.mock('../../../../renderer/utils/runtimeContext', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../../renderer/utils/runtimeContext')>();
	return { ...actual, isWebDesktop: vi.fn(() => false) };
});

const loadedTree: FileNode[] = [{ name: 'existing.txt', type: 'file' }];
const treeWithNewFolder: FileNode[] = [
	...loadedTree,
	{ name: 'made-outside', type: 'folder', children: [] },
];
const result = (tree: FileNode[]) => ({ tree, truncated: false, filesFound: tree.length });

/** Mount the Files panel's refresh pair for one agent, as FileExplorerPanel wires it. */
function mountFilesRefresh(mode: AgentMode) {
	let sessions: Session[] = [
		createModeSession(mode, {
			id: `files-${mode}`,
			fileTree: loadedTree,
			fileTreeStats: { fileCount: 1, folderCount: 0, totalSize: 1 },
		}),
	];
	const sessionsRef = { current: sessions };
	const setSessions = vi.fn((updater: SetStateAction<Session[]>) => {
		sessions = typeof updater === 'function' ? updater(sessions) : updater;
		sessionsRef.current = sessions;
	});
	const deps: UseFileTreeManagementDeps = {
		sessionsRef,
		setSessions,
		activeSessionId: sessions[0].id,
		activeSession: sessions[0],
		rightPanelRef: { current: { refreshHistoryPanel: vi.fn() } },
	} as unknown as UseFileTreeManagementDeps;
	const { unmount } = renderHook(() => {
		const { refreshFileTree } = useFileTreeManagement(deps);
		return useAutoRefresh({
			sessionId: sessions[0].id,
			autoRefreshInterval: fileTreeAutoRefreshSeconds(sessions[0]),
			refreshFileTree,
			setSessions,
		});
	});
	return { names: () => (sessions[0].fileTree ?? []).map((n) => n.name), unmount };
}

/** Which loader read the tree, and for which remote. */
function treeReads(): string[] {
	return [
		...vi.mocked(loadFileTree).mock.calls.map(() => 'local'),
		...vi
			.mocked(loadFileTreeRemoteBatched)
			.mock.calls.map(([, opts]) => `remote:${(opts as { sshRemoteId?: string }).sshRemoteId}`),
	];
}

describe('Files panel auto-refresh: the same rule in every mode (R7)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		useSessionStore.setState({ sessionsLoaded: true });
		window.maestro = {
			...window.maestro,
			fs: {
				...window.maestro?.fs,
				directorySize: vi.fn().mockResolvedValue({ fileCount: 1, folderCount: 1, totalSize: 1 }),
			},
		} as typeof window.maestro;
		vi.mocked(loadFileTree).mockResolvedValue(result(treeWithNewFolder));
		vi.mocked(loadFileTreeRemoteBatched).mockResolvedValue(result(treeWithNewFolder));
		vi.mocked(compareFileTrees).mockReturnValue({
			totalChanges: 1,
			newFiles: 0,
			newFolders: 1,
			removedFiles: 0,
			removedFolders: 0,
		});
	});

	afterEach(() => {
		useSessionStore.setState({ sessionsLoaded: false, initialFileTreeReady: false });
		vi.useRealTimers();
	});

	it('uses one interval for an agent that has not chosen one, whatever its mode', () => {
		for (const mode of AGENT_MODES) {
			expect(fileTreeAutoRefreshSeconds(createModeSession(mode))).toBe(
				DEFAULT_FILE_TREE_AUTO_REFRESH_SECONDS
			);
			expect(
				fileTreeAutoRefreshSeconds(createModeSession(mode, { fileTreeAutoRefreshInterval: 0 }))
			).toBe(0);
		}
	});

	it('shows a folder made outside Maestro at the same tick in all three modes', async () => {
		const seen: Record<string, { before: string[]; after: string[]; reads: string[] }> = {};
		for (const mode of AGENT_MODES) {
			vi.mocked(loadFileTree).mockClear();
			vi.mocked(loadFileTreeRemoteBatched).mockClear();
			const panel = mountFilesRefresh(mode);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(DEFAULT_FILE_TREE_AUTO_REFRESH_SECONDS * 1000 - 1);
			});
			const before = panel.names();
			expect(treeReads()).toEqual([]);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(1);
			});
			seen[mode] = { before, after: panel.names(), reads: treeReads() };
			panel.unmount();
		}

		expect(seen.local.before).toEqual(['existing.txt']);
		expect(seen.local.after).toEqual(['existing.txt', 'made-outside']);
		expect(seen.local.reads).toEqual(['local']);
		// SSH and hosted read the remote the same way, so nothing but the transport differs.
		expect(seen.ssh).toEqual({ ...seen.local, reads: ['remote:r1'] });
		expect(seen.hosted).toEqual(seen.ssh);
	});
});
