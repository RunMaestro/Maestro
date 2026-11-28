/**
 * Mode parity for a Cue run in an agent's History panel (row A1.8).
 *
 * A Cue run is never in the agent's JSONL History: it lives in this machine's `cue_events`, and
 * the History read folds it in (`getCueHistoryEntries()`). A local or SSH agent's panel reads
 * `history:getAllPaginated`; a hosted agent's panel reads its host's History through
 * `federation:historyPage`, and its Cue subscriptions still run here, under the local record's
 * id. Both reads must list the same Cue row, graph it in the CUE series, and count it in the bar
 * jump, in every mode.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
	app: { getVersion: () => '1.0.0', getPath: () => '/tmp/maestro-cue-history-parity' },
}));
vi.mock('../../../../main/history-manager', () => ({ getHistoryManager: vi.fn() }));
vi.mock('../../../../main/shared-history-manager', () => ({
	writeEntryRemote: vi.fn(() => Promise.resolve()),
	writeEntryLocal: vi.fn(),
	readRemoteEntriesSsh: vi.fn(() => Promise.resolve([])),
	readRemoteEntriesLocal: vi.fn(() => []),
}));
vi.mock('../../../../main/maestro-cli-manager', () => ({ resolveBundledCliPathSync: () => null }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

import { registerHistoryHandlers } from '../../../../main/ipc/handlers/history';
import { registerFederationHandlers } from '../../../../main/ipc/handlers/federation';
import * as historyManagerModule from '../../../../main/history-manager';
import { setPeerMirrorServiceForTests, type PeerMirrorService } from '../../../../main/federation';
import type { CueHistoryGroup, HistoryEntry } from '../../../../shared/types';
import type { CueHistoryQuery } from '../../../../main/cue/stats/cue-stats-query';

const AGENT_MODES = ['local', 'ssh', 'hosted'] as const;
const HOUR = 3_600_000;
const NOW = Date.now();

const userEntry: HistoryEntry = {
	id: 'u1',
	type: 'USER',
	timestamp: NOW - 2 * HOUR,
	summary: 'asked a thing',
	projectPath: '/repo',
	sessionId: 'agent-1',
};
const cueRun: HistoryEntry = {
	id: 'cue-1',
	type: 'CUE',
	timestamp: NOW - HOUR,
	summary: 'Reviewed 3 PRs',
	projectPath: '/repo',
	sessionId: 'agent-1',
	success: true,
	cueTriggerName: 'PR-Sweep',
	cueEventType: 'time.heartbeat',
};

/** The agent record as the sessions store holds it in each mode. */
function record(mode: (typeof AGENT_MODES)[number]): Record<string, unknown> {
	return {
		id: 'agent-1',
		name: 'Docs',
		cwd: '/repo',
		...(mode === 'local' ? {} : { sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } }),
		...(mode === 'hosted' ? { liftedTo: { peer: 'box', agentId: 'h1', at: 1 } } : {}),
	};
}

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

const getCueHistoryEntries = vi.fn((query: CueHistoryQuery) =>
	query.sessionId === 'agent-1' ? [cueRun] : []
);
const getCueHistoryGroups = vi.fn((query: CueHistoryQuery): CueHistoryGroup[] =>
	query.sessionId === 'agent-1'
		? [
				{
					key: 'PR-Sweep',
					label: 'PR-Sweep',
					runCount: 2,
					failureCount: 0,
					latestEntry: cueRun,
				} as CueHistoryGroup,
			]
		: []
);

