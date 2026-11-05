import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import {
	startCrossAgentRequest,
	cancelCrossAgentRequestsForSource,
	CROSS_AGENT_SESSION_PREFIX,
	buildCrossAgentPrompt,
	serializeTranscript,
	getCrossAgentConsultParties,
	type CrossAgentTargetSession,
} from '../../main/cross-agent/cross-agent-router';
import type { CrossAgentRequest, CrossAgentResponseChunk } from '../../shared/crossAgentTypes';
import { spawnGroupChatAgent } from '../../main/group-chat/spawnGroupChatAgent';
import { buildMaestroSystemPromptForSession } from '../../main/utils/maestro-system-prompt';
import * as activity from '../../main/git/worktreeActivity';
import type { StartCrossAgentRequestOptions } from '../../main/cross-agent/cross-agent-router';
import path from 'path';

/**
 * The desktop's binding of the consult service: the dispatch rules themselves (prompt, budgets,
 * completion, Stop) are tested over a fake runner in
 * `src/shared/maestro-lib/agents/__tests__/consult.test.ts`. What is left to prove here is what is
 * the desktop's own: the `ProcessManager` listeners the runner attaches, that they are filtered to
 * the consult's process id, and that every one of them is removed again.
 */

// The spawn collaborator is mocked so these tests exercise the listener lifecycle rather than the
// agent CLI. The parser is an identity fn: the buffer IS the answer.
vi.mock('../../main/group-chat/spawnGroupChatAgent', () => ({
	spawnGroupChatAgent: vi.fn(async () => ({ pid: 123, success: true })),
}));
// The consulted agent's Maestro system prompt is built from the persisted
// stores; stub the builder so the dispatch tests can assert it is threaded.
vi.mock('../../main/utils/maestro-system-prompt', () => ({
	buildMaestroSystemPromptForSession: vi.fn(async (id: string) => `SYSTEM PROMPT FOR ${id}`),
}));
vi.mock('../../main/group-chat/output-parser', () => ({
	extractTextFromStreamJson: vi.fn((raw: string) => raw),
}));

const IDLE_MS = 10 * 60 * 1000;
const HARD_MS = 30 * 60 * 1000;
const LISTENED = ['data', 'thinking-chunk', 'tool-execution', 'usage', 'exit', 'session-id'];

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

/** Minimal ProcessManager stand-in: the runner only uses on/off/kill. */
class FakeProcessManager extends EventEmitter {
	kill = vi.fn();
}

const targetSession = (): CrossAgentTargetSession => ({
	id: 'tgt',
	name: 'Maestro Marketing',
	toolType: 'claude-code',
	cwd: '/proj',
});

function harness(
	sshStore: unknown = null,
	overrides: {
		request?: Partial<CrossAgentRequest>;
		agent?: Record<string, unknown>;
		target?: Partial<CrossAgentTargetSession>;
	} = {}
) {
	const processManager = new FakeProcessManager();
	const chunks: CrossAgentResponseChunk[] = [];
	const options: StartCrossAgentRequestOptions = {
		processManager: processManager as never,
		agentDetector: {
			getAgent: async () => ({
				id: 'claude-code',
				name: 'Claude Code',
				command: 'claude',
				path: 'claude',
				args: [],
				available: true,
				fullAccessArgs: ['--dangerously-skip-permissions'],
				readOnlyArgs: ['--permission-mode', 'plan'],
				readOnlyCliEnforced: true,
				...overrides.agent,
			}),
		} as never,
		sshStore: sshStore as never,
		getTargetSession: () => ({ ...targetSession(), ...overrides.target }),
		onChunk: (c) => chunks.push(c),
	};
	const dispatch = () => startCrossAgentRequest(request(overrides.request), options);
	// The runner keys its listeners on `cross-agent-<requestId>`; request() uses 'r1'.
	const sid = `${CROSS_AGENT_SESSION_PREFIX}r1`;
	return {
		processManager,
		options,
		chunks,
		dispatch,
		emitData: (text: string) => processManager.emit('data', sid, text),
		emitExit: (code: number) => processManager.emit('exit', sid, code),
		emitThinking: () => processManager.emit('thinking-chunk', sid, 'reasoning...'),
		emitTool: () => processManager.emit('tool-execution', sid, { name: 'Read' }),
		emitUsage: () => processManager.emit('usage', sid, { inputTokens: 1 }),
		emitSession: (id: string) => processManager.emit('session-id', sid, id),
	};
}

