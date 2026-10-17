import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	startCrossAgentRequest,
	cancelCrossAgentRequestsForSource,
	CROSS_AGENT_SESSION_PREFIX,
	buildCrossAgentPrompt,
	serializeTranscript,
	getCrossAgentConsultParties,
	type CrossAgentTargetSession,
} from '../../main/cross-agent/cross-agent-router';
import type {
	CrossAgentRequest,
	CrossAgentResponseChunk,
	CrossAgentTranscriptEntry,
} from '../../shared/crossAgentTypes';
import {
	CONSULT_BUDGET_FILE,
	readConsultBudgetSpent,
	spendConsultBudget,
} from '../../main/peer-consults/consult-budget';
import { describeConsultBudgetRefusal, isConsultChainId } from '../../shared/consultBudget';
import { spawnGroupChatAgent } from '../../main/group-chat/spawnGroupChatAgent';
import { buildMaestroSystemPromptForSession } from '../../main/utils/maestro-system-prompt';

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

/**
 * The consult budget counter for the test in progress. ALWAYS a temp directory:
 * `MAESTRO_USER_DATA` is set in an agent's shell, so the router's default would
 * be the live one.
 */
let budgetDir = '';
beforeEach(() => {
	budgetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-router-budget-'));
});
afterEach(() => {
	fs.rmSync(budgetDir, { recursive: true, force: true });
});

