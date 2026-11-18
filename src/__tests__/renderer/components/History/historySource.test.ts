/**
 * Tests for the History panel's two sources: a local agent's History through
 * `window.maestro.history` (with the shared History of its project), and a Federation peer's
 * mirrored agent through `window.maestro.federation.history*`, which is read-only and reads
 * again when the window's mirror bumps the agent's History version.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	localHistorySource,
	mirrorHistorySource,
	type HistorySourceQuery,
} from '../../../../renderer/components/History/historySource';
import { usePeerMirrorStore } from '../../../../renderer/stores/peerMirrorStore';
import type { HistoryEntry } from '../../../../renderer/types';
import { resetStores } from '../../../helpers';

const entry: HistoryEntry = {
	id: 'h1',
	type: 'USER',
	timestamp: 1,
	summary: 's',
	projectPath: '/p',
};

const query: HistorySourceQuery = {
	lookbackHours: 24,
	types: ['USER', 'AUTO'],
	hostKey: 'laptop',
	groupCue: true,
	pagination: { offset: 10, limit: 5 },
};

const GRAPH = { buckets: [], earliestTimestamp: 0, latestTimestamp: 0, hostCounts: {} };

describe('historySource', () => {
	let history: Record<string, ReturnType<typeof vi.fn>>;
	let federation: Record<string, ReturnType<typeof vi.fn>>;
	let onHistoryEntryAdded: ReturnType<typeof vi.fn>;
	let entryListener: ((entry: unknown, sourceSessionId: string) => void) | undefined;
	let originalMaestro: unknown;

	beforeEach(() => {
		resetStores(usePeerMirrorStore);
		history = {
			getAllPaginated: vi.fn(async () => ({
				entries: [entry],
				hasMore: true,
				total: 7,
				limit: 5,
				offset: 10,
			})),
			getGraphData: vi.fn(async () => GRAPH),
			getOffsetForTimestamp: vi.fn(async () => 3),
			delete: vi.fn(async () => true),
			update: vi.fn(async () => true),
		};
		federation = {
			historyPage: vi.fn(async () => ({
				entries: [entry],
				hasMore: false,
				total: 1,
				limit: 5,
				offset: 0,
			})),
			historyGraph: vi.fn(async () => GRAPH),
			historyOffset: vi.fn(async () => 2),
		};
		const unsubscribe = vi.fn();
		onHistoryEntryAdded = vi.fn((listener) => {
			entryListener = listener;
			return unsubscribe;
		});
		const win = window as unknown as { maestro?: Record<string, unknown> };
		originalMaestro = win.maestro;
		win.maestro = {
			...(win.maestro ?? {}),
			history,
			federation,
			directorNotes: { onHistoryEntryAdded },
		};
	});

	afterEach(() => {
		(window as unknown as { maestro?: unknown }).maestro = originalMaestro;
		entryListener = undefined;
	});

	describe('localHistorySource', () => {
		const local = { id: 'agent-1', cwd: '/work/cwd', projectRoot: '/work/root' };

		it('pages through getAllPaginated with the project path and every filter', async () => {
			const page = await localHistorySource(local).getPage(query);
			expect(history.getAllPaginated).toHaveBeenCalledWith({
				sessionId: 'agent-1',
				projectPath: '/work/root',
				sharedContext: undefined,
				lookbackHours: 24,
				types: ['USER', 'AUTO'],
				hostKey: 'laptop',
				groupCue: true,
				pagination: { offset: 10, limit: 5 },
			});
			expect(page).toEqual({ entries: [entry], hasMore: true, total: 7 });
		});

		it('falls back to cwd for the project path, and sends the SSH shared context when it syncs', async () => {
			const ssh = {
				id: 'agent-2',
				cwd: '/remote/cwd',
				projectRoot: '',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1', syncHistory: true },
			};
			const source = localHistorySource(ssh as never);
			await source.getPage(query);
			expect(history.getAllPaginated).toHaveBeenLastCalledWith(
				expect.objectContaining({
					projectPath: '/remote/cwd',
					sharedContext: { sshRemoteId: 'r1', remoteCwd: '/remote/cwd' },
				})
			);
			await source.getGraphData(12, null);
			expect(history.getGraphData).toHaveBeenCalledWith(
				'agent-2',
				12,
				null,
				{ sshRemoteId: 'r1', remoteCwd: '/remote/cwd' },
				'/remote/cwd'
			);
		});

		it('passes the graph and the offset reads through with the agent id', async () => {
			const source = localHistorySource(local);
			expect(await source.getGraphData(24, 168)).toBe(GRAPH);
			expect(history.getGraphData).toHaveBeenCalledWith(
				'agent-1',
				24,
				168,
				undefined,
				'/work/root'
			);
			expect(await source.getOffsetForTimestamp(500, 24, ['USER'])).toBe(3);
			expect(history.getOffsetForTimestamp).toHaveBeenCalledWith('agent-1', 500, 24, ['USER']);
		});

		it('streams only the entries of its own agent', () => {
			const onEntry = vi.fn();
			const onReset = vi.fn();
			const unsubscribe = localHistorySource(local).subscribe({ onEntry, onReset });
			entryListener?.(entry, 'someone-else');
			entryListener?.(entry, 'agent-1');
			expect(onEntry).toHaveBeenCalledTimes(1);
			expect(onEntry).toHaveBeenCalledWith(entry);
			expect(onReset).not.toHaveBeenCalled();
			unsubscribe();
			expect(onHistoryEntryAdded.mock.results[0].value).toHaveBeenCalledTimes(1);
		});

		it('deletes and updates with the agent id', async () => {
			const source = localHistorySource(local);
			expect(await source.remove?.('h1')).toBe(true);
			expect(history.delete).toHaveBeenCalledWith('h1', 'agent-1');
			expect(await source.update?.('h1', { validated: true })).toBe(true);
			expect(history.update).toHaveBeenCalledWith('h1', { validated: true }, 'agent-1');
		});
	});

	describe('mirrorHistorySource', () => {
		it('pages through federation.historyPage without the local-only Cue grouping', async () => {
			const page = await mirrorHistorySource('buildbox', 'a1').getPage(query);
			expect(federation.historyPage).toHaveBeenCalledWith('buildbox', 'a1', {
				lookbackHours: 24,
				types: ['USER', 'AUTO'],
				hostKey: 'laptop',
				pagination: { offset: 10, limit: 5 },
			});
			expect(page).toEqual({ entries: [entry], hasMore: false, total: 1 });
			expect(history.getAllPaginated).not.toHaveBeenCalled();
		});

		it('reads the graph and the offset from the host', async () => {
			const source = mirrorHistorySource('buildbox', 'a1');
			expect(await source.getGraphData(24, null)).toBe(GRAPH);
			expect(federation.historyGraph).toHaveBeenCalledWith('buildbox', 'a1', 24, null);
			expect(await source.getOffsetForTimestamp(900, 48, ['AUTO'])).toBe(2);
			expect(federation.historyOffset).toHaveBeenCalledWith('buildbox', 'a1', 900, 48, ['AUTO']);
		});

		it('is read-only: no remove and no update', () => {
			const source = mirrorHistorySource('buildbox', 'a1');
			expect(source.remove).toBeUndefined();
			expect(source.update).toBeUndefined();
		});

		it('resets when its own agent History version moves, and only then', () => {
			usePeerMirrorStore.setState({ historyVersions: { 'buildbox:a1': 1, 'buildbox:a2': 1 } });
			const onEntry = vi.fn();
			const onReset = vi.fn();
			const unsubscribe = mirrorHistorySource('buildbox', 'a1').subscribe({ onEntry, onReset });

			usePeerMirrorStore.setState({ historyVersions: { 'buildbox:a1': 1, 'buildbox:a2': 2 } });
			usePeerMirrorStore.setState({ drafts: { x: 'typing' } });
			expect(onReset).not.toHaveBeenCalled();

			usePeerMirrorStore.setState({ historyVersions: { 'buildbox:a1': 2, 'buildbox:a2': 2 } });
			expect(onReset).toHaveBeenCalledTimes(1);
			// The same version again is no change.
			usePeerMirrorStore.setState({ historyVersions: { 'buildbox:a1': 2 } });
			expect(onReset).toHaveBeenCalledTimes(1);

			unsubscribe();
			usePeerMirrorStore.setState({ historyVersions: { 'buildbox:a1': 3 } });
			expect(onReset).toHaveBeenCalledTimes(1);
			expect(onEntry).not.toHaveBeenCalled();
		});

		it('treats a dropped version (peer removed) as a change from the one it held', () => {
			usePeerMirrorStore.setState({ historyVersions: { 'buildbox:a1': 4 } });
			const onReset = vi.fn();
			mirrorHistorySource('buildbox', 'a1').subscribe({ onEntry: vi.fn(), onReset });
			usePeerMirrorStore.setState({ historyVersions: {} });
			expect(onReset).toHaveBeenCalledTimes(1);
		});
	});
});
