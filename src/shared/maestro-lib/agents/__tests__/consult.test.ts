import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrossAgentRequest, CrossAgentResponseChunk } from '../../../crossAgentTypes';
import type { GroupChatSpawn } from '../../groupchat/types';
import {
	buildAgentMentionSuggestions,
	planMentions,
	type MentionableAgent,
	type MentionableGroup,
} from '../../mentions/roster';
import type { AgentConfig } from '../../providers/definitions';
import {
	CROSS_AGENT_IDLE_TIMEOUT_MS,
	CROSS_AGENT_MAX_DURATION_MS,
	createConsultService,
	type ConsultObserver,
	type ConsultRunner,
	type CrossAgentTargetSession,
} from '../consult';

const IDLE_MS = CROSS_AGENT_IDLE_TIMEOUT_MS;
const HARD_MS = CROSS_AGENT_MAX_DURATION_MS;

function request(overrides: Partial<CrossAgentRequest> = {}): CrossAgentRequest {
	return {
		requestId: 'r1',
		sourceSessionId: 'src',
		sourceTabId: 'tab',
		targetSessionId: 'tgt',
		userPrompt: 'What is your take?',
		transcript: [],
		strategy: { kind: 'full' },
		createdAt: 0,
		...overrides,
	};
}

const targetSession = (
	overrides: Partial<CrossAgentTargetSession> = {}
): CrossAgentTargetSession => ({
	id: 'tgt',
	name: 'Maestro Marketing',
	toolType: 'claude-code',
	cwd: '/proj',
	...overrides,
});

/** Mirrors the real claude-code definition: both permission branches must exist or the flag assertions pass vacuously. */
const claudeAgent = (): AgentConfig =>
	({
		id: 'claude-code',
		name: 'Claude Code',
		command: 'claude',
		path: 'claude',
		args: [],
		available: true,
		fullAccessArgs: ['--dangerously-skip-permissions'],
		readOnlyArgs: ['--permission-mode', 'plan'],
		readOnlyCliEnforced: true,
		resumeArgs: (id: string) => ['--resume', id],
	}) as unknown as AgentConfig;

/** A runner the test drives by hand: it records spawns and stops, and the test reports activity and the end. */
class FakeRunner implements ConsultRunner {
	spawns: GroupChatSpawn[] = [];
	stopped: string[] = [];
	observer: ConsultObserver | undefined;
	/** What `stop` answers: the partial output a killed process had produced. */
	partial = '';
	result: { success: boolean; pid?: number } = { success: true, pid: 123 };
	hold: Promise<void> | undefined;

	async start(spawn: GroupChatSpawn, observer: ConsultObserver) {
		this.spawns.push(spawn);
		this.observer = observer;
		if (this.hold) await this.hold;
		return this.result;
	}

	stop(processId: string): string {
		this.stopped.push(processId);
		return this.partial;
	}

	activity() {
		this.observer?.onActivity();
	}
	session(id: string) {
		this.observer?.onSessionId(id);
	}
	end(exitCode: number | null, text: string) {
		this.observer?.onEnd({ exitCode, readText: () => text });
	}
}

function harness(
	overrides: {
		getTargetSession?: () => CrossAgentTargetSession | null;
		writable?: boolean;
		resolveAgent?: () => Promise<AgentConfig | null>;
		sshStore?: unknown;
		request?: Partial<CrossAgentRequest>;
	} = {}
) {
	const service = createConsultService();
	const runner = new FakeRunner();
	const chunks: CrossAgentResponseChunk[] = [];
	const dispatch = (req: CrossAgentRequest = request(overrides.request)) =>
		service.start(req, {
			runner,
			resolveAgent: overrides.resolveAgent ?? (async () => claudeAgent()),
			sshStore: (overrides.sshStore ?? null) as never,
			getTargetSession: overrides.getTargetSession ?? (() => targetSession()),
			writable: overrides.writable,
			onChunk: (c) => chunks.push(c),
		});
	return { service, runner, chunks, dispatch };
}