function harness(
	overrides: {
		sshStore?: unknown;
		getTargetSession?: () => CrossAgentTargetSession | null;
		writable?: boolean;
		maxConsultationsPerTurn?: number;
		request?: Partial<CrossAgentRequest>;
		agent?: Record<string, unknown>;
	} = {}
) {
	const processManager = new FakeProcessManager();
	const chunks: CrossAgentResponseChunk[] = [];
	const dispatch = () =>
		startCrossAgentRequest(request(overrides.request), {
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
			sshStore: (overrides.sshStore ?? null) as never,
			getTargetSession: overrides.getTargetSession ?? targetSession,
			writable: overrides.writable,
			maxConsultationsPerTurn: overrides.maxConsultationsPerTurn ?? 25,
			consultBudgetStore: { dataDir: budgetDir },
			onChunk: (c) => chunks.push(c),
		});
	// The runner keys its listeners on `cross-agent-<requestId>`; request() uses 'r1'.
	const sid = `${CROSS_AGENT_SESSION_PREFIX}r1`;
	return {
		processManager,
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

	// `maestro-cli ask` spends in the CLI and sends the place the consulted agent
	// takes. The router's part is to state it in the consult's environment, so a
	// `maestro-cli ask` or `dispatch` the consulted agent runs spends the same chain.
	it('states an admitted consult chain in the environment, over the agent env vars', async () => {
		const { dispatch } = harness({
			getTargetSession: () => ({ ...targetSession(), customEnvVars: { FOO: 'bar' } }),
			request: { consultChain: { chainId: 'chain-a', depth: 2 } },
		});
		await dispatch();

		const config = vi.mocked(spawnGroupChatAgent).mock.calls[0][0];
		expect(config.customEnvVars).toMatchObject({
			FOO: 'bar',
			MAESTRO_CONSULT_CHAIN: 'chain-a',
			MAESTRO_CONSULT_DEPTH: '2',
		});
	});

	it('does not charge a consult that was admitted before it arrived', async () => {
		const { dispatch } = harness({
			request: {
				consultChain: { chainId: 'chain-a', depth: 2 },
				sourceConsultChain: { chainId: 'chain-a', depth: 1 },
			},
		});
		await dispatch();

		expect(spawnGroupChatAgent).toHaveBeenCalledTimes(1);
		expect(readConsultBudgetSpent('chain-a', { dataDir: budgetDir })).toBe(0);
	});

	describe('the consult budget of an @mention', () => {
		const spawnedEnv = () => vi.mocked(spawnGroupChatAgent).mock.calls[0][0].customEnvVars!;
		const counterFile = () => path.join(budgetDir, CONSULT_BUDGET_FILE);

		// The asymmetry the router states in its own comment: the user's mention is
		// the user's message, so it is free and roots a chain; an agent's is a spend.
		it('lets a mention the user typed through free, as the root of a new chain', async () => {
			const { dispatch } = harness({
				getTargetSession: () => ({ ...targetSession(), customEnvVars: { FOO: 'bar' } }),
			});
			await dispatch();

			expect(spawnedEnv()).toMatchObject({ FOO: 'bar', MAESTRO_CONSULT_DEPTH: '0' });
			expect(isConsultChainId(spawnedEnv().MAESTRO_CONSULT_CHAIN)).toBe(true);
			// Nothing was spent, so the counter was never written.
			expect(fs.existsSync(counterFile())).toBe(false);
		});

		it('lets a mention the user typed through even at a budget of 0', async () => {
			const { dispatch, chunks } = harness({ maxConsultationsPerTurn: 0 });
			await dispatch();

			expect(spawnGroupChatAgent).toHaveBeenCalledTimes(1);
			expect(chunks).toEqual([]);
		});

		it('roots a separate chain for each mention the user typed', async () => {
			await harness().dispatch();
			await harness().dispatch();

			const [first, second] = vi
				.mocked(spawnGroupChatAgent)
				.mock.calls.map(([config]) => config.customEnvVars!.MAESTRO_CONSULT_CHAIN);
			expect(first).not.toBe(second);
		});

		it('spends one from the chain of a mention an agent made, one hop further down', async () => {
			spendConsultBudget('chain-a', 25, { dataDir: budgetDir });
			const { dispatch } = harness({
				request: { sourceConsultChain: { chainId: 'chain-a', depth: 1 } },
			});
			await dispatch();

			expect(spawnedEnv()).toMatchObject({
				MAESTRO_CONSULT_CHAIN: 'chain-a',
				MAESTRO_CONSULT_DEPTH: '2',
			});
			expect(readConsultBudgetSpent('chain-a', { dataDir: budgetDir })).toBe(2);
		});

		// The prompt builder is told the chain the consult was just placed in, so
		// the consulted agent reads what is left of the budget it now shares.
		it('builds the consulted agent its prompt with the chain it was placed in', async () => {
			spendConsultBudget('chain-a', 25, { dataDir: budgetDir });
			const { dispatch } = harness({
				request: { sourceConsultChain: { chainId: 'chain-a', depth: 1 } },
			});
			await dispatch();

			expect(buildMaestroSystemPromptForSession).toHaveBeenCalledWith('tgt', {
				consultChain: { chainId: 'chain-a', depth: 2 },
				consultBudgetStore: { dataDir: budgetDir },
			});
		});

		it('builds the prompt of a consult admitted in the CLI with the chain it carries', async () => {
			const { dispatch } = harness({
				request: { consultChain: { chainId: 'chain-b', depth: 3 } },
			});
			await dispatch();

			expect(vi.mocked(buildMaestroSystemPromptForSession).mock.calls[0][1]).toMatchObject({
				consultChain: { chainId: 'chain-b', depth: 3 },
			});
		});

		it('refuses an agent mention once the chain has spent its budget', async () => {
			spendConsultBudget('chain-a', 2, { dataDir: budgetDir });
			spendConsultBudget('chain-a', 2, { dataDir: budgetDir });
			const { dispatch, chunks, processManager } = harness({
				maxConsultationsPerTurn: 2,
				request: { sourceConsultChain: { chainId: 'chain-a', depth: 1 } },
			});
			await dispatch();

			expect(spawnGroupChatAgent).not.toHaveBeenCalled();
			// The same wording every CLI verb prints: the budget, the spend, the setting.
			const refusal = describeConsultBudgetRefusal({ spent: 2, limit: 2 });
			expect(chunks).toEqual([
				expect.objectContaining({ done: true, chunk: '', error: refusal.message }),
			]);
			expect(refusal.message).toContain('maxConsultationsPerTurn');
			// A refusal does not count, and leaves nothing behind to Stop or to leak.
			expect(readConsultBudgetSpent('chain-a', { dataDir: budgetDir })).toBe(2);
			expect(getCrossAgentConsultParties('r1')).toBeNull();
			expect(processManager.listenerCount('exit')).toBe(0);
			expect(processManager.listenerCount('data')).toBe(0);
		});

		it('refuses every agent mention at a budget of 0', async () => {
			const { dispatch, chunks } = harness({
				maxConsultationsPerTurn: 0,
				request: { sourceConsultChain: { chainId: 'chain-a', depth: 0 } },
			});
			await dispatch();

			expect(spawnGroupChatAgent).not.toHaveBeenCalled();
			expect(chunks[0].error).toBe(describeConsultBudgetRefusal({ spent: 0, limit: 0 }).message);
		});

		it('fails closed, and says why, when the counter cannot be read', async () => {
			fs.writeFileSync(counterFile(), '{ not json');
			const { dispatch, chunks } = harness({
				request: { sourceConsultChain: { chainId: 'chain-a', depth: 1 } },
			});
			await dispatch();

			expect(spawnGroupChatAgent).not.toHaveBeenCalled();
			expect(chunks[0].error).toContain('Consultation budget unavailable');
			expect(chunks[0].error).toContain(counterFile());
			// The damaged file is left as it is: resetting it would hand out a fresh budget.
			expect(fs.readFileSync(counterFile(), 'utf-8')).toBe('{ not json');
		});

		it('spends nothing for a mention that was never going to start', async () => {
			const { dispatch, chunks } = harness({
				getTargetSession: () => null,
				request: { sourceConsultChain: { chainId: 'chain-a', depth: 1 } },
			});
			await dispatch();

			expect(chunks[0].error).toContain('Target agent not found');
			expect(readConsultBudgetSpent('chain-a', { dataDir: budgetDir })).toBe(0);
		});
	});

	it('hands the consulted agent its own Maestro system prompt (fresh session)', async () => {
		const { dispatch } = harness();
		await dispatch();

		expect(buildMaestroSystemPromptForSession).toHaveBeenCalledWith('tgt', expect.anything());
		const config = vi.mocked(spawnGroupChatAgent).mock.calls[0][0];
		expect(config.appendSystemPrompt).toBe('SYSTEM PROMPT FOR tgt');
		expect(config.isResume).toBe(false);
	});

	it('marks a consult that resumes the pairing session as a resume', async () => {
		const { dispatch } = harness({
			request: { resumeAgentSessionId: 'prov-1' },
			agent: { resumeArgs: (id: string) => ['--resume', id] },
		});
		await dispatch();

		const config = vi.mocked(spawnGroupChatAgent).mock.calls[0][0];
		expect(config.isResume).toBe(true);
		expect(config.appendSystemPrompt).toBe('SYSTEM PROMPT FOR tgt');
	});

	it('does not treat a resume id as a resume when the agent cannot resume', async () => {
		const { dispatch } = harness({ request: { resumeAgentSessionId: 'prov-1' } });
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
		const { dispatch, processManager } = harness({ sshStore });
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
