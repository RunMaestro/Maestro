/**
 * A Cappella routing evaluation harness.
 *
 * The model-in-the-loop half of `docs/architecture/acappella/routing-evaluation.md`.
 * The deterministic suites in `src/__tests__/main/acappella/router/` prove the
 * router's RULES against a scripted Brain; nothing in CI proves that a real model,
 * handed the real prompt and a realistic roster, picks the right agent and the
 * right tab. That is the number this file produces.
 *
 * It was originally written down as a fifteen-minute microphone session with four
 * live agents. That is a bad instrument for the thing being measured: routing
 * takes a TRANSCRIPT and a ROSTER, both of which are data, so speech recognition
 * and real agents add two uncontrolled variables and make the result unrepeatable.
 * Everything here below the Brain is the shipping code - `createConductorRouter`,
 * the real prompt from `src/prompts/acappella-router.md`, `parseRouteDecision`,
 * the grammar validator, the recall ranker, and the routing log itself - so the
 * only thing being varied is the model.
 *
 * The harness plays the part of the user who corrects a misroute: a decision that
 * does not match the expectation is marked `corrected` in the routing log, which
 * is exactly what the HUD's correction control does in the app. `routingQuality()`
 * then reports the hit rate the same way it will report it in the field.
 *
 * Usage:
 *
 *   npm run acappella:eval                     # the Conductor-agent Brain
 *   npm run acappella:eval -- --brain anthropic
 *   npm run acappella:eval -- --brain openai --agent-type codex
 *   npm run acappella:eval -- --brain local --model-path /path/to/qwen3.gguf
 *
 * Hosted Brains read their key from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` rather
 * than the keychain, so a run does not depend on a configured desktop install.
 */

