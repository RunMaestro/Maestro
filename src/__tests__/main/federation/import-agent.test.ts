/**
 * `import_agent` on the desktop app (a Federation lift onto a remote that runs Maestro itself):
 * the record goes into the sessions store and out to the windows, and queued messages wait a
 * bounded time for a window to hold the agent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const broadcastSessionLifecycle = vi.fn();
vi.mock('../../../main/ipc/handlers/persistence', () => ({
	broadcastSessionLifecycle: (...args: unknown[]) => broadcastSessionLifecycle(...args),
}));
const stores: Record<string, Record<string, unknown>> = {};
const fakeStore = (name: string) => ({
	get: (key: string, fallback: unknown) => stores[name]?.[key] ?? fallback,
	set: (key: string, value: unknown) => {
		stores[name] = { ...(stores[name] ?? {}), [key]: value };
	},
	get store() {
		return stores[name] ?? {};
	},
});
const userData = { dir: '' };
vi.mock('../../../main/utils/app-user-data', () => ({
	getAppUserDataDir: () => userData.dir,
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/stores/getters', () => ({
	getSessionsStore: () => fakeStore('sessions'),
	getGroupsStore: () => fakeStore('groups'),
	getSettingsStore: () => fakeStore('settings'),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	IMPORT_ENQUEUE_ATTEMPTS,
	buildDesktopAgentImportDeps,
	desktopAgentProcesses,
	importAgentIntoDesktop,
	type DesktopAgentImportDeps,
	type ImportProcessTable,
} from '../../../main/federation/import-agent';
import type { AgentImportInput } from '../../../shared/maestro-lib/client/types';
import type { StoredSession } from '../../../main/stores/types';

const input = (extra: Partial<AgentImportInput> = {}): AgentImportInput => ({
	agent: { name: 'Substrate', provider: 'claude-code', cwd: '/work/substrate' },
	tabs: [{ id: 'tA', agentSessionId: 'sess-A', logs: [] }],
	...extra,
});

/** A process table holding the given process ids, recording what is stopped on it. */
function processTable(running: string[] = []) {
	const live = new Set(running);
	const table: ImportProcessTable & { stopped: string[]; closed: string[] } = {
		stopped: [],
		closed: [],
		get: (id) => (live.has(id) ? { id } : undefined),
		kill: (id) => {
			table.stopped.push(id);
			return live.delete(id);
		},
		closeAgent: (agentId) => {
			table.closed.push(agentId);
			for (const id of [...live]) if (id.startsWith(`${agentId}-ai`)) live.delete(id);
		},
	};
	return table;
}

function deps(extra: Partial<DesktopAgentImportDeps> = {}) {
	let sessions: StoredSession[] = [];
	const d: DesktopAgentImportDeps & { stored: () => StoredSession[] } = {
		processes: desktopAgentProcesses(processTable()),
		removeFiles: vi.fn().mockResolvedValue(undefined),
		getSessions: () => sessions,
		setSessions: vi.fn((next: StoredSession[]) => {
			sessions = next;
		}),
		getGroupIds: () => [],
		getSettings: () => ({}),
		announceAdded: vi.fn(),
		enqueue: vi.fn().mockResolvedValue({ success: true }),
		checkCwd: () => null,
		sleep: vi.fn().mockResolvedValue(undefined),
		stored: () => sessions,
		...extra,
	};
	return d;
}

beforeEach(() => {
	broadcastSessionLifecycle.mockReset();
	for (const key of Object.keys(stores)) delete stores[key];
});