describe('A1.8: a Cue run in a local, SSH, or hosted agent History panel', () => {
	let sessions: Array<Record<string, unknown>>;

	beforeEach(() => {
		handlers.clear();
		(ipcMain.handle as Mock).mockImplementation(
			(channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
				handlers.set(channel, handler);
			}
		);
		vi.mocked(historyManagerModule.getHistoryManager).mockReturnValue({
			// The agent's own JSONL History: USER/AUTO only, never a Cue run.
			getEntries: vi.fn(async () => [userEntry]),
			getHistoryFilePath: vi.fn(async () => null),
		} as never);
		// The host serves the same JSONL History of the agent, and no Cue run.
		setPeerMirrorServiceForTests({
			history: vi.fn(async () => [userEntry]),
		} as unknown as PeerMirrorService);
		sessions = [];
		const readSessions = () => sessions;
		registerHistoryHandlers({
			safeSend: vi.fn(),
			getSessionById: (id: string) => sessions.find((s) => s.id === id),
			getAllSessions: readSessions,
			getCueHistoryEntries,
			getCueHistoryGroups,
			// The local graph counts Cue runs per minute from `cue_events`.
			getCueHistoryBuckets: vi.fn(() => [{ timestamp: cueRun.timestamp, count: 1 }]),
		} as never);
		registerFederationHandlers({
			readSessions,
			readSshRemotes: () => [],
			readAgentConfigs: () => ({}),
			getMainWindow: () => null,
			getProcessManager: () => null,
			readAutoMove: () => false,
			// History reads the mirror the test installs; the coordinator stays off.
			hosting: { isOn: () => false, watch: () => () => undefined },
			getCueHistoryEntries,
			getCueHistoryGroups,
		});
	});

	/** What the agent's History panel reads, per mode, through the source it uses. */
	async function panel(mode: (typeof AGENT_MODES)[number], groupCue = false) {
		sessions = [record(mode)];
		if (mode === 'hosted') {
			const page = (await call('federation:historyPage', 'box', 'h1', {
				lookbackHours: 24,
				groupCue,
			})) as { entries: HistoryEntry[] };
			const graph = (await call('federation:historyGraph', 'box', 'h1', 24, 24)) as {
				cueCount: number;
			};
			const offset = await call('federation:historyOffset', 'box', 'h1', NOW - 90 * 60_000, 24);
			return { page: page.entries, cueCount: graph.cueCount, offset };
		}
		const page = (await call('history:getAllPaginated', {
			sessionId: 'agent-1',
			lookbackHours: 24,
			groupCue,
		})) as { entries: HistoryEntry[] };
		const graph = (await call('history:getGraphData', 'agent-1', 24, 24)) as {
			cueCount: number;
		};
		const offset = await call('history:getOffsetForTimestamp', 'agent-1', NOW - 90 * 60_000, 24);
		return { page: page.entries, cueCount: graph.cueCount, offset };
	}

	it('lists, graphs, and counts the same Cue run in every mode', async () => {
		const seen = [];
		for (const mode of AGENT_MODES) {
			const view = await panel(mode);
			seen.push({
				ids: view.page.map((entry) => entry.id),
				types: view.page.map((entry) => entry.type),
				cueCount: view.cueCount,
				offset: view.offset,
			});
		}
		expect(seen[0]).toEqual({
			ids: ['cue-1', 'u1'],
			types: ['CUE', 'USER'],
			cueCount: 1,
			offset: 1,
		});
		expect(seen[1]).toEqual(seen[0]);
		expect(seen[2]).toEqual(seen[0]);
	});

	it('collapses Cue runs per trigger in every mode when the setting asks', async () => {
		const groups = [];
		for (const mode of AGENT_MODES) {
			const view = await panel(mode, true);
			groups.push(view.page.find((entry) => entry.type === 'CUE')?.cueGroup);
		}
		expect(groups[0]).toEqual({ key: 'PR-Sweep', label: 'PR-Sweep', runCount: 2, failureCount: 0 });
		expect(groups[1]).toEqual(groups[0]);
		expect(groups[2]).toEqual(groups[0]);
	});

	it('lists no Cue run of another agent the host runs', async () => {
		sessions = [{ ...record('hosted'), liftedTo: { peer: 'box', agentId: 'someone-else', at: 1 } }];
		const page = (await call('federation:historyPage', 'box', 'h1', {})) as {
			entries: HistoryEntry[];
		};
		expect(page.entries.map((entry) => entry.id)).toEqual(['u1']);
	});
});
