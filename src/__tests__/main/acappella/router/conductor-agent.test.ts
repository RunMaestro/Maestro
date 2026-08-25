/**
 * @file conductor-agent.test.ts
 *
 * The Conductor run as a real agent: the busy refusal, the deadline, and the
 * SSH rule that a configured remote which cannot be resolved is a loud failure
 * rather than a quiet local run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../main/utils/ssh-spawn-wrapper', () => ({ wrapSpawnWithSsh: vi.fn() }));
vi.mock('../../../../main/prompt-manager', () => ({
	getPrompt: () => {
		throw new Error('prompts not initialised');
	},
}));

import { wrapSpawnWithSsh } from '../../../../main/utils/ssh-spawn-wrapper';
import {
	createConductorAgentBrain,
	type ConductorProcessManager,
} from '../../../../main/acappella/router/conductor-agent';
import { VoiceProviderError } from '../../../../shared/acappella/provider-errors';
import type { VoiceRouteContext } from '../../../../shared/acappella/providers';

const CONTEXT: VoiceRouteContext = {
	roster: [
		{
			sessionId: 'agent-backend',
			name: 'Backend',
			agentType: 'claude-code',
			cwd: '/repo/api',
			tabs: [{ id: 'tab-auth', name: 'Auth', lastActiveAt: 1 }],
		},
	],
	scope: { kind: 'conductor' },
};

const DECISION_JSON = JSON.stringify({
	target: { sessionId: 'agent-backend' },
	tabAction: 'current',
	prompt: 'run the tests',
	confidence: 0.9,
});

/** A process manager that replays one scripted response per spawn. */
function fakeProcessManager(script: { output?: string; exits?: boolean; spawns?: boolean } = {}) {
	const handlers = new Map<string, Array<(...args: any[]) => void>>();
	const spawned: Array<Record<string, unknown>> = [];
	const killed: string[] = [];

	const emit = (event: string, ...args: unknown[]): void => {
		for (const handler of handlers.get(event) ?? []) handler(...args);
	};

	const manager: ConductorProcessManager = {
		spawn(config) {
			spawned.push(config);
			if (script.spawns === false) return null;
			// Asynchronous, like the real thing: the collector must have attached
			// its listeners before anything arrives.
			setTimeout(() => {
				if (script.output) emit('data', config.sessionId, script.output);
				if (script.exits !== false) emit('exit', config.sessionId, 0);
			}, 0);
			return { pid: 1234 };
		},
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		off(event, handler) {
			handlers.set(
				event,
				(handlers.get(event) ?? []).filter((entry) => entry !== handler)
			);
		},
		kill(sessionId) {
			killed.push(sessionId);
		},
	};

	return { manager, spawned, killed, listenerCount: () => (handlers.get('data') ?? []).length };
}

function agentDetector(available = true) {
	return {
		getAgent: vi.fn(async () => ({
			id: 'claude-code',
			command: 'claude',
			binaryName: 'claude',
			args: ['--print'],
			available,
			promptArgs: undefined,
			noPromptSeparator: false,
		})),
	} as never;
}