describe('the consult service launch', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('spawns the consult read-only and caps maestro-p idle wait to the idle budget', async () => {
		const { dispatch, runner } = harness();
		await dispatch();

		const spawn = runner.spawns[0];
		// The consult prompt promises the target it will not write; the spawn is what actually enforces it.
		expect(spawn.readOnlyMode).toBe(true);
		expect(spawn.args).toEqual(expect.arrayContaining(['--permission-mode', 'plan']));
		expect(spawn.args).not.toContain('--dangerously-skip-permissions');
		expect(spawn.maxWaitSeconds).toBe(IDLE_MS / 1000);
	});

	it('spawns a writable delegation with FULL access, not merely "not read-only"', async () => {
		const { dispatch, runner } = harness({ writable: true });
		await dispatch();

		const spawn = runner.spawns[0];
		expect(spawn.readOnlyMode).toBe(false);
		// Turning read-only OFF selects buildAgentArgs' standard branch, which emits no permission
		// flags and leaves the agent on its interactive default. A `--print` run has no approver, so
		// the first write tool call blocks forever while the prompt has already said it may write.
		expect(spawn.args).toContain('--dangerously-skip-permissions');
		expect(spawn.args).not.toContain('plan');
	});

	it('tells the target which mode it is in, matching how it is spawned', async () => {
		const readOnly = harness({ request: { sourceCwd: '/p' } });
		await readOnly.dispatch();
		expect(readOnly.runner.spawns[0].prompt).toContain('READ-ONLY consultation');

		const writable = harness({ writable: true, request: { sourceCwd: '/p' } });
		await writable.dispatch();
		expect(writable.runner.spawns[0].prompt).toContain('DELEGATION');
	});

	it('runs under the ephemeral cross-agent process id, in the target cwd, as the target provider', async () => {
		const { dispatch, runner } = harness();
		await dispatch();

		expect(runner.spawns[0]).toMatchObject({
			processId: 'cross-agent-r1',
			providerId: 'claude-code',
			cwd: '/proj',
			debugLabel: 'cross-agent:Maestro Marketing',
		});
	});

	it('spawns the binary the agent is configured with, not the auto-detected one', async () => {
		// Detection probes known install dirs before PATH, so a stale nvm stub can win over the codex
		// the user pointed the agent at. The tab honors customPath; the consult must too.
		const { dispatch, runner } = harness({
			getTargetSession: () => targetSession({ customPath: '/opt/custom/claude' }),
		});
		await dispatch();
		expect(runner.spawns[0].command).toBe('/opt/custom/claude');
	});

	it('falls back to the detected binary when the agent has no customPath', async () => {
		const { dispatch, runner } = harness();
		await dispatch();
		expect(runner.spawns[0].command).toBe('claude');
	});

	it('folds a per-session context window into a copy of the agent config', async () => {
		const shared = { model: 'm' };
		const service = createConsultService();
		const runner = new FakeRunner();
		await service.start(request(), {
			runner,
			resolveAgent: async () => claudeAgent(),
			sshStore: null,
			getTargetSession: () => targetSession({ customContextWindow: 123_000 }),
			getAgentConfig: () => shared,
			onChunk: () => {},
		});
		expect(runner.spawns[0].agentConfigValues).toEqual({ model: 'm', contextWindow: 123_000 });
		expect(shared).toEqual({ model: 'm' });
	});

	it('forwards the target resume id so the target keeps memory of earlier consults', async () => {
		const { dispatch, runner } = harness({ request: { resumeAgentSessionId: 'sess-old' } });
		await dispatch();
		expect(runner.spawns[0].args).toEqual(expect.arrayContaining(['--resume', 'sess-old']));
	});
});

describe('the consult service refusals', () => {
	it('reports a missing target as one terminal error chunk, and starts nothing', async () => {
		const { dispatch, runner, chunks } = harness({ getTargetSession: () => null });
		await dispatch();

		expect(runner.spawns).toHaveLength(0);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({ done: true, targetAgentName: 'tgt' });
		expect(chunks[0].error).toContain('Target agent not found');
	});

	it('refuses an SSH target whose remote cannot be resolved instead of running it locally', async () => {
		const { dispatch, runner, chunks } = harness({
			getTargetSession: () =>
				targetSession({ sshRemoteConfig: { enabled: true, remoteId: 'gone' } }),
		});
		await dispatch();

		expect(runner.spawns).toHaveLength(0);
		expect(chunks[0].error).toContain('SSH remote could not be resolved');
	});

	it('forwards the SSH config to the runner when the remote store exists', async () => {
		const ssh = { enabled: true, remoteId: 'r1' };
		const { dispatch, runner } = harness({
			sshStore: {},
			getTargetSession: () => targetSession({ sshRemoteConfig: ssh }),
		});
		await dispatch();
		expect(runner.spawns[0].sshRemoteConfig).toEqual(ssh);
	});

	it('names an agent that is not installed', async () => {
		const { dispatch, runner, chunks } = harness({ resolveAgent: async () => null });
		await dispatch();

		expect(runner.spawns).toHaveLength(0);
		expect(chunks[0]).toMatchObject({ done: true });
		expect(chunks[0].error).toContain('is not available');
	});
});