describe('the desktop consult runner', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.mocked(spawnGroupChatAgent).mockResolvedValue({ pid: 123, success: true });
	});
	afterEach(() => {
		cancelCrossAgentRequestsForSource('src');
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('exports the prompt builders the renderer and tests still import from here', () => {
		expect(serializeTranscript([{ source: 'user', text: 'Hi' }])).toBe('**User:** Hi');
		expect(buildCrossAgentPrompt(request())).toContain('There is no prior conversation to read');
	});

	it('hands the consulted agent its own Maestro system prompt (fresh session)', async () => {
		const { dispatch } = harness();
		await dispatch();

		expect(buildMaestroSystemPromptForSession).toHaveBeenCalledWith('tgt');
		const config = vi.mocked(spawnGroupChatAgent).mock.calls[0][0];
		expect(config.appendSystemPrompt).toBe('SYSTEM PROMPT FOR tgt');
		expect(config.isResume).toBe(false);
	});

	it('marks a consult that resumes the pairing session as a resume', async () => {
		const { dispatch } = harness(null, {
			request: { resumeAgentSessionId: 'prov-1' },
			agent: { resumeArgs: (id: string) => ['--resume', id] },
		});
		await dispatch();

		const config = vi.mocked(spawnGroupChatAgent).mock.calls[0][0];
		expect(config.isResume).toBe(true);
		expect(config.appendSystemPrompt).toBe('SYSTEM PROMPT FOR tgt');
	});

	it('does not treat a resume id as a resume when the agent cannot resume', async () => {
		const { dispatch } = harness(null, { request: { resumeAgentSessionId: 'prov-1' } });
		await dispatch();

		const config = vi.mocked(spawnGroupChatAgent).mock.calls[0][0];
		expect(config.isResume).toBe(false);
	});

	it('already lists the consult at the moment its process is spawned', async () => {
		// A process listener asks while the spawn is still on the stack.
		let atSpawn: ReturnType<typeof getCrossAgentConsultParties> = null;
		vi.mocked(spawnGroupChatAgent).mockImplementationOnce(async () => {
			atSpawn = getCrossAgentConsultParties('r1');
			return { pid: 123, success: true };
		});

		await harness().dispatch();

		expect(atSpawn).toEqual({ sourceSessionId: 'src', targetSessionId: 'tgt' });
	});

	it('says who asks and who answers while a consult is in flight, and nothing once it settled', async () => {
		const { dispatch, emitExit } = harness();
		expect(getCrossAgentConsultParties('r1')).toBeNull();

		await dispatch();
		expect(getCrossAgentConsultParties('r1')).toEqual({
			sourceSessionId: 'src',
			targetSessionId: 'tgt',
		});

		emitExit(0);
		expect(getCrossAgentConsultParties('r1')).toBeNull();
	});

	it('spawns through the group chat spawn helper over this process manager and SSH store', async () => {
		const sshStore = { getSshRemotes: () => [] };
		const { dispatch, processManager } = harness(sshStore);
		await dispatch();

		const config = vi.mocked(spawnGroupChatAgent).mock.calls[0][0];
		expect(config).toMatchObject({
			sessionId: 'cross-agent-r1',
			agentId: 'claude-code',
			cwd: '/proj',
			readOnlyMode: true,
		});
		expect(config.processManager).toBe(processManager);
		expect(config.sshStore).toBe(sshStore);
	});

	it('buffers the stream and delivers it, with the session id, when the process exits', async () => {
		const { chunks, dispatch, emitData, emitSession, emitExit } = harness();
		await dispatch();

		emitData('the ');
		emitData('answer');
		emitSession('prov-sess-1');
		emitExit(0);

		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({
			chunk: 'the answer',
			done: true,
			targetAgentSessionId: 'prov-sess-1',
		});
	});

	it('attaches every listener before the spawn so no early event is missed', async () => {
		const { dispatch, processManager } = harness();
		vi.mocked(spawnGroupChatAgent).mockImplementationOnce(async () => {
			for (const evt of LISTENED) expect(processManager.listenerCount(evt)).toBeGreaterThan(0);
			return { pid: 1, success: true };
		});
		await dispatch();
		expect.assertions(LISTENED.length);
	});

	it.each([
		['thinking', 'emitThinking'],
		['a tool call', 'emitTool'],
		['a usage report', 'emitUsage'],
	] as const)('treats %s as proof of life, though it carries no data', async (_label, emit) => {
		// A `--print` stream-json consult emits `data` ONLY at the terminal result; intermediate
		// progress goes to these events. Arming the silence budget on `data` alone made it a hard
		// deadline that killed agents which were working perfectly.
		const h = harness();
		await h.dispatch();

		for (let elapsed = 0; elapsed < HARD_MS - IDLE_MS; elapsed += IDLE_MS - 60_000) {
			vi.advanceTimersByTime(IDLE_MS - 60_000);
			h[emit]();
		}

		expect(h.chunks).toHaveLength(0);
	});

	it('ignores events belonging to a different session', async () => {
		// The ProcessManager emitter is shared app-wide; another agent's activity must not keep a
		// genuinely wedged consult alive forever, and its output must not leak into this answer.
		const { chunks, dispatch, processManager, emitExit } = harness();
		await dispatch();

		processManager.emit('data', 'some-other-session', 'not ours');
		vi.advanceTimersByTime(IDLE_MS - 60_000);
		processManager.emit('thinking-chunk', 'some-other-session', 'not ours');
		processManager.emit('exit', 'some-other-session', 0);
		vi.advanceTimersByTime(60_000);

		expect(chunks).toHaveLength(1);
		expect(chunks[0].error).toContain('went silent');
		expect(chunks[0].chunk).toBe('');
		emitExit(0);
		expect(chunks).toHaveLength(1);
	});

	it('removes every listener once the consult ends', async () => {
		// These attach to the shared ProcessManager; leaking one per consult would accumulate for the
		// life of the app.
		const { dispatch, emitExit, processManager } = harness();
		await dispatch();
		expect(LISTENED.every((evt) => processManager.listenerCount(evt) > 0)).toBe(true);

		emitExit(0);

		for (const evt of LISTENED) expect(processManager.listenerCount(evt)).toBe(0);
	});

	// The consult runs in the target's own cwd, which a TUI target may trust (#1872).
	it("lets a TUI target accept claude's folder trust for its own cwd", async () => {
		const { dispatch } = harness();
		await dispatch();

		const config = vi.mocked(spawnGroupChatAgent).mock.calls[0][0];
		expect(config.cwd).toBe('/proj');
		expect(config.acceptWorkspaceTrust).toBe(true);
	});

	it('names the untrusted folder when maestro-p exits 7, not "no visible output"', async () => {
		const { chunks, dispatch, emitExit } = harness();
		await dispatch();

		emitExit(7);

		expect(chunks[0].error).toContain('has not trusted the folder /proj');
		expect(chunks[0].error).not.toContain('no visible output');
	});

	it('keeps the generic message for exit 7 from a non-Claude target', async () => {
		const { chunks, dispatch, emitExit } = harness(null, { target: { toolType: 'codex' } });
		await dispatch();

		emitExit(7);

		expect(chunks[0].error).toContain('produced no visible output (exit code 7)');
	});

	it('kills the process and flushes the partial output once it goes silent', async () => {
		const { chunks, dispatch, emitData, processManager } = harness();
		await dispatch();

		emitData('half an answer');
		vi.advanceTimersByTime(IDLE_MS);

		expect(processManager.kill).toHaveBeenCalledWith('cross-agent-r1');
		expect(chunks).toHaveLength(1);
		expect(chunks[0].chunk).toBe('half an answer');
		expect(chunks[0].error).toContain('went silent');
		for (const evt of LISTENED) expect(processManager.listenerCount(evt)).toBe(0);
	});

	it('removes every listener, and kills nothing, when the spawner refuses', async () => {
		vi.mocked(spawnGroupChatAgent).mockResolvedValue({ pid: -1, success: false });
		const { chunks, dispatch, processManager } = harness();
		await dispatch();

		expect(chunks).toHaveLength(1);
		expect(chunks[0].error).toContain('could not be started');
		for (const evt of LISTENED) expect(processManager.listenerCount(evt)).toBe(0);
		expect(processManager.kill).not.toHaveBeenCalled();
	});

	it('removes every listener when the spawner throws', async () => {
		vi.mocked(spawnGroupChatAgent).mockRejectedValue(new Error('spawn exploded'));
		const { chunks, dispatch, processManager } = harness();
		await dispatch();

		expect(chunks).toHaveLength(1);
		expect(chunks[0].error).toBe('spawn exploded');
		for (const evt of LISTENED) expect(processManager.listenerCount(evt)).toBe(0);
	});
});

