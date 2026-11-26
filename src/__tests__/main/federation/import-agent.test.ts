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
vi.mock('../../../main/stores/getters', () => ({
	getSessionsStore: () => fakeStore('sessions'),
	getGroupsStore: () => fakeStore('groups'),
	getSettingsStore: () => fakeStore('settings'),
}));

import {
	IMPORT_ENQUEUE_ATTEMPTS,
	buildDesktopAgentImportDeps,
	importAgentIntoDesktop,
	type DesktopAgentImportDeps,
} from '../../../main/federation/import-agent';
import type { AgentImportInput } from '../../../shared/maestro-lib/client/types';
import type { StoredSession } from '../../../main/stores/types';

const input = (extra: Partial<AgentImportInput> = {}): AgentImportInput => ({
	agent: { name: 'Substrate', provider: 'claude-code', cwd: '/work/substrate' },
	tabs: [{ id: 'tA', agentSessionId: 'sess-A', logs: [] }],
	...extra,
});

function deps(extra: Partial<DesktopAgentImportDeps> = {}) {
	let sessions: StoredSession[] = [];
	const d: DesktopAgentImportDeps & { stored: () => StoredSession[] } = {
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
		const d = buildDesktopAgentImportDeps(enqueue);
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
	});
});