describe('the consult service completion rule', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('answers with the text and the captured provider session on a clean exit', async () => {
		const { dispatch, runner, chunks } = harness();
		await dispatch();
		runner.session('prov-sess-1');
		runner.end(0, '  the answer  ');

		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({
			chunk: 'the answer',
			done: true,
			targetAgentSessionId: 'prov-sess-1',
		});
		expect(chunks[0].error).toBeUndefined();
	});

	it('keeps the resume id the request carried when the target announces none', async () => {
		const { dispatch, runner, chunks } = harness({ request: { resumeAgentSessionId: 'sess-old' } });
		await dispatch();
		runner.end(0, 'ok');
		expect(chunks[0].targetAgentSessionId).toBe('sess-old');
	});

	it('stamps a non-zero exit as a failure but keeps what the agent said (B17)', async () => {
		const { dispatch, runner, chunks } = harness();
		await dispatch();
		runner.session('prov-sess-1');
		runner.end(1, 'partial words');

		expect(chunks[0]).toMatchObject({ chunk: 'partial words', done: true });
		expect(chunks[0].error).toBe('Maestro Marketing exited with code 1.');
		// A run that errored must never seed a resume id for the next consult (B18).
		expect(chunks[0].targetAgentSessionId).toBeUndefined();
	});

	it('reports no visible output for an empty exit, clean or not', async () => {
		const clean = harness();
		await clean.dispatch();
		clean.runner.end(0, '   ');
		expect(clean.chunks[0].error).toContain('produced no visible output (exit code 0)');

		const failed = harness();
		await failed.dispatch();
		failed.runner.end(2, '');
		expect(failed.chunks[0].error).toContain('produced no visible output (exit code 2)');
	});

	it('turns an unparseable stream into a single error chunk', async () => {
		const { dispatch, runner, chunks } = harness();
		await dispatch();
		runner.observer?.onEnd({
			exitCode: 0,
			readText: () => {
				throw new Error('stream was torn');
			},
		});

		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({ done: true, error: 'stream was torn' });
	});

	it('settles once: a timeout after the end does not emit a second chunk', async () => {
		const { dispatch, runner, chunks } = harness();
		await dispatch();
		runner.end(0, 'the answer');
		vi.advanceTimersByTime(HARD_MS * 2);

		expect(chunks).toHaveLength(1);
		expect(chunks[0].chunk).toBe('the answer');
		expect(runner.stopped).toEqual([]);
	});
});

describe('the consult service supervision', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('does not stop a target that keeps reporting activity past the idle budget', async () => {
		const { dispatch, runner, chunks } = harness();
		await dispatch();

		// Nine minutes of silence, a sign of life, then nine more: a wall-clock budget would have
		// fired by now. The idle budget must not.
		vi.advanceTimersByTime(IDLE_MS - 60_000);
		runner.activity();
		vi.advanceTimersByTime(IDLE_MS - 60_000);

		expect(chunks).toHaveLength(0);
		expect(runner.stopped).toEqual([]);
	});

	it('stops a target that is truly wedged and says it went silent', async () => {
		const { dispatch, runner, chunks } = harness();
		await dispatch();
		vi.advanceTimersByTime(IDLE_MS);

		expect(runner.stopped).toEqual(['cross-agent-r1']);
		expect(chunks).toHaveLength(1);
		expect(chunks[0].error).toContain('went silent for 10 minutes');
	});

	it('flushes what the target had said when it is stopped for silence', async () => {
		const { dispatch, runner, chunks } = harness();
		await dispatch();
		runner.partial = '  half an answer ';
		runner.session('prov-sess-1');
		vi.advanceTimersByTime(IDLE_MS);

		expect(chunks[0].chunk).toBe('half an answer');
		expect(chunks[0].done).toBe(true);
		expect(chunks[0].error).toContain('went silent');
		// A killed run must not seed a resume id for the next consult.
		expect(chunks[0].targetAgentSessionId).toBeUndefined();
	});

	it('stops a chattering target at the hard ceiling even though it never idles', async () => {
		const { dispatch, runner, chunks } = harness();
		await dispatch();

		// Activity every five minutes forever: the idle timer never fires.
		for (let elapsed = 0; elapsed < HARD_MS; elapsed += 5 * 60 * 1000) {
			vi.advanceTimersByTime(5 * 60 * 1000);
			runner.activity();
		}

		expect(chunks).toHaveLength(1);
		expect(chunks[0].error).toContain('exceeded the 30-minute limit');
	});

	it('fails fast when the runner refuses the start, and arms no late chunk', async () => {
		const { dispatch, runner, chunks } = harness();
		runner.result = { success: false, pid: -1 };
		await dispatch();

		// A refused start emits no end. Without an explicit check the user waits out the full budget
		// for a process that never existed, so the error lands before any timer advances.
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({ done: true });
		expect(chunks[0].error).toContain('could not be started');
		vi.advanceTimersByTime(HARD_MS * 2);
		expect(chunks).toHaveLength(1);
		// The runner detaches by itself on a refused start; the service has nothing to kill.
		expect(runner.stopped).toEqual([]);
	});

	it('turns a runner that throws into one error chunk and disarms the budgets', async () => {
		const { dispatch, runner, chunks } = harness();
		runner.start = async () => {
			throw new Error('spawn exploded');
		};
		await dispatch();

		expect(chunks).toHaveLength(1);
		expect(chunks[0].error).toBe('spawn exploded');
		vi.advanceTimersByTime(HARD_MS * 2);
		expect(chunks).toHaveLength(1);
	});
});