import { spawn as spawnChild, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';

import { AgentDetector } from '../src/main/agents';
import {
	createConductorRouter,
	isCorrectionUtterance,
	planCorrection,
} from '../src/main/acappella/router/conductor-router';
import {
	ConductorAgentBrain,
	type ConductorProcessManager,
} from '../src/main/acappella/router/conductor-agent';
import {
	serializeRoutingContext,
	type RoutingContext,
} from '../src/main/acappella/router/routing-context';
import {
	noteRoutingOutcome,
	readRoutingLog,
	resetRoutingLog,
	routingQuality,
	setRoutingLogPath,
} from '../src/main/acappella/router/routing-log';
import { AnthropicBrainProvider } from '../src/main/acappella/providers/hosted/anthropic-brain';
import { OpenAiBrainProvider } from '../src/main/acappella/providers/hosted/openai-brain';
import { LlamaBrainProvider } from '../src/main/acappella/providers/local/llama-brain';
import { initializePrompts } from '../src/main/prompt-manager';
import { logger } from '../src/main/utils/logger';
import type { RosterAgent } from '../src/shared/acappella/protocol';
import type { BrainProvider } from '../src/shared/acappella/providers';
import {
	isClarification,
	routeTargetSessionId,
	type RouteDecision,
	type RouteTabAction,
} from '../src/shared/acappella/route-decision';

// ---------------------------------------------------------------------------
// The fixture roster
// ---------------------------------------------------------------------------

const MINUTE = 60_000;

/**
 * Fixed so two runs are comparable: recency is part of the recall ranking, and a
 * roster built from the wall clock would score differently every time.
 */
const BASE_TIME = Date.parse('2026-08-15T12:00:00Z');

const SESSIONS = {
	backend: 'sess-backend',
	api: 'sess-api',
	frontend: 'sess-frontend',
	infra: 'sess-infra',
} as const;

/** The four agents and twelve tabs the evaluation doc specifies. */
const ROSTER: RosterAgent[] = [
	{
		sessionId: SESSIONS.backend,
		name: 'Backend',
		agentType: 'claude-code',
		cwd: '/repo/payments-api',
		status: 'idle',
		recentWork: 'Split the auth middleware out of the request pipeline',
		tabs: [
			{
				id: 'tab-auth-refactor',
				name: 'Auth Refactor',
				lastActiveAt: BASE_TIME - 2 * MINUTE,
				state: 'open',
				topic: 'rewriting the auth middleware and its token checks',
			},
			{
				id: 'tab-db-migrations',
				name: 'DB Migrations',
				lastActiveAt: BASE_TIME - 90 * MINUTE,
				state: 'open',
				topic: 'the pending payment schema migrations',
			},
			{
				id: 'tab-rate-limit-spike',
				name: 'Rate Limit Spike',
				lastActiveAt: BASE_TIME - 26 * 60 * MINUTE,
				state: 'snoozed',
				topic: 'an abandoned experiment with per-key rate limiting',
			},
		],
	},
	{
		sessionId: SESSIONS.api,
		name: 'API',
		agentType: 'codex',
		cwd: '/repo/gateway',
		status: 'idle',
		recentWork: 'Added retry backoff to the webhook dispatcher',
		tabs: [
			{
				id: 'tab-gateway-routing',
				name: 'Gateway Routing',
				lastActiveAt: BASE_TIME - 15 * MINUTE,
				state: 'open',
				topic: 'how requests are routed through the gateway',
			},
			{
				id: 'tab-webhook-retries',
				name: 'Webhook Retries',
				lastActiveAt: BASE_TIME - 4 * 60 * MINUTE,
				state: 'open',
				topic: 'what the retry policy for failed webhooks should be',
			},
			{
				id: 'tab-old-auth-spike',
				name: 'Old Auth Spike',
				lastActiveAt: BASE_TIME - 12 * 24 * 60 * MINUTE,
				state: 'closed',
				topic: 'an early attempt at gateway-side auth, abandoned',
			},
		],
	},
	{
		sessionId: SESSIONS.frontend,
		name: 'Frontend',
		agentType: 'claude-code',
		cwd: '/repo/web',
		status: 'busy',
		recentWork: 'Made the sidebar collapse animation respect reduced motion',
		tabs: [
			{
				id: 'tab-sidebar-collapse',
				name: 'Sidebar Collapse',
				lastActiveAt: BASE_TIME - 8 * MINUTE,
				state: 'open',
				topic: 'the collapsing sidebar and its animation',
			},
			{
				id: 'tab-checkout-flow',
				name: 'Checkout Flow',
				lastActiveAt: BASE_TIME - 6 * 60 * MINUTE,
				state: 'open',
				topic: 'the multi-step checkout form and its validation',
			},
			{
				id: 'tab-dark-mode',
				name: 'Dark Mode',
				lastActiveAt: BASE_TIME - 3 * 24 * 60 * MINUTE,
				state: 'open',
				topic: 'the dark mode toggle and how the choice is remembered',
			},
		],
	},
	{
		sessionId: SESSIONS.infra,
		name: 'Infra',
		agentType: 'opencode',
		cwd: '/repo/terraform',
		status: 'idle',
		recentWork: 'Pinned the node pool to the previous Kubernetes minor',
		tabs: [
			{
				id: 'tab-cluster-upgrade',
				name: 'Cluster Upgrade',
				lastActiveAt: BASE_TIME - 40 * MINUTE,
				state: 'open',
				topic: 'upgrading the Kubernetes cluster version',
			},
			{
				id: 'tab-cost-report',
				name: 'Cost Report',
				lastActiveAt: BASE_TIME - 2 * 24 * 60 * MINUTE,
				state: 'open',
				topic: 'the monthly cloud spend breakdown',
			},
			{
				id: 'tab-log-retention',
				name: 'Log Retention',
				lastActiveAt: BASE_TIME - 5 * 24 * 60 * MINUTE,
				state: 'open',
				topic: 'how long logs are kept before they are rolled off',
			},
		],
	},
];

/** The agent the user is looking at when the script starts. */
const ACTIVE_AGENT = SESSIONS.backend;

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

interface Expectation {
	/**
	 * A roster session id, or `conductor`.
	 *
	 * Omitted for a case whose correct answer is a question: when the router is
	 * right to be unsure, which target it leaned toward while asking is not part
	 * of being right, and scoring it would penalise the intended behaviour.
	 */
	target?: string;
	action?: RouteTabAction;
	tabId?: string;
	/** True when the correct behaviour is a spoken question rather than a dispatch. */
	clarify?: boolean;
}

interface EvalCase {
	n: number;
	utterance: string;
	tests: string;
	expect: Expectation;
	/**
	 * A correction is not routed at all: it is recognised before the Brain is
	 * consulted, which is the property worth testing.
	 */
	correction?: boolean;
	/**
	 * The answer to the question this utterance is expected to provoke, routed on
	 * the next turn with the original utterance attached. Reported separately: it
	 * measures the disambiguation round trip, not the fifteen-utterance hit rate.
	 */
	answer?: { text: string; target: string };
}

const CASES: EvalCase[] = [
	{
		n: 1,
		utterance: 'run the tests',
		tests: 'same-topic continuation',
		expect: { target: SESSIONS.backend, action: 'current' },
	},
	{
		n: 2,
		utterance: 'what broke',
		tests: 'pronoun-free follow-up',
		expect: { target: SESSIONS.backend, action: 'current' },
	},
	{
		n: 3,
		utterance: 'add a rate limiter to the public endpoints',
		tests: 'topic switch',
		expect: { target: SESSIONS.backend, action: 'new' },
	},
	{
		n: 4,
		utterance: 'ask the frontend agent about the checkout flow',
		tests: 'explicit agent naming',
		expect: { target: SESSIONS.frontend, action: 'recall', tabId: 'tab-checkout-flow' },
	},
	{
		n: 5,
		utterance: 'tell infra to bump the cluster version',
		tests: 'explicit agent naming',
		expect: { target: SESSIONS.infra, action: 'current' },
	},
	{
		n: 6,
		utterance: 'back to the auth thing',
		tests: 'vague recall',
		expect: { target: SESSIONS.backend, action: 'recall', tabId: 'tab-auth-refactor' },
	},
	{
		n: 7,
		utterance: 'what did we decide about webhook retries',
		tests: 'recall by topic',
		expect: { target: SESSIONS.api, action: 'recall', tabId: 'tab-webhook-retries' },
	},
	{
		n: 8,
		utterance: 'the gateway one',
		tests: 'recall by project path',
		expect: { target: SESSIONS.api },
	},
	{
		n: 9,
		utterance: 'pick up that rate limit spike again',
		tests: 'snoozed-tab wake',
		expect: { target: SESSIONS.backend, action: 'recall', tabId: 'tab-rate-limit-spike' },
	},
	{
		n: 10,
		utterance: 'go back to the old auth spike',
		tests: 'closed-tab reopen offer',
		// A closed tab is an offer, not a dispatch: `applyRecallPolicy` attaches the
		// question, so the correct decision here CARRIES a clarify.
		expect: {
			target: SESSIONS.api,
			action: 'recall',
			tabId: 'tab-old-auth-spike',
			clarify: true,
		},
	},
	{
		n: 11,
		utterance: 'how many agents do I have running',
		tests: 'Maestro-level question',
		expect: { target: 'conductor' },
	},
	{
		n: 12,
		utterance: 'which one is busy right now',
		tests: 'fleet-level question',
		expect: { target: 'conductor' },
	},
	{
		n: 13,
		utterance: 'make the dark mode toggle stick',
		tests: 'topic match over recency',
		expect: { target: SESSIONS.frontend, action: 'recall', tabId: 'tab-dark-mode' },
	},
	{
		n: 14,
		utterance: 'do the auth one',
		tests: 'low confidence disambiguation',
		// "Auth Refactor" on Backend and "Old Auth Spike" on API both fit, so the
		// only right answer is a question. Which one it leaned toward is not scored.
		expect: { clarify: true },
		answer: { text: 'the backend one', target: SESSIONS.backend },
	},
	{
		n: 15,
		utterance: 'no, the other one',
		tests: 'correction path',
		expect: {},
		correction: true,
	},
];

// ---------------------------------------------------------------------------
// Brains
// ---------------------------------------------------------------------------

type BrainKey = 'agent' | 'anthropic' | 'openai' | 'local';

interface Options {
	brain: BrainKey;
	agentType: string;
	cwd: string;
	modelPath?: string;
	model?: string;
	json: boolean;
}

/**
 * A `ConductorProcessManager` backed by `child_process`.
 *
 * The real `ProcessManager` cannot run here: it needs Electron, node-pty and the
 * session machinery. The interface is structural for exactly this reason, and the
 * two behaviours the Brain depends on are reproduced faithfully:
 *
 *   - Prompt delivery follows the no-image branch of `ChildProcessSpawner.spawn()`
 *     (`promptArgs`, else `noPromptSeparator`, else a `--` separator).
 *   - The `data` event carries the RESULT text, not raw stdout, the way
 *     `ExitHandler.handleBatchModeExit()` emits it: parse the buffer as JSON and
 *     emit `.result`, falling back to the raw buffer when it is not JSON.
 */
class SpawnProcessManager extends EventEmitter implements ConductorProcessManager {
	private readonly children = new Map<string, ChildProcess>();

	spawn(config: Record<string, unknown>): { pid: number; success: boolean } | null {
		const sessionId = String(config.sessionId);
		const command = String(config.command);
		const args = [...((config.args as string[]) ?? [])];
		const prompt = String(config.prompt ?? '');
		const promptArgs = config.promptArgs as ((value: string) => string[]) | undefined;

		if (promptArgs) args.push(...promptArgs(prompt));
		else if (config.noPromptSeparator) args.push(prompt);
		else args.push('--', prompt);

		const child = spawnChild(command, args, {
			cwd: String(config.cwd),
			env: {
				...childEnv(),
				...((config.customEnvVars as Record<string, string>) ?? {}),
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		this.children.set(sessionId, child);

		let buffer = '';
		child.stdout?.on('data', (chunk: Buffer) => {
			buffer += chunk.toString('utf8');
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			process.stderr.write(chunk);
		});
		child.on('error', (error) => {
			this.children.delete(sessionId);
			this.emit('data', sessionId, `[error] ${error.message}`);
			this.emit('exit', sessionId, 1);
		});
		child.on('close', () => {
			this.children.delete(sessionId);
			this.emit('data', sessionId, extractResult(buffer));
			this.emit('exit', sessionId, 0);
		});

		return { pid: child.pid ?? -1, success: true };
	}

	kill(sessionId: string): void {
		this.children.get(sessionId)?.kill('SIGTERM');
		this.children.delete(sessionId);
	}
}

/** What `ExitHandler.handleBatchModeExit()` would have emitted for this buffer. */
function extractResult(buffer: string): string {
	try {
		const parsed = JSON.parse(buffer) as { result?: unknown };
		if (typeof parsed.result === 'string') return parsed.result;
	} catch {
		/* not JSON: the raw buffer is the answer, same as the real handler */
	}
	return buffer;
}

/**
 * The environment a spawned agent gets.
 *
 * The Claude session-identity markers are stripped for the same reason
 * `sanitizeChildEnv()` in `src/maestro-p/index.ts` strips them: inherited from the
 * shell an agent is running in, they make the child believe it is a nested session.
 */
function childEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of [
		'CLAUDECODE',
		'CLAUDE_CODE_SESSION_ID',
		'CLAUDE_CODE_CHILD_SESSION',
		'CLAUDE_CODE_ENTRYPOINT',
	]) {
		delete env[key];
	}
	return env;
}

async function createBrain(options: Options): Promise<BrainProvider> {
	switch (options.brain) {
		case 'anthropic':
			return new AnthropicBrainProvider({
				model: options.model,
				readCredential: () => process.env.ANTHROPIC_API_KEY?.trim() || null,
			});

		case 'openai':
			return new OpenAiBrainProvider({
				model: options.model,
				readCredential: () => process.env.OPENAI_API_KEY?.trim() || null,
			});

		case 'local':
			return new LlamaBrainProvider({ modelPath: options.modelPath });

		case 'agent': {
			const detector = new AgentDetector();
			const real = await detector.getAgent(options.agentType);
			if (!real || !real.available) {
				throw new Error(
					`The '${options.agentType}' agent is not installed. Install it, or pass --brain anthropic.`
				);
			}
			return new ConductorAgentBrain({
				processManager: new SpawnProcessManager(),
				// A one-shot JSON batch run. The shipping default is stream-json, which
				// this harness's process manager does not reassemble; `--output-format
				// json` produces the single envelope `extractResult()` reads.
				agentDetector: {
					getAgent: async () => ({ ...real, args: batchArgsFor(real.args ?? []) }),
				} as unknown as AgentDetector,
				agentType: options.agentType,
				cwd: options.cwd,
				// A real model may think for a while; the shipping 20s deadline is a
				// voice budget, not an evaluation one.
				timeoutMs: 120_000,
				modelId: options.model,
			});
		}
	}
}

/** Swap a streaming output format for the single-envelope one. */
function batchArgsFor(args: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--output-format') {
			out.push('--output-format', 'json');
			i++;
			continue;
		}
		if (args[i] === '--verbose') continue;
		out.push(args[i]);
	}
	if (!out.includes('--output-format')) out.push('--output-format', 'json');
	return out;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface CaseResult {
	n: number;
	utterance: string;
	tests: string;
	expected: string;
	actual: string;
	hit: boolean;
	confidence: number | null;
	latencyMs: number | null;
	note?: string;
}

async function run(options: Options): Promise<void> {
	// Agent detection alone logs a screenful of PATH probes. The result table is
	// the output of this script; a real problem still comes through as an error.
	logger.setLogLevel('error');

	// The evaluation must measure the SHIPPING prompt, including any local edit,
	// not the built-in fallback constant.
	await initializePrompts();

	const brain = await createBrain(options);
	await probeBrain(brain);

	// A file, not a stub: the harness reports through the same instrument the field
	// reports through, so a hit rate here and a hit rate in the app mean one thing.
	setRoutingLogPath(path.join(os.tmpdir(), `acappella-routing-eval-${process.pid}.json`));
	resetRoutingLog();

	const recentUtterances: string[] = [];
	const context: RoutingContext = {
		agents: ROSTER,
		activeAgentSessionId: ACTIVE_AGENT,
		recentUtterances,
		droppedTabs: 0,
		serializedChars: 0,
	};
	context.serializedChars = serializeRoutingContext(context).length;

	const router = createConductorRouter({
		brain,
		loadContext: async (recent) => ({ ...context, recentUtterances: [...recent] }),
	});

	const results: CaseResult[] = [];
	let lastDispatchTarget: string | null = null;

	for (const testCase of CASES) {
		if (testCase.correction) {
			results.push(evaluateCorrection(testCase, lastDispatchTarget));
			continue;
		}

		const startedAt = Date.now();
		let decision: RouteDecision;
		try {
			decision = await router.route(testCase.utterance, {
				roster: ROSTER,
				scope: { kind: 'conductor' },
				activeAgentSessionId: ACTIVE_AGENT,
				recentUtterances: [...recentUtterances],
			});
		} catch (error) {
			results.push({
				n: testCase.n,
				utterance: testCase.utterance,
				tests: testCase.tests,
				expected: describeExpectation(testCase.expect),
				actual: `error: ${(error as Error).message}`,
				hit: false,
				confidence: null,
				latencyMs: Date.now() - startedAt,
			});
			continue;
		}

		const hit = matches(decision, testCase.expect);
		const turnId = router.lastTurnId();
		if (turnId && !hit) {
			// Exactly what the HUD's correction control does, so the log's hit rate is
			// the number this harness reports rather than a second tally beside it.
			noteRoutingOutcome(turnId, 'corrected', `expected ${describeExpectation(testCase.expect)}`);
		}

		const entry = readRoutingLog().find((candidate) => candidate.id === turnId);
		results.push({
			n: testCase.n,
			utterance: testCase.utterance,
			tests: testCase.tests,
			expected: describeExpectation(testCase.expect),
			actual: describeDecision(decision),
			hit,
			confidence: decision.confidence,
			latencyMs: entry?.latencyMs ?? Date.now() - startedAt,
		});

		recentUtterances.push(testCase.utterance);
		if (!isClarification(decision)) {
			lastDispatchTarget = routeTargetSessionId(decision.target);
		}

		if (testCase.answer && isClarification(decision)) {
			results.push(await evaluateAnswer(router, testCase, decision, recentUtterances));
		}
	}

	report(options, brain, results);
}

/**
 * One throwaway decision before the script starts.
 *
 * A missing key or an uninstalled runtime fails identically on all fifteen
 * utterances, and fifteen copies of "no API key is configured" printed inside a
 * results table reads like a routing result. This turns it back into what it is:
 * the Brain could not be reached, so there is nothing to measure.
 */
async function probeBrain(brain: BrainProvider): Promise<void> {
	try {
		await brain.route('hello', {
			roster: ROSTER,
			scope: { kind: 'conductor' },
			activeAgentSessionId: ACTIVE_AGENT,
		});
	} catch (error) {
		throw new Error(`${brain.label} is not usable here: ${(error as Error).message}`);
	}
}

/**
 * The turn after a disambiguation.
 *
 * Routed with `clarification` set, which is what stops "the backend one" from
 * being treated as a request and becoming a tab called "the backend one".
 */
async function evaluateAnswer(
	router: ReturnType<typeof createConductorRouter>,
	testCase: EvalCase,
	question: RouteDecision,
	recentUtterances: string[]
): Promise<CaseResult> {
	const answer = testCase.answer!;
	const startedAt = Date.now();
	const decision = await router.route(answer.text, {
		roster: ROSTER,
		scope: { kind: 'conductor' },
		activeAgentSessionId: ACTIVE_AGENT,
		recentUtterances: [...recentUtterances],
		clarification: { question: question.clarify!, utterance: testCase.utterance },
	});

	const hit = matches(decision, { target: answer.target });
	const turnId = router.lastTurnId();
	if (turnId && !hit) noteRoutingOutcome(turnId, 'corrected', `expected ${answer.target}`);

	return {
		n: testCase.n,
		utterance: answer.text,
		tests: 'disambiguation answer',
		expected: answer.target,
		actual: describeDecision(decision),
		hit,
		confidence: decision.confidence,
		latencyMs: Date.now() - startedAt,
		note: 'follow-up, excluded from the fifteen',
	};
}

/**
 * A correction never reaches the Brain.
 *
 * Recognised from the utterance alone and turned into a plan against the roster,
 * so what is checked here is the recognition and the plan, not a decision.
 */
function evaluateCorrection(testCase: EvalCase, fromAgent: string | null): CaseResult {
	const recognised = isCorrectionUtterance(testCase.utterance);
	const plan = recognised ? planCorrection(ROSTER, fromAgent ?? '') : null;
	// Four agents means "the other one" does not name anything, so asking is the
	// only honest plan. A `move` here would mean the router guessed twice.
	const hit = recognised && plan?.kind === 'ask';

	return {
		n: testCase.n,
		utterance: testCase.utterance,
		tests: testCase.tests,
		expected: 'recognised as a correction, asks which target',
		actual: recognised ? `correction -> ${plan?.kind}` : 'not recognised as a correction',
		hit: Boolean(hit),
		confidence: null,
		latencyMs: null,
		note: 'not routed, excluded from the hit rate',
	};
}

function matches(decision: RouteDecision, expected: Expectation): boolean {
	const target = routeTargetSessionId(decision.target) ?? 'conductor';
	if (expected.target && target !== expected.target) return false;
	if (Boolean(expected.clarify) !== isClarification(decision)) return false;
	if (expected.action && decision.tabAction !== expected.action) return false;
	if (expected.tabId && decision.tabId !== expected.tabId) return false;
	return true;
}

function describeExpectation(expected: Expectation): string {
	const parts = [expected.target ? nameOf(expected.target) : 'any target'];
	if (expected.action) parts.push(expected.action);
	if (expected.tabId) parts.push(expected.tabId);
	if (expected.clarify) parts.push('clarify');
	return parts.join(' / ');
}

function describeDecision(decision: RouteDecision): string {
	const parts = [nameOf(routeTargetSessionId(decision.target) ?? 'conductor'), decision.tabAction];
	if (decision.tabId) parts.push(decision.tabId);
	if (decision.tabName) parts.push(`"${decision.tabName}"`);
	if (isClarification(decision)) parts.push('clarify');
	return parts.join(' / ');
}

function nameOf(sessionId: string): string {
	return ROSTER.find((agent) => agent.sessionId === sessionId)?.name ?? sessionId;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(options: Options, brain: BrainProvider, results: CaseResult[]): void {
	const quality = routingQuality();

	if (options.json) {
		console.log(JSON.stringify({ brain: brain.id, results, quality }, null, 2));
		return;
	}

	console.log('');
	console.log(`Brain: ${brain.label} (${brain.id})`);
	console.log('');
	console.log('| #   | Utterance | Expected | Actual | Conf | ms | Hit |');
	console.log('| --- | --------- | -------- | ------ | ---- | -- | --- |');
	for (const result of results) {
		console.log(
			`| ${result.n} | ${result.utterance} | ${result.expected} | ${result.actual} | ` +
				`${result.confidence?.toFixed(2) ?? '-'} | ${result.latencyMs ?? '-'} | ` +
				`${result.hit ? 'yes' : 'NO'} |`
		);
	}

	const scored = results.filter((result) => !result.note);
	const hits = scored.filter((result) => result.hit).length;

	console.log('');
	console.log(
		`Script: ${hits}/${scored.length} routed utterances matched. ` +
			'The fifteenth is a correction and is never routed; the extra 14 is the answer to its question.'
	);
	console.log(
		`Routing log: ${quality.dispatched} dispatched, ${quality.corrected} corrected, ` +
			`${quality.clarified} clarified, ${quality.failed} failed.`
	);
	console.log(
		`Hit rate: ${quality.hitRate === null ? '-' : `${(quality.hitRate * 100).toFixed(0)}%`}, ` +
			`mean latency: ${quality.meanLatencyMs ?? '-'} ms.`
	);
	console.log('');
	console.log('Paste the row into docs/architecture/acappella/routing-evaluation.md.');
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Options {
	const options: Options = {
		brain: 'agent',
		agentType: 'claude-code',
		cwd: process.cwd(),
		json: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--brain') options.brain = argv[++i] as BrainKey;
		else if (arg === '--agent-type') options.agentType = argv[++i];
		else if (arg === '--cwd') options.cwd = argv[++i];
		else if (arg === '--model-path') options.modelPath = argv[++i];
		else if (arg === '--model') options.model = argv[++i];
		else if (arg === '--json') options.json = true;
		else throw new Error(`Unknown option: ${arg}`);
	}

	if (!['agent', 'anthropic', 'openai', 'local'].includes(options.brain)) {
		throw new Error(`Unknown brain: ${options.brain}`);
	}
	return options;
}

run(parseArgs(process.argv.slice(2))).catch((error: Error) => {
	console.error(`Routing evaluation failed: ${error.message}`);
	process.exit(1);
});