/**
 * Stop is an AGENT-level action, and a `@mention` fans one turn out across an ephemeral
 * `cross-agent-*` process per consulted target. The handler reaches them through the shim.
 */
describe('cancelCrossAgentRequestsForSource', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.mocked(spawnGroupChatAgent).mockResolvedValue({ pid: 123, success: true });
	});
	afterEach(() => {
		cancelCrossAgentRequestsForSource('src');
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('kills a running consult and settles it as canceled, keeping what it had said', async () => {
		const { chunks, dispatch, processManager, emitData } = harness();
		await dispatch();
		emitData('half an answer');

		expect(cancelCrossAgentRequestsForSource('src')).toBe(1);

		expect(processManager.kill).toHaveBeenCalledWith('cross-agent-r1');
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({ done: true, canceled: true, chunk: 'half an answer' });
		expect(chunks[0].error).toBeUndefined();
		for (const evt of LISTENED) expect(processManager.listenerCount(evt)).toBe(0);
	});

	it('sees consults started by separate calls, since one service serves the whole app', async () => {
		const first = harness();
		await first.dispatch();

		expect(cancelCrossAgentRequestsForSource('src')).toBe(1);
		expect(cancelCrossAgentRequestsForSource('src')).toBe(0);
	});

	it('leaves consults belonging to another source agent alone', async () => {
		const { chunks, dispatch, processManager } = harness();
		await dispatch();

		expect(cancelCrossAgentRequestsForSource('some-other-agent')).toBe(0);
		expect(processManager.kill).not.toHaveBeenCalled();
		expect(chunks).toHaveLength(0);
	});

	it('kills a process that finished spawning after the Stop that ended it', async () => {
		const { chunks, dispatch, processManager } = harness();
		let releaseSpawn: () => void = () => {};
		vi.mocked(spawnGroupChatAgent).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseSpawn = () => resolve({ pid: 123, success: true });
				})
		);

		const pending = dispatch();
		await vi.waitFor(() => expect(spawnGroupChatAgent).toHaveBeenCalled());
		expect(cancelCrossAgentRequestsForSource('src')).toBe(1);
		processManager.kill.mockClear();

		releaseSpawn();
		await pending;

		expect(processManager.kill).toHaveBeenCalledWith('cross-agent-r1');
		expect(chunks).toHaveLength(1);
		expect(chunks[0].canceled).toBe(true);
	});
});