/**
 * Stop is an AGENT-level action, and a `@mention` fans one turn out across an ephemeral
 * `cross-agent-*` process per consulted target. None of those carry the source agent's process id,
 * so cancellation is addressed by SOURCE agent.
 */
describe('cancelForSource', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('stops a running consult and settles it as canceled, not as a failure', async () => {
		const { service, dispatch, runner, chunks } = harness();
		await dispatch();
		runner.partial = 'half an answer';

		expect(service.cancelForSource('src')).toBe(1);

		expect(runner.stopped).toEqual(['cross-agent-r1']);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({ done: true, canceled: true, chunk: 'half an answer' });
		// The user stopping a consult is not the target failing to answer.
		expect(chunks[0].error).toBeUndefined();
	});

	it('leaves consults belonging to another source agent alone', async () => {
		const { service, dispatch, runner, chunks } = harness();
		await dispatch();

		expect(service.cancelForSource('some-other-agent')).toBe(0);
		expect(runner.stopped).toEqual([]);
		expect(chunks).toHaveLength(0);
	});

	it('is a no-op for a consult that already finished', async () => {
		const { service, dispatch, runner, chunks } = harness();
		await dispatch();
		runner.end(0, 'the answer');

		expect(service.cancelForSource('src')).toBe(0);
		expect(chunks).toHaveLength(1);
		expect(chunks[0].canceled).toBeUndefined();
		expect(service.activeCount()).toBe(0);
	});

	it('settles only once when Stop is pressed twice, and emits nothing late', async () => {
		const { service, dispatch, chunks } = harness();
		await dispatch();

		service.cancelForSource('src');
		service.cancelForSource('src');
		vi.advanceTimersByTime(HARD_MS * 2);

		expect(chunks).toHaveLength(1);
	});

	it('cancels a consult that has not reached the spawn yet', async () => {
		// Stop can land while the target agent's binary is still being resolved. The consult is
		// registered before that await precisely so this lands.
		const { service, dispatch, runner, chunks } = harness();
		const pending = dispatch();

		expect(service.cancelForSource('src')).toBe(1);
		await pending;

		expect(runner.spawns).toHaveLength(0);
		expect(chunks).toHaveLength(1);
		expect(chunks[0].canceled).toBe(true);
	});

	it('stops a process that finished starting after the Stop that ended it', async () => {
		// Stop lands once the supervision is armed but while the start is still in flight. The
		// terminal path already stopped a process id that did not exist yet, so the one that arrives
		// a moment later has to be stopped on the way out or it outlives its own Stop.
		const { service, dispatch, runner, chunks } = harness();
		let release: () => void = () => {};
		runner.hold = new Promise<void>((resolve) => {
			release = resolve;
		});

		const pending = dispatch();
		await vi.waitFor(() => expect(runner.spawns).toHaveLength(1));
		expect(service.cancelForSource('src')).toBe(1);
		runner.stopped.length = 0;

		release();
		await pending;

		expect(runner.stopped).toEqual(['cross-agent-r1']);
		// Still exactly one terminal chunk - the late start must not produce a second.
		expect(chunks).toHaveLength(1);
		expect(chunks[0].canceled).toBe(true);
	});
});

