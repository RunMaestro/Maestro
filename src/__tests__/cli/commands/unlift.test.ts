/**
 * Tests for `maestro-cli unlift <agent>`: the shared Move Back runner reached from the CLI, the
 * restore through the desktop or the store file, the store owner check, and the output forms.
 * The runner's own rules are covered by `lift-return.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({
	getSyncDir: vi.fn(() => '/tmp/maestro'),
	readSessions: vi.fn(() => []),
	resolveAgentId: vi.fn((id: string) => id),
	readAgentConfig: vi.fn(() => ({})),
	readSshRemotes: vi.fn(() => []),
	resolveSshRemoteId: vi.fn((id: string) => id),
}));

import { unlift, unliftAll, type UnliftDeps } from '../../../cli/commands/unlift';
import { ExitCode } from '../../../cli/exit-codes';
import { MaestroNotRunningError } from '../../../cli/services/maestro-not-running';
import type { PeerConnection } from '../../../cli/services/peer-resolver';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';

const ok = <T>(value: T) => ({ ok: true as const, value });

const hosted: AgentRecord = {
	id: 'agent-1',
	name: 'Docs',
	toolType: 'claude-code',
	sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
	liftedTo: { peer: 'build-box', agentId: 'host-1', at: 1 },
	aiTabs: [{ id: 'tab-1', agentSessionId: 'sess-1', logs: [] }],
} as AgentRecord;

function fakeConnection() {
	const remove = vi.fn().mockResolvedValue(ok(undefined));
	const release = vi.fn().mockResolvedValue(undefined);
	const connection = {
		peer: 'build-box',
		client: {
			agents: {
				get: vi.fn().mockResolvedValue(ok({ id: 'host-1', aiTabs: [{ id: 'tab-1' }] })),
				remove,
			},
			tabs: {
				list: vi.fn().mockResolvedValue(ok([{ id: 'tab-1', agentSessionId: 'sess-1' }])),
				transcript: vi.fn().mockResolvedValue(ok([])),
			},
			turns: { queue: { list: vi.fn().mockResolvedValue(ok([])) } },
		},
		release,
	} as unknown as PeerConnection;
	return { connection, remove };
}

function depsWith(overrides: Partial<UnliftDeps> = {}) {
	const { connection, remove } = fakeConnection();
	const deps: UnliftDeps = {
		readAgents: () => [hosted],
		resolveAgentId: (ref) => {
			if (ref !== hosted.id && ref !== hosted.name) throw new Error(`Agent not found: ${ref}`);
			return hosted.id;
		},
		localStoreOwner: () => 'desktop',
		connect: vi.fn().mockResolvedValue(connection),
		restoreInDesktop: vi.fn().mockResolvedValue({ success: true }),
		restoreOnDisk: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
	return { deps, remove };
}

/** A host queue that keeps what Hold / Resume set, as a real host does. */
function hostQueue(items: Array<Record<string, unknown> & { itemId: string; paused: boolean }>) {
	const paused = new Map<string, boolean>();
	const setPaused = vi.fn(async (_agentId: string, itemId: string, value: boolean) => {
		paused.set(itemId, value);
		return ok({ found: true, paused: value });
	});
	const list = vi.fn(async () =>
		ok(items.map((item) => ({ ...item, paused: paused.get(item.itemId) ?? item.paused })))
	);
	return { list, setPaused };
}

let logs: string[];

beforeEach(() => {
	logs = [];
	vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
		logs.push(String(line));
	});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	process.exitCode = undefined;
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

const lastJson = () => JSON.parse(logs[logs.length - 1]) as Record<string, unknown>;