/** The outer request starts before the runner owns listeners or a native child. */
describe('desktop outer consult request activity', () => {
	let active: number;
	let reservations: Array<() => void>;
	async function reserve(root = process.cwd()) {
		const hold = await activity.reserveWorktreeCleanup(root);
		if (hold.status === 'reserved-partially') reservations.push(hold.release);
		return hold;
	}
	async function idle() {
		const hold = await reserve();
		expect(hold.status).toBe('reserved-partially');
		if (hold.status === 'reserved-partially') {
			expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
			hold.release();
		}
	}
	beforeEach(() => {
		vi.useFakeTimers();
		active = 0;
		reservations = [];
		const admit = activity.beginGlobalWorktreeActivity;
		vi.spyOn(activity, 'beginGlobalWorktreeActivity').mockImplementation(() => {
			const release = admit();
			active++;
			let released = false;
			return () => {
				if (!released) active--;
				released = true;
				release();
			};
		});
		vi.mocked(spawnGroupChatAgent).mockResolvedValue({ pid: 123, success: true });
	});
	afterEach(() => {
		for (const release of reservations) release();
		cancelCrossAgentRequestsForSource('src');
		cancelCrossAgentRequestsForSource('src2');
		expect(active).toBe(0);
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it.each([process.cwd(), path.resolve('src'), path.resolve('..')])(
		'refuses start under %s before request/options inspection or recovery',
		async (root) => {
			const hold = await reserve(root);
			expect(hold.status).toBe('reserved-partially');
			const read = vi.fn(() => {
				throw new Error('Input must remain untouched');
			});
			expect(() =>
				startCrossAgentRequest(
					new Proxy(request(), { get: read }),
					new Proxy(harness().options, { get: read })
				)
			).toThrow(/reserved/);
			expect(read).not.toHaveBeenCalled();
			expect(spawnGroupChatAgent).not.toHaveBeenCalled();
			expect(buildMaestroSystemPromptForSession).not.toHaveBeenCalled();
			expect(getCrossAgentConsultParties('r1')).toBeNull();
		}
	);

	it.each([undefined, 'tab'])(
		'refuses source cancellation before service mutation (%s)',
		async (tab) => {
			await reserve();
			expect(() => cancelCrossAgentRequestsForSource('src', tab)).toThrow(/reserved/);
		}
	);

	it('preserves synchronous option errors and releases before caller recovery', async () => {
		const error = new Error('option failed');
		const { options } = harness();
		Object.defineProperty(options, 'processManager', {
			get() {
				expect(active).toBe(1);
				throw error;
			},
		});
		expect(() => startCrossAgentRequest(request(), options)).toThrow(error);
		expect(active).toBe(0);
		await idle();
	});

	it.each(['target', 'agent', 'config', 'env'] as const)(
		'owns %s setup errors and preserves the service outcome before a runner exists',
		async (stage) => {
			const error = new Error(`${stage} failed`);
			const { dispatch, options, chunks } = harness();
			const fail = () => {
				expect(active).toBe(1);
				throw error;
			};
			if (stage === 'target') options.getTargetSession = fail;
			if (stage === 'agent') options.agentDetector.getAgent = fail;
			if (stage === 'config') options.getAgentConfig = fail;
			if (stage === 'env') options.getCustomEnvVars = fail;
			if (stage === 'env') {
				await dispatch();
				expect(chunks).toMatchObject([{ done: true, error: error.message }]);
			} else {
				await expect(dispatch()).rejects.toBe(error);
			}
			expect(spawnGroupChatAgent).not.toHaveBeenCalled();
			await idle();
		}
	);

	it.each(['missing', 'ssh', 'unavailable'] as const)(
		'owns early %s reporting and preserves a throwing observer',
		async (stage) => {
			const { dispatch, options } = harness();
			if (stage === 'missing') options.getTargetSession = () => null;
			if (stage === 'ssh')
				options.getTargetSession = () => ({
					...targetSession(),
					sshRemoteConfig: { enabled: true, remoteId: 'remote' },
				});
			if (stage === 'unavailable') options.agentDetector.getAgent = async () => null;
			const error = new Error('report failed');
			options.onChunk = () => {
				expect(active).toBe(1);
				throw error;
			};
			await expect(dispatch()).rejects.toBe(error);
			expect(spawnGroupChatAgent).not.toHaveBeenCalled();
			await idle();
		}
	);

	it('holds unresolved agent preparation across Stop until cancelled setup returns', async () => {
		const { dispatch, options, chunks } = harness();
		const agent = await options.agentDetector.getAgent('claude-code');
		const pendingAgent = Promise.withResolvers<typeof agent>();
		options.agentDetector.getAgent = () => pendingAgent.promise;
		const pending = dispatch();
		expect(active).toBe(1);
		expect(await reserve()).toMatchObject({ status: 'blocked' });
		expect(cancelCrossAgentRequestsForSource('src', 'tab')).toBe(1);
		expect(active).toBe(1);
		expect(await reserve()).toMatchObject({ status: 'blocked' });
		pendingAgent.resolve(agent);
		await pending;
		expect(chunks).toMatchObject([{ done: true, canceled: true }]);
		expect(spawnGroupChatAgent).not.toHaveBeenCalled();
		await idle();
	});

	it('holds rejected pending preparation after cancellation and preserves the rejection', async () => {
		const { dispatch, options } = harness();
		const pendingAgent = Promise.withResolvers<never>();
		options.agentDetector.getAgent = () => pendingAgent.promise;
		const pending = dispatch();
		const error = new Error('agent resolution failed');
		const assertion = expect(pending).rejects.toBe(error);
		expect(cancelCrossAgentRequestsForSource('src')).toBe(1);
		expect(await reserve()).toMatchObject({ status: 'blocked' });
		pendingAgent.reject(error);
		await assertion;
		await idle();
	});

	it('keeps prompt preparation held after Stop and through late spawn recovery', async () => {
		const prompt = Promise.withResolvers<string>();
		vi.mocked(buildMaestroSystemPromptForSession).mockReturnValueOnce(prompt.promise);
		const { dispatch, processManager, chunks } = harness();
		const pending = dispatch();
		await vi.waitFor(() => expect(buildMaestroSystemPromptForSession).toHaveBeenCalled());
		expect(active).toBe(1);
		expect(cancelCrossAgentRequestsForSource('src')).toBe(1);
		expect(processManager.eventNames()).toEqual([]);
		expect(active).toBe(1);
		expect(await reserve()).toMatchObject({ status: 'blocked' });
		vi.mocked(spawnGroupChatAgent).mockImplementationOnce(async () => {
			expect(active).toBe(3); // outer request, runner request, retained listeners
			return { pid: 123, success: true };
		});
		prompt.resolve('system prompt');
		await pending;
		expect(processManager.kill).toHaveBeenCalledTimes(2);
		expect(chunks).toHaveLength(1);
		await idle();
	});

	it('keeps prompt rejection recovery held after cancellation', async () => {
		const prompt = Promise.withResolvers<string>();
		vi.mocked(buildMaestroSystemPromptForSession).mockReturnValueOnce(prompt.promise);
		const { dispatch } = harness();
		const pending = dispatch();
		await vi.waitFor(() => expect(buildMaestroSystemPromptForSession).toHaveBeenCalled());
		cancelCrossAgentRequestsForSource('src');
		expect(active).toBe(1);
		prompt.reject(new Error('prompt failed after stop'));
		await pending;
		expect(spawnGroupChatAgent).not.toHaveBeenCalled();
		await idle();
	});

	it('keeps concurrent preparation independent when one request fails', async () => {
		const first = harness();
		const second = harness(null, { request: { requestId: 'r2', sourceSessionId: 'src2' } });
		const agent = await second.options.agentDetector.getAgent('claude-code');
		const a = Promise.withResolvers<typeof agent>();
		const b = Promise.withResolvers<typeof agent>();
		first.options.agentDetector.getAgent = () => a.promise;
		second.options.agentDetector.getAgent = () => b.promise;
		const pendingA = first.dispatch();
		const assertion = expect(pendingA).rejects.toThrow('first failed');
		const pendingB = second.dispatch();
		expect(active).toBe(2);
		a.reject(new Error('first failed'));
		await assertion;
		expect(active).toBe(1);
		expect(await reserve()).toMatchObject({ status: 'blocked' });
		cancelCrossAgentRequestsForSource('src2');
		b.resolve(agent);
		await pendingB;
		await idle();
	});

	it('retains cancellation activity through throwing reporting after listeners detach', async () => {
		const { dispatch, options, processManager } = harness();
		const error = new Error('cancel observer failed');
		options.onChunk = () => {
			expect(active).toBe(1);
			expect(processManager.eventNames()).toEqual([]);
			throw error;
		};
		await dispatch();
		expect(() => cancelCrossAgentRequestsForSource('src')).toThrow(error);
		await idle();
	});

	it('retains the outer cancellation scope during reentrant no-op cancellation', async () => {
		const { dispatch, options } = harness();
		options.onChunk = () => {
			expect(active).toBe(1);
			expect(cancelCrossAgentRequestsForSource('src')).toBe(0);
			expect(active).toBe(1);
		};
		await dispatch();
		expect(cancelCrossAgentRequestsForSource('src')).toBe(1);
		await idle();
	});

	it('does not release pending spawn activity when Stop detaches its listeners', async () => {
		const spawn = Promise.withResolvers<{ pid: number; success: boolean }>();
		vi.mocked(spawnGroupChatAgent).mockReturnValueOnce(spawn.promise);
		const { dispatch, processManager } = harness();
		const pending = dispatch();
		await vi.waitFor(() => expect(spawnGroupChatAgent).toHaveBeenCalled());
		expect(cancelCrossAgentRequestsForSource('src')).toBe(1);
		expect(processManager.eventNames()).toEqual([]);
		expect(active).toBe(2); // outer and runner starts still pending
		expect(await reserve()).toMatchObject({ status: 'blocked' });
		spawn.resolve({ pid: -1, success: false });
		await pending;
		await idle();
	});

	it('leaves retained listener ownership after successful request completion', async () => {
		const { dispatch, emitExit } = harness();
		await dispatch();
		expect(active).toBe(1);
		expect(await reserve()).toMatchObject({ status: 'blocked' });
		emitExit(0);
		await idle();
	});
});