describe('importAgentIntoDesktop', () => {
	it('stores the agent, announces it, and reports its id', async () => {
		const d = deps();
		const result = await importAgentIntoDesktop(input(), d);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const [agent] = d.stored();
		expect(agent.name).toBe('Substrate');
		expect(agent.aiTabs[0]).toMatchObject({ id: 'tA', agentSessionId: 'sess-A' });
		expect(d.announceAdded).toHaveBeenCalledWith(agent, []);
		expect(result.receipt).toEqual({ agentId: agent.id, queued: 0 });
	});

	it('replaces the copy an earlier Move Back left here, in the same write (T5)', async () => {
		const d = deps();
		d.setSessions([{ id: 'stale-1', name: 'Substrate', cwd: '/work/substrate' } as StoredSession]);
		const result = await importAgentIntoDesktop(input({ replacesAgentId: 'stale-1' }), d);
		expect(result.ok).toBe(true);
		const stored = d.stored();
		expect(stored.map((agent) => agent.id)).not.toContain('stale-1');
		expect(stored).toHaveLength(1);
		expect(d.announceAdded).toHaveBeenCalledWith(stored[0], ['stale-1']);
	});

	it('refuses to replace a copy whose tab runs a turn in the live table, while its stored state reads idle (T7)', async () => {
		const table = processTable(['stale-1-ai-t1']);
		const d = deps({ processes: desktopAgentProcesses(table) });
		d.setSessions([
			{
				id: 'stale-1',
				name: 'Substrate',
				cwd: '/work/substrate',
				state: 'idle',
				activeTabId: 't1',
				aiTabs: [{ id: 't1', state: 'idle' }],
			} as StoredSession,
		]);
		vi.mocked(d.setSessions).mockClear();
		const result = await importAgentIntoDesktop(input({ replacesAgentId: 'stale-1' }), d);
		expect(result).toMatchObject({ ok: false, code: 'rejected' });
		if (result.ok) return;
		expect(result.message).toMatch(/is running a turn/);
		expect(d.setSessions).not.toHaveBeenCalled();
		expect(table.closed).toEqual([]);
		expect(table.stopped).toEqual([]);
		expect(d.removeFiles).not.toHaveBeenCalled();
		expect(d.stored().map((agent) => agent.id)).toEqual(['stale-1']);
	});

	it('stops every process of an idle replaced copy and removes its files, as a remove does (T7)', async () => {
		const table = processTable(['stale-1-terminal-term1']);
		const d = deps({ processes: desktopAgentProcesses(table) });
		d.setSessions([
			{
				id: 'stale-1',
				name: 'Substrate',
				cwd: '/work/substrate',
				aiTabs: [{ id: 't1' }],
				terminalTabs: [{ id: 'term1' }],
			} as StoredSession,
		]);
		const result = await importAgentIntoDesktop(input({ replacesAgentId: 'stale-1' }), d);
		expect(result.ok).toBe(true);
		expect(table.closed).toEqual(['stale-1']);
		expect(table.stopped).toEqual(['stale-1-terminal', 'stale-1-terminal-term1']);
		expect(d.removeFiles).toHaveBeenCalledWith('stale-1');
		expect(d.stored().map((agent) => agent.id)).not.toContain('stale-1');
	});

	it('refuses a replace when the process table is not up, since nobody can tell it is idle (T7)', async () => {
		const d = deps({ processes: undefined });
		d.setSessions([{ id: 'stale-1', name: 'Substrate', cwd: '/work/substrate' } as StoredSession]);
		vi.mocked(d.setSessions).mockClear();
		const result = await importAgentIntoDesktop(input({ replacesAgentId: 'stale-1' }), d);
		expect(result).toMatchObject({ ok: false, code: 'rejected' });
		expect(d.setSessions).not.toHaveBeenCalled();
	});

	it("says so, and keeps the move, when the replaced copy's files cannot be removed (T7)", async () => {
		const d = deps({ removeFiles: vi.fn().mockRejectedValue(new Error('EACCES')) });
		d.setSessions([{ id: 'stale-1', name: 'Substrate', cwd: '/work/substrate' } as StoredSession]);
		const result = await importAgentIntoDesktop(input({ replacesAgentId: 'stale-1' }), d);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.receipt.notices).toEqual([
			'The playbooks of the replaced copy (stale-1) were not removed: EACCES',
		]);
	});

	it('writes nothing when the import rule refuses', async () => {
		const d = deps({ checkCwd: () => 'No such directory' });
		const result = await importAgentIntoDesktop(input(), d);
		expect(result).toEqual({ ok: false, code: 'invalid', message: 'No such directory' });
		expect(d.setSessions).not.toHaveBeenCalled();
		expect(d.announceAdded).not.toHaveBeenCalled();
	});

	it('waits for a window to hold the agent before queueing, in order', async () => {
		const enqueue = vi
			.fn()
			.mockResolvedValueOnce({
				success: false,
				reason: 'session-not-found',
				error: 'Session not found',
			})
			.mockResolvedValue({ success: true });
		const d = deps({ enqueue });
		const result = await importAgentIntoDesktop(
			input({
				queue: [
					{ tabId: 'tA', text: 'first' },
					{ tabId: 'tA', text: 'second', images: ['data:image/png;base64,AA=='] },
				],
			}),
			d
		);
		expect(result.ok && result.receipt.queued).toBe(2);
		const agentId = d.stored()[0].id;
		expect(enqueue.mock.calls).toEqual([
			[agentId, 'tA', 'first', undefined],
			[agentId, 'tA', 'first', undefined],
			[agentId, 'tA', 'second', ['data:image/png;base64,AA==']],
		]);
		expect(d.sleep).toHaveBeenCalledTimes(1);
	});

	it('reports a message still refused as a notice and keeps the agent', async () => {
		const enqueue = vi.fn().mockResolvedValue({
			success: false,
			reason: 'session-not-found',
			error: 'Session not found',
		});
		const d = deps({ enqueue });
		const result = await importAgentIntoDesktop(
			input({ queue: [{ tabId: 'tA', text: 'first' }] }),
			d
		);
		expect(enqueue).toHaveBeenCalledTimes(IMPORT_ENQUEUE_ATTEMPTS);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.receipt.queued).toBe(0);
		expect(result.receipt.notices).toEqual([
			'A queued message for tab tA was not queued: Session not found',
		]);
		expect(d.stored()).toHaveLength(1);
	});

	it('does not retry a refusal other than a missing agent', async () => {
		const enqueue = vi
			.fn()
			.mockResolvedValue({ success: false, reason: 'tab-not-found', error: 'Tab not found: tA' });
		const d = deps({ enqueue });
		await importAgentIntoDesktop(input({ queue: [{ tabId: 'tA', text: 'first' }] }), d);
		expect(enqueue).toHaveBeenCalledTimes(1);
	});
});