describe('maestro-cli unlift', () => {
	it('restores through the desktop, then removes the host copy', async () => {
		const { deps, remove } = depsWith();
		await unlift('Docs', { json: true }, deps);
		expect(deps.connect).toHaveBeenCalledWith('remote-1');
		expect(deps.restoreInDesktop).toHaveBeenNthCalledWith(1, 'agent-1', {
			tabs: [{ id: 'tab-1', agentSessionId: 'sess-1', logs: [] }],
			leftOnHost: { peer: 'build-box', agentId: 'host-1', at: 1 },
			hostCopyLeft: expect.objectContaining({
				peer: 'build-box',
				agentId: 'host-1',
				fetched: true,
			}),
		});
		// After the host copy is removed, the record is written once more without its marker.
		expect(deps.restoreInDesktop).toHaveBeenNthCalledWith(2, 'agent-1', { tabs: [] });
		expect(deps.restoreOnDisk).not.toHaveBeenCalled();
		expect(remove).toHaveBeenCalledWith('host-1');
		expect(lastJson()).toMatchObject({
			success: true,
			from: 'build-box:host-1',
			tabs: 1,
			hostCopyRemoved: true,
		});
	});

	it('writes the store file when no desktop runs, or when it quit since the check', async () => {
		const none = depsWith({ localStoreOwner: () => 'none' });
		await unlift('agent-1', { json: true }, none.deps);
		expect(none.deps.restoreInDesktop).not.toHaveBeenCalled();
		expect(none.deps.restoreOnDisk).toHaveBeenCalled();

		const quit = depsWith({
			restoreInDesktop: vi.fn().mockRejectedValue(new MaestroNotRunningError('no-discovery-file')),
		});
		await unlift('agent-1', { json: true }, quit.deps);
		expect(quit.deps.restoreOnDisk).toHaveBeenCalled();
	});

	it('refuses while a headless host owns the store, and leaves the host copy', async () => {
		const { deps, remove } = depsWith({ localStoreOwner: () => 'headless-host' });
		await unlift('agent-1', { json: true }, deps);
		expect(lastJson()).toMatchObject({ success: false, code: 'RETURN_RESTORE_FAILED' });
		expect(remove).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(ExitCode.GeneralError);
	});

	it('moves back offline without dialing, and keeps the host copy with --keep-host-copy', async () => {
		const offline = depsWith();
		await unlift('agent-1', { json: true, offline: true }, offline.deps);
		expect(offline.deps.connect).not.toHaveBeenCalled();
		expect(lastJson()).toMatchObject({ success: true, hostCopyRemoved: false });

		const kept = depsWith();
		await unlift('agent-1', { json: true, keepHostCopy: true }, kept.deps);
		expect(kept.remove).not.toHaveBeenCalled();
	});

	it('a desktop that did not answer in time may still save the restore: nothing held on the host is released (#2195)', async () => {
		const queued = {
			itemId: 'q1',
			tabId: 'tab-1',
			queuedAt: 1,
			kind: 'message',
			text: 'next',
			paused: false,
			readOnly: false,
		};
		for (const answer of [
			() => Promise.resolve({ success: false, error: 'Renderer did not respond in time' }),
			() => Promise.reject(new Error('socket closed')),
		]) {
			const { connection } = fakeConnection();
			const client = (connection as unknown as { client: { turns: { queue: unknown } } }).client;
			const queue = hostQueue([queued]);
			const setPaused = queue.setPaused;
			client.turns.queue = queue;
			const { deps, remove } = depsWith({
				connect: vi.fn().mockResolvedValue(connection),
				restoreInDesktop: vi.fn(answer),
			});
			await unlift('agent-1', { json: true }, deps);
			expect(lastJson()).toMatchObject({
				success: false,
				error: expect.stringMatching(/stays held there, so it cannot run twice/),
			});
			expect(setPaused.mock.calls).toEqual([['host-1', 'q1', true]]);
			expect(remove).not.toHaveBeenCalled();
		}
	});

	it('a desktop that refuses the restore lets the host run what it held again', async () => {
		const { connection } = fakeConnection();
		const client = (connection as unknown as { client: { turns: { queue: unknown } } }).client;
		const queue = hostQueue([
			{ itemId: 'q1', tabId: 'tab-1', queuedAt: 1, kind: 'message', text: 'n', paused: false },
		]);
		const setPaused = queue.setPaused;
		client.turns.queue = queue;
		const { deps } = depsWith({
			connect: vi.fn().mockResolvedValue(connection),
			restoreInDesktop: vi.fn().mockResolvedValue({ success: false, error: 'Agent is not hosted' }),
		});
		await unlift('agent-1', { json: true }, deps);
		expect(setPaused.mock.calls).toEqual([
			['host-1', 'q1', true],
			['host-1', 'q1', false],
		]);
	});

	it('refuses an agent that is not hosted', async () => {
		const { deps } = depsWith({
			readAgents: () => [{ ...hosted, liftedTo: undefined }],
		});
		await unlift('agent-1', { json: true }, deps);
		expect(lastJson()).toMatchObject({ success: false, code: 'RETURN_NOT_HOSTED' });
		expect(deps.connect).not.toHaveBeenCalled();
	});
});

