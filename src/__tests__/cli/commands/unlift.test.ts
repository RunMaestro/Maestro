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

import { unlift, type UnliftDeps } from '../../../cli/commands/unlift';
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
		expect(deps.restoreInDesktop).toHaveBeenCalledWith('agent-1', {
			tabs: [{ id: 'tab-1', agentSessionId: 'sess-1', logs: [] }],
		});
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

	it('refuses an agent that is not hosted', async () => {
		const { deps } = depsWith({
			readAgents: () => [{ ...hosted, liftedTo: undefined }],
		});
		await unlift('agent-1', { json: true }, deps);
		expect(lastJson()).toMatchObject({ success: false, code: 'RETURN_NOT_HOSTED' });
		expect(deps.connect).not.toHaveBeenCalled();
	});
});