function makeBrain(
	script: Parameters<typeof fakeProcessManager>[0] = { output: DECISION_JSON },
	overrides: Record<string, unknown> = {}
) {
	const process = fakeProcessManager(script);
	const brain = createConductorAgentBrain({
		processManager: process.manager,
		agentDetector: agentDetector(),
		agentType: 'claude-code',
		cwd: '/repo/api',
		timeoutMs: 50,
		...overrides,
	});
	return { brain, ...process };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('ConductorAgentBrain - routing', () => {
	it('spawns read-only and parses the decision through the shared schema', async () => {
		const { brain, spawned } = makeBrain();

		const decision = await brain.route('run the tests', CONTEXT);

		expect(decision).toMatchObject({
			target: { sessionId: 'agent-backend' },
			tabAction: 'current',
			confidence: 0.9,
		});
		// A router reads; it does not edit, and read-only also means no workspace
		// lock, so the Conductor can think while its agents work.
		expect(spawned[0]).toMatchObject({ readOnlyMode: true, toolType: 'claude-code' });
	});

	it('validates a hallucinated id away rather than returning it', async () => {
		const { brain } = makeBrain({
			output: JSON.stringify({
				target: { sessionId: 'agent-ghost' },
				tabAction: 'current',
				prompt: 'x',
				confidence: 0.9,
			}),
		});

		const decision = await brain.route('run the tests', CONTEXT);

		expect(decision.target).toBe('conductor');
	});

	it('drops its listeners once the run is over', async () => {
		const { brain, listenerCount } = makeBrain();

		await brain.route('run the tests', CONTEXT);

		expect(listenerCount()).toBe(0);
	});
});

describe('ConductorAgentBrain - never blocks the floor', () => {
	it('refuses a second turn while one is in flight, out loud', async () => {
		const { brain } = makeBrain();

		const first = brain.route('run the tests', CONTEXT);
		const second = brain.route('and the linter', CONTEXT);

		await expect(second).rejects.toThrow(/Conductor is busy/);
		await first;
		// The refusal is recoverable: wait, then say it again.
		await expect(brain.route('and the linter', CONTEXT)).resolves.toBeTruthy();
	});

	it('kills the process when the deadline passes', async () => {
		const { brain, killed } = makeBrain({ exits: false });

		await expect(brain.route('run the tests', CONTEXT)).rejects.toThrow(/did not answer in time/);
		// An abandoned agent left running still holds a model and a token budget.
		expect(killed).toHaveLength(1);
	});

	it('reports a spawn that never started', async () => {
		const { brain } = makeBrain({ spawns: false });

		await expect(brain.route('run the tests', CONTEXT)).rejects.toThrow(/could not be started/);
	});

	it('reports an unavailable agent as a provider failure', async () => {
		const { manager } = fakeProcessManager();
		const brain = createConductorAgentBrain({
			processManager: manager,
			agentDetector: agentDetector(false),
			agentType: 'claude-code',
			cwd: '/repo/api',
		});

		await expect(brain.route('run the tests', CONTEXT)).rejects.toThrow(VoiceProviderError);
	});
});

describe('ConductorAgentBrain - SSH', () => {
	it('wraps the spawn when a remote is configured', async () => {
		vi.mocked(wrapSpawnWithSsh).mockResolvedValue({
			command: 'ssh',
			args: ['host', 'claude'],
			cwd: '/remote/api',
			prompt: 'hello',
			customEnvVars: {},
			sshRemoteUsed: { id: 'remote-1', name: 'box' } as never,
		} as never);

		const { brain, spawned } = makeBrain(
			{ output: DECISION_JSON },
			{
				sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				sshStore: {} as never,
			}
		);

		await brain.route('run the tests', CONTEXT);

		expect(wrapSpawnWithSsh).toHaveBeenCalled();
		expect(spawned[0]).toMatchObject({
			command: 'ssh',
			cwd: '/remote/api',
			sshRemoteId: 'remote-1',
		});
	});

	it('fails loudly when the remote cannot be resolved, rather than running locally', async () => {
		vi.mocked(wrapSpawnWithSsh).mockResolvedValue({
			command: 'claude',
			args: [],
			cwd: '/repo/api',
			sshRemoteUsed: null,
		} as never);

		const { brain, spawned } = makeBrain(
			{ output: DECISION_JSON },
			{ sshRemoteConfig: { enabled: true, remoteId: 'gone' }, sshStore: {} as never }
		);

		await expect(brain.route('run the tests', CONTEXT)).rejects.toThrow(/could not be resolved/);
		// The user opted into a remote. A routing prompt carries the names and paths
		// of everything they have open, so it must not run here instead.
		expect(spawned).toHaveLength(0);
	});

	it('fails loudly when SSH is enabled with no store to resolve it', async () => {
		const { brain, spawned } = makeBrain(
			{ output: DECISION_JSON },
			{ sshRemoteConfig: { enabled: true, remoteId: 'remote-1' } }
		);

		await expect(brain.route('run the tests', CONTEXT)).rejects.toThrow(/could not be resolved/);
		expect(spawned).toHaveLength(0);
	});

	it('does not touch the SSH wrapper when no remote is configured', async () => {
		const { brain } = makeBrain();

		await brain.route('run the tests', CONTEXT);

		expect(wrapSpawnWithSsh).not.toHaveBeenCalled();
	});
});