describe('maestro-cli unlift --all', () => {
	const second: AgentRecord = {
		...hosted,
		id: 'agent-2',
		name: 'Docs',
		liftedTo: { peer: 'build-box', agentId: 'host-2', at: 2 },
	} as AgentRecord;
	const plain: AgentRecord = { ...hosted, id: 'agent-3', name: 'Plain', liftedTo: undefined };

	it('moves every moved agent back, one at a time, and reports each one', async () => {
		let open = 0;
		let peak = 0;
		const { connection } = fakeConnection();
		const { deps } = depsWith({
			readAgents: () => [hosted, plain, second],
			connect: vi.fn(async () => {
				open += 1;
				peak = Math.max(peak, open);
				await Promise.resolve();
				return {
					...connection,
					release: async () => {
						open -= 1;
					},
				};
			}),
		});
		await unliftAll({ json: true }, deps);
		// Two agents share a name: each is returned by its own id, never resolved by name. Each is
		// written twice: home with its host copy marked, then unmarked once the copy is removed.
		expect(vi.mocked(deps.restoreInDesktop).mock.calls.map(([id]) => id)).toEqual([
			'agent-1',
			'agent-1',
			'agent-2',
			'agent-2',
		]);
		expect(peak).toBe(1);
		expect(open).toBe(0);
		const out = lastJson() as { success: boolean; agents: Array<Record<string, unknown>> };
		expect(out.success).toBe(true);
		expect(out.agents.map((agent) => (agent.agent as { id: string }).id)).toEqual([
			'agent-1',
			'agent-2',
		]);
		expect(out.agents.every((agent) => agent.ok === true)).toBe(true);
		expect(process.exitCode).toBeUndefined();
	});

	it('leaves an agent whose host does not answer moved, reports it, and still returns the rest', async () => {
		const { connection } = fakeConnection();
		const { deps } = depsWith({
			readAgents: () => [hosted, second],
			connect: vi
				.fn()
				.mockRejectedValueOnce(new Error('host down'))
				.mockResolvedValueOnce(connection),
		});
		await unliftAll({ json: true }, deps);
		const out = lastJson() as { success: boolean; agents: Array<Record<string, unknown>> };
		expect(out.success).toBe(false);
		expect(out.agents[0]).toMatchObject({ ok: false, agent: { id: 'agent-1' } });
		expect(out.agents[1]).toMatchObject({ ok: true, agent: { id: 'agent-2' } });
		expect(vi.mocked(deps.restoreInDesktop).mock.calls.map(([id]) => id)).toEqual([
			'agent-2',
			'agent-2',
		]);
		expect(process.exitCode).toBe(ExitCode.GeneralError);
	});

	it('with --offline, restores every moved agent without dialing', async () => {
		const { deps } = depsWith({ readAgents: () => [hosted, second] });
		await unliftAll({ json: true, offline: true }, deps);
		expect(deps.connect).not.toHaveBeenCalled();
		expect(deps.restoreInDesktop).toHaveBeenCalledTimes(2);
		expect(lastJson()).toMatchObject({ success: true });
	});

	it('says so when no agent is on a host', async () => {
		const { deps } = depsWith({ readAgents: () => [plain] });
		await unliftAll({}, deps);
		expect(deps.connect).not.toHaveBeenCalled();
		expect(logs.join('\n')).toMatch(/No agent is on a host/);
		expect(process.exitCode).toBeUndefined();
	});
});