describe('two services', () => {
	it("keep separate registries, so one host cannot cancel another host's consults", async () => {
		const first = harness();
		const second = harness();
		await first.dispatch();

		expect(second.service.cancelForSource('src')).toBe(0);
		expect(first.service.activeCount()).toBe(1);
		first.runner.end(0, 'done');
	});
});

describe('a group is never a consult target (XM-1)', () => {
	const agents: MentionableAgent[] = [
		{ id: 'src', name: 'Frontend', toolType: 'claude-code' },
		{ id: 'be', name: 'Backend', toolType: 'claude-code', groupId: 'g-core' },
		{ id: 'docs', name: 'Docs Writer', toolType: 'codex', groupId: 'g-core' },
	];
	const groups: MentionableGroup[] = [{ id: 'g-core', name: 'Core' }];

	it('consults each member of an expanded group once, and the group name alone consults nobody', async () => {
		const expanded = buildAgentMentionSuggestions(agents, groups, 'src')[0]!.memberMentionValue!;
		const plan = planMentions(`${expanded}review this`, agents, groups, 'src')!;
		expect(plan.targetAgentIds).toEqual(['be', 'docs']);
		expect(planMentions('@Core review this', agents, groups, 'src')).toBeNull();

		const service = createConsultService();
		const runner = new FakeRunner();
		const asked: string[] = [];
		await Promise.all(
			plan.targetAgentIds.map((id, index) =>
				service.start(request({ requestId: `r${index}`, targetSessionId: id }), {
					runner,
					resolveAgent: async () => claudeAgent(),
					sshStore: null,
					getTargetSession: (sessionId) => {
						asked.push(sessionId);
						return targetSession({ id: sessionId, name: sessionId });
					},
					onChunk: () => {},
				})
			)
		);

		expect(asked).toEqual(['be', 'docs']);
		expect(runner.spawns.map((spawn) => spawn.processId)).toEqual([
			'cross-agent-r0',
			'cross-agent-r1',
		]);
	});
});

/**
 * `cancel` is Stop addressed by request id: for a host that waits for the answer and gives up
 * after a time it was told, so it can end one consult without ending the asking agent's others.
 */
describe('cancel', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('stops one consult by its id and settles it as canceled', async () => {
		const { service, dispatch, runner, chunks } = harness();
		await dispatch();
		runner.partial = 'so far';

		expect(service.cancel('r1')).toBe(true);

		expect(runner.stopped).toEqual(['cross-agent-r1']);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({ done: true, canceled: true, chunk: 'so far' });
		expect(service.activeCount()).toBe(0);
	});

	it('leaves other consults, even from the same source, running', async () => {
		const a = harness({ request: { requestId: 'r1' } });
		await a.dispatch();
		// A second consult on the same service shares its registry.
		const runner2 = new FakeRunner();
		const chunks2: CrossAgentResponseChunk[] = [];
		await a.service.start(request({ requestId: 'r2' }), {
			runner: runner2,
			resolveAgent: async () => claudeAgent(),
			sshStore: null,
			getTargetSession: () => targetSession(),
			onChunk: (c) => chunks2.push(c),
		});

		expect(a.service.cancel('r1')).toBe(true);

		expect(runner2.stopped).toEqual([]);
		expect(chunks2).toEqual([]);
		expect(a.service.activeCount()).toBe(1);
	});

	it('cancelAll stops every consult in flight, whoever asked, and answers how many', async () => {
		const first = harness({ request: { requestId: 'r1', sourceSessionId: 'src-1' } });
		await first.dispatch();
		const runner2 = new FakeRunner();
		const chunks2: CrossAgentResponseChunk[] = [];
		await first.service.start(request({ requestId: 'r2', sourceSessionId: 'src-2' }), {
			runner: runner2,
			resolveAgent: async () => claudeAgent(),
			sshStore: null,
			getTargetSession: () => targetSession(),
			onChunk: (c) => chunks2.push(c),
		});

		expect(first.service.cancelAll()).toBe(2);

		expect(first.chunks[0]).toMatchObject({ done: true, canceled: true });
		expect(chunks2[0]).toMatchObject({ done: true, canceled: true });
		expect(first.service.activeCount()).toBe(0);
		expect(first.service.cancelAll()).toBe(0);
	});

	it('answers false for an id that is not in flight, or one that already finished', async () => {
		const { service, dispatch, runner } = harness();
		expect(service.cancel('nope')).toBe(false);
		await dispatch();
		runner.end(0, 'done');
		expect(service.cancel('r1')).toBe(false);
	});
});