describe('buildDesktopAgentImportDeps', () => {
	it('reads and writes the main stores and pushes the agent to every client', () => {
		stores.sessions = { sessions: [{ id: 'old' }] };
		stores.groups = { groups: [{ id: 'g1' }, { id: 'g2' }] };
		stores.settings = { newTabPlacement: 'end' };
		const enqueue = vi.fn();
		const d = buildDesktopAgentImportDeps(enqueue, null);
		expect(d.getSessions()).toEqual([{ id: 'old' }]);
		expect(d.getGroupIds()).toEqual(['g1', 'g2']);
		expect(d.getSettings()).toEqual({ newTabPlacement: 'end' });
		d.setSessions([{ id: 'new' } as StoredSession]);
		expect(stores.sessions.sessions).toEqual([{ id: 'new' }]);
		d.announceAdded({ id: 'new' } as StoredSession);
		expect(broadcastSessionLifecycle).toHaveBeenCalledWith(undefined, {
			added: [{ id: 'new' }],
			removedIds: [],
		});
		expect(d.enqueue).toBe(enqueue);
		expect(d.processes).toBeUndefined();
	});

	it("removes a replaced agent's playbooks from this desktop's data directory (T7)", async () => {
		userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-agent-'));
		fs.mkdirSync(path.join(userData.dir, 'playbooks'));
		const file = path.join(userData.dir, 'playbooks', 'stale-1.json');
		fs.writeFileSync(file, '{"playbooks":[]}');
		const d = buildDesktopAgentImportDeps(vi.fn(), processTable());
		expect(d.processes).toBeDefined();
		await d.removeFiles('stale-1');
		expect(fs.existsSync(file)).toBe(false);
		fs.rmSync(userData.dir, { recursive: true, force: true });
	});
});
