/**
 * Tests for the automatic Federation coordinator: hosts kept running (A1, A2), installs only where
 * an SSH agent wants a host, and automatic moves (A3) gated by every sanity check, each blocker
 * carrying the one thing a person has to do.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import {
	AutoFederationCoordinator,
	BLOCKED_RETRY_MS,
	SETUP_RETRY_MS,
	type AutoFederationDeps,
} from '../../../main/federation/auto-federation';
import type { DesktopLiftAnswer } from '../../../main/federation/lift';
import type { DesktopSetupHostAnswer } from '../../../main/federation/setup-host';
import type { MirrorPeerSummary } from '../../../shared/maestro-lib/client/peer-mirror';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import type { SshRemoteConfig } from '../../../shared/types';

const remote = (id: string, overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig => ({
	id,
	name: id,
	host: `${id}.example.com`,
	port: 22,
	username: 'pedram',
	privateKeyPath: '',
	enabled: true,
	...overrides,
});

const agent = (
	id: string,
	remoteId: string,
	overrides: Partial<AgentRecord> = {}
): AgentRecord => ({
	id,
	name: `Agent ${id}`,
	toolType: 'claude-code',
	cwd: '/home/pedram/project',
	sessionSshRemoteConfig: { enabled: true, remoteId },
	aiTabs: [{ id: 't1' }],
	...overrides,
});

const peer = (
	remoteId: string,
	connection: MirrorPeerSummary['connection']
): MirrorPeerSummary => ({
	peerId: remoteId,
	remoteId,
	name: remoteId,
	connection,
	agentCount: 0,
});

const plan = (withheld: string[] = []): DesktopLiftAnswer =>
	({
		ok: true,
		planText: 'Would lift',
		result: { dryRun: true, plan: { env: { withheld } } },
	}) as unknown as DesktopLiftAnswer;

const moved: DesktopLiftAnswer = {
	ok: true,
	planText: 'Lifting',
	result: { dryRun: false, plan: { env: { withheld: [] } }, target: 'r1:h1' },
} as unknown as DesktopLiftAnswer;

const setupOk: DesktopSetupHostAnswer = {
	ok: true,
	result: { cli: 'current', service: { kind: 'systemd', state: 'active', linger: true } },
};

function world(options: {
	remotes?: SshRemoteConfig[];
	agents?: AgentRecord[];
	peers?: MirrorPeerSummary[];
	autoMove?: boolean;
	providers?: Array<{ id: string; name: string; available: boolean }> | null;
	setup?: DesktopSetupHostAnswer;
	liftAnswers?: DesktopLiftAnswer[];
	busy?: boolean;
}) {
	let now = 1_000_000;
	let peers = options.peers ?? [peer('r1', 'connected')];
	const liftAnswers = [...(options.liftAnswers ?? [plan(), moved])];
	const deps = {
		readRemotes: vi.fn(() => options.remotes ?? [remote('r1')]),
		readAgents: vi.fn(() => options.agents ?? [agent('a1', 'r1')]),
		isAutoMoveEnabled: vi.fn(() => options.autoMove ?? true),
		peers: vi.fn(() => peers),
		setupHost: vi.fn(async () => {
			const answer = options.setup ?? setupOk;
			// A successful setup leaves the mirror connected.
			if (answer.ok) peers = peers.map((p) => ({ ...p, connection: 'connected' as const }));
			return answer;
		}),
		lift: vi.fn(async () => liftAnswers.shift() ?? moved),
		isAgentBusy: vi.fn(() => options.busy ?? false),
		hostProviders: vi.fn(async () =>
			options.providers === undefined
				? [{ id: 'claude-code', name: 'Claude Code', available: true }]
				: options.providers
		),
		publish: vi.fn(),
		now: () => now,
		setTimer: vi.fn(() => 1),
		clearTimer: vi.fn(),
	} satisfies AutoFederationDeps;
	const coordinator = new AutoFederationCoordinator(deps);
	return {
		deps,
		coordinator,
		advance: (ms: number) => (now += ms),
		setPeers: (next: MirrorPeerSummary[]) => (peers = next),
	};
}

describe('AutoFederationCoordinator: moving SSH agents', () => {
	it('registers the service once, runs every check, and moves an idle agent', async () => {
		const w = world({});
		const snapshot = await w.coordinator.runNow({ force: false });
		expect(w.deps.setupHost).toHaveBeenCalledTimes(1);
		expect(w.deps.lift).toHaveBeenNthCalledWith(1, 'a1', { dryRun: true });
		expect(w.deps.lift).toHaveBeenNthCalledWith(2, 'a1', { dryRun: false });
		expect(snapshot.agents).toEqual([
			expect.objectContaining({ agentId: 'a1', state: 'moved', target: 'r1:h1' }),
		]);
		expect(snapshot.remotes).toEqual([
			expect.objectContaining({
				remoteId: 'r1',
				state: 'ready',
				service: expect.stringContaining('systemd'),
			}),
		]);
		// The service is ensured once per app run, not every pass.
		await w.coordinator.runNow({ force: false });
		expect(w.deps.setupHost).toHaveBeenCalledTimes(1);
		expect(w.deps.publish).toHaveBeenCalled();
	});

	it('waits while a turn runs, and moves the agent on a later pass', async () => {
		const w = world({ busy: true });
		const first = await w.coordinator.runNow({ force: false });
		expect(first.agents[0]).toMatchObject({ state: 'waiting' });
		expect(w.deps.lift).not.toHaveBeenCalled();
		w.deps.isAgentBusy.mockReturnValue(false);
		const second = await w.coordinator.runNow({ force: false });
		expect(second.agents[0]).toMatchObject({ state: 'moved' });
	});

	it('blocks when the host cannot run the provider, says how to fix it, and does not retry at once', async () => {
		const w = world({ providers: [{ id: 'claude-code', name: 'Claude Code', available: false }] });
		const snapshot = await w.coordinator.runNow({ force: false });
		expect(snapshot.agents[0]).toMatchObject({ state: 'blocked' });
		expect(snapshot.agents[0].reason).toContain('Claude Code is not available');
		expect(snapshot.agents[0].fix).toContain('Install Claude Code');
		expect(w.deps.lift).not.toHaveBeenCalled();
		await w.coordinator.runNow({ force: false });
		expect(w.deps.hostProviders).toHaveBeenCalledTimes(1);
		// After a while it is tried again.
		w.advance(BLOCKED_RETRY_MS + 1);
		await w.coordinator.runNow({ force: false });
		expect(w.deps.hostProviders).toHaveBeenCalledTimes(2);
	});

	it('skips the provider check for an agent with its own binary path', async () => {
		const w = world({
			agents: [agent('a1', 'r1', { customPath: '/opt/claude/bin/claude' } as Partial<AgentRecord>)],
			providers: [],
		});
		expect((await w.coordinator.runNow({ force: false })).agents[0].state).toBe('moved');
		expect(w.deps.hostProviders).not.toHaveBeenCalled();
	});

	it('never moves an agent whose secret env vars would stay behind', async () => {
		const w = world({ liftAnswers: [plan(['ANTHROPIC_API_KEY'])] });
		const snapshot = await w.coordinator.runNow({ force: false });
		expect(snapshot.agents[0]).toMatchObject({ state: 'blocked' });
		expect(snapshot.agents[0].reason).toContain('ANTHROPIC_API_KEY');
		expect(snapshot.agents[0].fix).toContain('Send secret env vars too');
		expect(w.deps.lift).toHaveBeenCalledTimes(1);
	});

	it('still shows a blocked agent as blocked while its retry waits, after a pass with moves off', async () => {
		const w = world({ liftAnswers: [plan(['TOKEN'])] });
		await w.coordinator.runNow({ force: false });
		w.deps.isAutoMoveEnabled.mockReturnValue(false);
		expect((await w.coordinator.runNow({ force: false })).agents[0].state).toBe('manual');
		w.deps.isAutoMoveEnabled.mockReturnValue(true);
		const snapshot = await w.coordinator.runNow({ force: false });
		expect(snapshot.agents[0]).toMatchObject({ state: 'blocked' });
		expect(snapshot.agents[0].reason).toContain('TOKEN');
	});

	it('retries a blocked agent at once when its record changes', async () => {
		const w = world({ liftAnswers: [plan(['TOKEN']), plan(), moved] });
		await w.coordinator.runNow({ force: false });
		w.deps.readAgents.mockReturnValue([
			agent('a1', 'r1', { customEnvVars: {} } as unknown as Partial<AgentRecord>),
		]);
		expect((await w.coordinator.runNow({ force: false })).agents[0].state).toBe('moved');
	});

	it('turns a dry-run refusal into a blocker, and a transient one into a wait', async () => {
		const refused = world({
			liftAnswers: [
				{
					ok: false,
					code: 'LIFT_SESSION_DIR_MISSING',
					error: 'CLAUDE_CONFIG_DIR does not exist on the host.',
				},
			],
		});
		expect((await refused.coordinator.runNow({ force: false })).agents[0]).toMatchObject({
			state: 'blocked',
			reason: 'CLAUDE_CONFIG_DIR does not exist on the host.',
		});
		const busy = world({
			liftAnswers: [{ ok: false, code: 'LIFT_BUSY', error: 'a turn is running' }],
		});
		expect((await busy.coordinator.runNow({ force: false })).agents[0].state).toBe('waiting');
	});
});

describe('AutoFederationCoordinator: keeping hosts', () => {
	it('starts a stopped host even with automatic moves off, and leaves the agents manual', async () => {
		const w = world({ autoMove: false, peers: [peer('r1', 'host-down')] });
		const snapshot = await w.coordinator.runNow({ force: false });
		expect(w.deps.setupHost).toHaveBeenCalledWith('r1');
		expect(w.deps.lift).not.toHaveBeenCalled();
		expect(snapshot.agents[0]).toMatchObject({ state: 'manual' });
		expect(snapshot.agents[0].fix).toContain('Move to Host');
	});

	it('installs only where an SSH agent wants a host, and only with automatic moves on', async () => {
		const lonely = world({ agents: [], peers: [peer('r1', 'not-installed')] });
		expect((await lonely.coordinator.runNow({ force: false })).remotes[0]).toMatchObject({
			state: 'waiting',
		});
		expect(lonely.deps.setupHost).not.toHaveBeenCalled();

		const off = world({ autoMove: false, peers: [peer('r1', 'not-installed')] });
		await off.coordinator.runNow({ force: false });
		expect(off.deps.setupHost).not.toHaveBeenCalled();

		const wanted = world({ peers: [peer('r1', 'not-installed')] });
		const snapshot = await wanted.coordinator.runNow({ force: false });
		expect(wanted.deps.setupHost).toHaveBeenCalledTimes(1);
		expect(snapshot.agents[0].state).toBe('moved');
	});

	it('blocks a remote whose setup failed with the fix, and waits before trying again', async () => {
		const w = world({
			peers: [peer('r1', 'not-installed')],
			setup: { ok: false, code: 'node-download', error: 'Could not download Node.js on r1.' },
		});
		const snapshot = await w.coordinator.runNow({ force: false });
		expect(snapshot.remotes[0]).toMatchObject({
			state: 'blocked',
			reason: 'Could not download Node.js on r1.',
		});
		expect(snapshot.remotes[0].fix).toContain('nodejs.org');
		expect(snapshot.agents[0]).toMatchObject({ state: 'blocked' });
		await w.coordinator.runNow({ force: false });
		expect(w.deps.setupHost).toHaveBeenCalledTimes(1);
		w.advance(SETUP_RETRY_MS + 1);
		await w.coordinator.runNow({ force: false });
		expect(w.deps.setupHost).toHaveBeenCalledTimes(2);
	});

	it('never replaces an older running host on its own, but still moves agents onto it', async () => {
		const w = world({ setup: { ok: false, code: 'host-running', error: 'A host is running.' } });
		const snapshot = await w.coordinator.runNow({ force: false });
		expect(snapshot.remotes[0]).toMatchObject({ state: 'ready' });
		expect(snapshot.remotes[0].fix).toContain('--restart');
		expect(snapshot.agents[0].state).toBe('moved');
	});

	it('marks a required service fix as needing you, and keeps it across a reconnect', async () => {
		const w = world({
			setup: {
				ok: true,
				result: {
					cli: 'current',
					service: { kind: 'none', reason: 'enable-failed', fix: 'Use Task Scheduler.' },
				},
			},
		});
		expect((await w.coordinator.runNow({ force: false })).remotes[0]).toMatchObject({
			state: 'ready',
			needsYou: true,
			fix: 'Use Task Scheduler.',
		});
		w.setPeers([peer('r1', 'reconnecting')]);
		const away = await w.coordinator.runNow({ force: false });
		expect(away.remotes[0].service).toContain('No service');
		w.setPeers([peer('r1', 'connected')]);
		expect((await w.coordinator.runNow({ force: false })).remotes[0]).toMatchObject({
			needsYou: true,
			fix: 'Use Task Scheduler.',
		});
		expect(w.deps.setupHost).toHaveBeenCalledTimes(1);
	});

	it('retries a failed setup at once when the remote connection settings change', async () => {
		const w = world({
			peers: [peer('r1', 'not-installed')],
			setup: { ok: false, code: 'ssh-failed', error: 'Permission denied (publickey).' },
		});
		await w.coordinator.runNow({ force: false });
		w.deps.readRemotes.mockReturnValue([remote('r1', { privateKeyPath: '~/.ssh/fixed' })]);
		await w.coordinator.runNow({ force: false });
		expect(w.deps.setupHost).toHaveBeenCalledTimes(2);
	});

	it('passes the lingering fix on as the one thing to do', async () => {
		const w = world({
			setup: {
				ok: true,
				result: {
					cli: 'current',
					service: {
						kind: 'systemd',
						state: 'active',
						linger: false,
						lingerFix: 'sudo loginctl enable-linger pedram',
					},
				},
			},
		});
		expect((await w.coordinator.runNow({ force: false })).remotes[0].fix).toContain(
			'sudo loginctl enable-linger pedram'
		);
	});

	it('never touches a remote that opted out or is disabled', async () => {
		const w = world({
			remotes: [remote('r1', { federation: false }), remote('r2', { enabled: false })],
			agents: [agent('a1', 'r1'), agent('a2', 'r2')],
			peers: [],
		});
		const snapshot = await w.coordinator.runNow({ force: false });
		expect(w.deps.setupHost).not.toHaveBeenCalled();
		expect(w.deps.lift).not.toHaveBeenCalled();
		expect(snapshot.agents.map((a) => a.state)).toEqual(['manual', 'manual']);
		expect(snapshot.remotes).toEqual([]);
	});

	it('leaves an agent that already moved alone', async () => {
		const w = world({
			agents: [agent('a1', 'r1', { liftedTo: { peer: 'r1', agentId: 'h1', at: 1 } })],
		});
		const snapshot = await w.coordinator.runNow({ force: false });
		expect(w.deps.lift).not.toHaveBeenCalled();
		expect(snapshot.agents).toEqual([]);
	});
});

describe('AutoFederationCoordinator: review fixes', () => {
	it('waits instead of moving when the host does not answer which providers it runs', async () => {
		const w = world({ providers: null });
		expect((await w.coordinator.runNow({ force: false })).agents[0]).toMatchObject({
			state: 'waiting',
		});
		expect(w.deps.lift).not.toHaveBeenCalled();
	});

	it('reads the setting again before each move', async () => {
		const w = world({ agents: [agent('a1', 'r1'), agent('a2', 'r1')] });
		// Switched off while the first agent moves.
		w.deps.lift.mockImplementation(async (_id: string, options: { dryRun: boolean }) => {
			if (!options.dryRun) w.deps.isAutoMoveEnabled.mockReturnValue(false);
			return options.dryRun ? plan() : moved;
		});
		const snapshot = await w.coordinator.runNow({ force: false });
		expect(snapshot.agents.map((a) => a.state)).toEqual(['moved', 'manual']);
	});

	it('keeps a failed service setup on a connected host eligible for a later retry', async () => {
		const w = world({ setup: { ok: false, code: 'ssh-failed', error: 'Connection reset.' } });
		expect((await w.coordinator.runNow({ force: false })).remotes[0]).toMatchObject({
			state: 'blocked',
		});
		await w.coordinator.runNow({ force: false });
		expect(w.deps.setupHost).toHaveBeenCalledTimes(1);
		w.advance(SETUP_RETRY_MS + 1);
		await w.coordinator.runNow({ force: false });
		expect(w.deps.setupHost).toHaveBeenCalledTimes(2);
	});

	it('keeps the schedule going after Run Now', async () => {
		const w = world({});
		await w.coordinator.runNow({ force: false });
		expect(w.deps.setTimer).toHaveBeenCalledTimes(1);
	});

	it('Run Now during a pass waits for a pass that started after it asked', async () => {
		const w = world({});
		let release: () => void = () => undefined;
		w.deps.setupHost.mockImplementationOnce(
			() =>
				new Promise<DesktopSetupHostAnswer>((resolve) => {
					release = () => resolve(setupOk);
				})
		);
		const first = w.coordinator.runNow({ force: false });
		await Promise.resolve();
		let secondDone = false;
		const second = w.coordinator.runNow({ force: false }).then((snapshot) => {
			secondDone = true;
			return snapshot;
		});
		await Promise.resolve();
		expect(secondDone).toBe(false);
		release();
		await first;
		const snapshot = await second;
		expect(snapshot.running).toBe(false);
		expect(snapshot.agents[0].state).toBe('moved');
	});
});

describe('AutoFederationCoordinator: Run Now', () => {
	it('retries a blocked agent and a failed setup at once when a person asks', async () => {
		const w = world({ providers: [{ id: 'claude-code', name: 'Claude Code', available: false }] });
		await w.coordinator.runNow({ force: false });
		expect(w.deps.hostProviders).toHaveBeenCalledTimes(1);
		// The person installed it, then asked.
		w.deps.hostProviders.mockResolvedValue([
			{ id: 'claude-code', name: 'Claude Code', available: true },
		]);
		expect((await w.coordinator.runNow()).agents[0].state).toBe('moved');

		const s = world({
			peers: [peer('r1', 'not-installed')],
			setup: { ok: false, code: 'node-download', error: 'No Node.' },
		});
		await s.coordinator.runNow({ force: false });
		await s.coordinator.runNow();
		expect(s.deps.setupHost).toHaveBeenCalledTimes(2);
	});

	it('keeps a service workaround for a remote that can never have one as a note, not a blocker', async () => {
		const w = world({
			setup: {
				ok: true,
				result: {
					cli: 'current',
					service: { kind: 'none', reason: 'desktop-app', fix: 'Keep the app open.' },
				},
			},
		});
		const remoteStatus = (await w.coordinator.runNow()).remotes[0];
		expect(remoteStatus).toMatchObject({ state: 'ready', fix: 'Keep the app open.' });
		expect(remoteStatus.needsYou).toBeUndefined();
	});
});

describe('AutoFederationCoordinator: scheduling', () => {
	it('debounces nudges into one pass and stops cleanly', () => {
		const w = world({});
		w.coordinator.nudge();
		w.coordinator.nudge();
		expect(w.deps.setTimer).toHaveBeenCalledTimes(2);
		expect(w.deps.clearTimer).toHaveBeenCalled();
		w.coordinator.stop();
		w.coordinator.nudge();
		expect(w.deps.setTimer).toHaveBeenCalledTimes(2);
	});
});
