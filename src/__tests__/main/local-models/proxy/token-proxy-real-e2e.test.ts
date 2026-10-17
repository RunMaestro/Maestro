/**
 * @file token-proxy-real-e2e.test.ts
 *
 * The Maestro token proxy against real provider traffic, without the app: the
 * real server and the real compressor on a loopback port, and the real Claude
 * Code and Codex CLIs pointed at it.
 *
 * What only this can answer:
 *
 *   - whether each mode (`passthrough`, `compress`, `compress-early`) carries a
 *     session of tool-using turns to the end;
 *   - what each mode COSTS, from the provider's own `usage` on every request
 *     (cache writes and cache reads). `compress-early` exists on the theory that shortening a
 *     result before the model first reads it avoids writing it to the prompt
 *     cache twice. The unit tests cannot say whether that is cheaper;
 *   - whether Codex on a ChatGPT login reaches the proxy when it is given the
 *     config argument the gateway adds (`openai_base_url`).
 *
 * The session is the one from the recorded run in
 * docs/architecture/local-models.md: two turns that each `cat` a build log and
 * answer a question about it, then two one-word turns. Each turn is a new
 * `claude --print --resume` process, the way a Maestro turn is.
 *
 * It SPENDS REAL TOKENS on whichever accounts the two CLIs are logged in to
 * (about a dozen small Haiku requests per mode and one Codex turn), so it is
 * opt-in under its own flag. SKIPPED unless
 *   MAESTRO_TOKEN_PROXY_E2E=1
 * Run with:
 *   MAESTRO_TOKEN_PROXY_E2E=1 env -u MAESTRO_USER_DATA npx vitest run src/__tests__/main/local-models/proxy/token-proxy-real-e2e.test.ts
 * Set MAESTRO_TOKEN_PROXY_E2E_CODEX=0 to leave the Codex turn out.
 *
 * Background requests are a third question, asked only when
 *   MAESTRO_TOKEN_PROXY_E2E_BACKGROUND_MODEL=<catalog model id>
 * names a text model installed in the scratch dir the local-model e2e suites
 * share (`$TMPDIR/maestro-local-model-e2e`, or MAESTRO_LOCAL_MODEL_E2E_DIR),
 * beside the `llama-server` engine. Nothing is downloaded here. It runs one
 * session twice through the product's own proxy service, as a stored agent:
 * once in plain passthrough, once with that agent's background requests sent
 * to the model on the Maestro model server. A recorder stands in front of the
 * provider and another in front of the model server, so the answer is exact:
 * which requests went where, and what the provider said each one it received
 * cost. That session fetches https://example.com/ with WebFetch, so it needs
 * the open network. Claude Code is started two ways in Maestro, and they do
 * not send the same side requests, so the pair of sessions can be run both
 * ways: always as `claude --print`, and also through the TUI when
 *   MAESTRO_TOKEN_PROXY_E2E_MAESTRO_P=<path to a built maestro-p.js>
 * is set (`npm run build:maestro-p` writes `dist/cli/maestro-p.js`).
 *
 * Costs are compared, not asserted: one session per mode is one sample, and
 * the provider's cache state differs between runs. The numbers are written to
 * `token-proxy-e2e-results.json` in the scratch directory and printed.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

const RUN = process.env.MAESTRO_TOKEN_PROXY_E2E === '1';
const RUN_CODEX = RUN && process.env.MAESTRO_TOKEN_PROXY_E2E_CODEX !== '0';
const BACKGROUND_MODEL = (process.env.MAESTRO_TOKEN_PROXY_E2E_BACKGROUND_MODEL ?? '').trim();
const RUN_BACKGROUND = RUN && BACKGROUND_MODEL !== '';
/** A built `maestro-p.js`, to run the background session through the TUI as well. */
const MAESTRO_P = (process.env.MAESTRO_TOKEN_PROXY_E2E_MAESTRO_P ?? '').trim();
/** Where the local-model e2e suites keep the engine and the installed models. */
const MODELS_DIR =
	process.env.MAESTRO_LOCAL_MODEL_E2E_DIR ?? path.join(os.tmpdir(), 'maestro-local-model-e2e');

vi.mock('electron', () => ({
	app: { getPath: () => MODELS_DIR },
	safeStorage: { isEncryptionAvailable: () => false },
}));

import { isInstalled } from '../../../../main/local-models/model-store';
import {
	planBackgroundRoute,
	type BackgroundRouteSkip,
} from '../../../../main/local-models/proxy/background-route';
import { compressRequestBody } from '../../../../main/local-models/proxy/compress';
import { createCompressionCache } from '../../../../main/local-models/proxy/compression-cache';
import {
	createTokenProxyServer,
	type TokenProxyRequestLog,
	type TokenProxyServer,
} from '../../../../main/local-models/proxy/server';
import {
	applyAgentGatewayToSpawn,
	configureTokenProxy,
	ensureTokenProxyPort,
	resetTokenProxyForTests,
} from '../../../../main/local-models/proxy/service';
import { configureAgentRunOn, resetAgentRunOnForTests } from '../../../../main/local-models/run-on';
import { modelServerForHarness } from '../../../../main/local-models/server/server-endpoint';
import { getModelServerReport } from '../../../../main/local-models/server/service';
import {
	configureModelServer,
	resetModelServerForTests,
} from '../../../../main/local-models/server/supervisor';
import { scratchKeySeal } from '../../../helpers/scratchKeySeal';
import { parseBackgroundRequestsEdit } from '../../../../shared/local-models/background-requests';
import { MODEL_SERVER_ENDPOINT_ID } from '../../../../shared/local-models/model-server';
import { formatRunOnSpec } from '../../../../shared/local-models/run-on';
import {
	defaultTokenProxyUpstreams,
	tokenProxyGatewayUrl,
	type TokenProxyRequestMode,
} from '../../../../shared/local-models/token-proxy';
import { providerCliEnv, runProviderCli } from '../../../helpers/providerCli';
import {
	startRecordingRelay,
	type RecordingRelay,
	type RelayedExchange,
} from '../../../helpers/recordingRelay';

if (RUN_BACKGROUND) {
	// `paths.ts` prefers MAESTRO_USER_DATA over Electron. Nothing resolves a path
	// until a test runs, so pinning it here keeps the model server in the scratch dir.
	process.env.MAESTRO_USER_DATA = MODELS_DIR;
}

const TURN_TIMEOUT_MS = 4 * 60_000;
const SESSION_TIMEOUT_MS = 20 * 60_000;

const MODES: TokenProxyRequestMode[] = ['passthrough', 'compress', 'compress-early'];

const TURNS = [
	'Run exactly `cat build.log` with the Bash tool (no pipe, no other command), then tell me in one sentence which module failed to build.',
	'Run exactly `cat build.log` again with the Bash tool (no pipe, no other command), then tell me in one sentence which file and line the TypeScript error is on.',
	'Reply with the single word: ok',
	'Reply with the single word: done',
];

/**
 * A build log the `logs` compressor has something to do with: repeated lines
 * and a repeated stack block, about 24 KB. Fixed text, so every mode and every
 * run reads the same bytes.
 */
function buildLog(): string {
	const lines: string[] = ['$ npm run build', '> app@1.0.0 build', '> tsc -p tsconfig.json', ''];
	const stack = [
		'    at compile (/work/app/node_modules/typescript/lib/tsc.js:118204:21)',
		'    at emitFiles (/work/app/node_modules/typescript/lib/tsc.js:109432:9)',
		'    at Object.executeCommandLine (/work/app/node_modules/typescript/lib/tsc.js:122008:5)',
	];
	for (let i = 0; i < 40; i++) {
		lines.push(`[build] compiling module core/util-${i % 4}.ts`);
		lines.push('[build] warning: retrying after transient cache miss (attempt 1 of 3)');
		lines.push('[build] warning: retrying after transient cache miss (attempt 1 of 3)');
		lines.push(
			'[build] warning: retrying after transient cache miss (attempt 1 of 3)',
			...stack,
			''
		);
	}
	lines.push(
		"src/billing/invoice.ts(212,17): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
		'[build] module billing failed to build',
		...stack,
		'npm ERR! code ELIFECYCLE',
		'npm ERR! errno 2'
	);
	return `${lines.join('\n')}\n`;
}

/** One request to the provider, by the provider's own count. */
interface RequestUsage {
	/** `cache_creation_input_tokens`: prompt tokens written to the cache. */
	write: number;
	/** `cache_read_input_tokens`: prompt tokens read from it. */
	read: number;
	/** Uncached prompt tokens. */
	input: number;
	output: number;
	/** The Bash commands this response asked for. */
	commands: string[];
}

interface StreamLine {
	type?: string;
	subtype?: string;
	session_id?: string;
	is_error?: boolean;
	/** The turn's answer, on the `result` line. */
	result?: string;
	message?: {
		id?: string;
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
		};
		content?: Array<{ type?: string; name?: string; input?: { command?: string } }>;
	};
}

/** One finished turn: its session, each request it made, and its answer. */
interface ClaudeTurn {
	sessionId: string;
	requests: RequestUsage[];
	reply: string;
}

/**
 * One turn, as the stream of JSON lines `--output-format stream-json` prints.
 * Each assistant message is one request; a message printed in several lines
 * (one per content block) carries the same id and the same usage, so it is
 * counted once and its tool calls are gathered.
 */
function parseTurn(stdout: string): ClaudeTurn {
	const byMessage = new Map<string, RequestUsage>();
	let sessionId = '';
	let failed = false;
	let reply = '';
	for (const raw of stdout.split('\n')) {
		if (!raw.trim().startsWith('{')) continue;
		const line = JSON.parse(raw) as StreamLine;
		if (line.session_id) sessionId = line.session_id;
		if (line.type === 'result' && line.is_error) failed = true;
		if (line.type === 'result' && typeof line.result === 'string') reply = line.result;
		if (line.type !== 'assistant' || !line.message?.id) continue;
		const usage = line.message.usage;
		const request = byMessage.get(line.message.id) ?? {
			write: usage?.cache_creation_input_tokens ?? 0,
			read: usage?.cache_read_input_tokens ?? 0,
			input: usage?.input_tokens ?? 0,
			output: 0,
			commands: [],
		};
		// The last line of a message has its final output count.
		request.output = Math.max(request.output, usage?.output_tokens ?? 0);
		for (const block of line.message.content ?? []) {
			if (block.type === 'tool_use' && block.input?.command) {
				request.commands.push(block.input.command);
			}
		}
		byMessage.set(line.message.id, request);
	}
	if (failed || !sessionId) throw new Error(`claude reported an error: ${stdout.slice(-2000)}`);
	return { sessionId, requests: [...byMessage.values()], reply };
}

async function claudeTurn(
	prompt: string,
	options: {
		cwd: string;
		baseUrl: string;
		resume?: string;
		allowedTools?: string[];
		/** Run the turn in Claude Code's TUI, through this `maestro-p.js`. */
		maestroP?: string;
	}
): Promise<ClaudeTurn> {
	const args = [
		'--print',
		'--verbose',
		'--model',
		'haiku',
		// No user hooks or plugins: the request is the CLI's own, the same for every mode.
		'--setting-sources',
		'local',
		'--output-format',
		'stream-json',
		// One argument: maestro-p gives an option it does not know one value.
		'--allowedTools',
		(options.allowedTools ?? ['Bash(cat:*)']).join(','),
		...(options.resume ? ['--resume', options.resume] : []),
	];
	// The prompt goes on stdin: `--allowedTools` takes a list, so a prompt placed
	// after it is read as one more tool name.
	const tui = options.maestroP;
	const result = await runProviderCli(
		tui ? process.execPath : 'claude',
		tui ? [tui, ...args] : args,
		{
			cwd: options.cwd,
			timeoutMs: TURN_TIMEOUT_MS,
			env: providerCliEnv({
				ANTHROPIC_BASE_URL: options.baseUrl,
				// A scratch directory is one the TUI has never been told to trust.
				...(tui ? { MAESTRO_P_ACCEPT_WORKSPACE_TRUST: '1' } : {}),
			}),
			stdin: prompt,
		}
	);
	if (result.code !== 0) {
		throw new Error(
			`${tui ? 'maestro-p' : 'claude'} exited ${result.code}: ${(result.stderr || result.stdout).slice(-2000)}`
		);
	}
	return parseTurn(result.stdout);
}

/**
 * Prompt cost in units of one uncached input token, by Anthropic's published
 * cache multipliers: a 5-minute cache write is 1.25, a cache read 0.1. Output
 * is left out: it is what the model chose to say, not what the proxy changed.
 */
function promptCostUnits(requests: RequestUsage[]): number {
	let units = 0;
	for (const request of requests) {
		units += request.write * 1.25 + request.read * 0.1 + request.input;
	}
	return Math.round(units);
}

interface ModeResult {
	/** Message requests the proxy carried, and how many of them it changed. */
	carried: number;
	changedRequests: number;
	blocksCompressed: number;
	/** The proxy's own figure, at 4 characters per token. */
	estimatedTokensSaved: number;
	addedLatencyMsMax: number;
	/** Per turn, each request as `write / read` with the commands it asked for. */
	turns: RequestUsage[][];
	total: { write: number; read: number; input: number; output: number };
	promptCostUnits: number;
}

/** The turns of the background session: a shell result, a fetched page, one word. */
const BACKGROUND_TURNS = [
	TURNS[0],
	'Use the WebFetch tool on https://example.com/ and tell me in one sentence what the page says the domain is for.',
	TURNS[2],
];
const BACKGROUND_ALLOWED_TOOLS = ['Bash(cat:*)', 'WebFetch(domain:example.com)'];

/** The key seal the model server is given here: the real one needs Electron. */
const seal = scratchKeySeal();

/** The start of a text, on one line, for a record a person reads. */
function head(text: string, length: number): string {
	return text.replace(/\s+/g, ' ').trim().slice(0, length);
}

/** The text of a `system` or `content` value: a string, or the text blocks of a list. */
function blockText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (!Array.isArray(value)) return '';
	return value
		.map((block: { type?: string; text?: string }) => (block?.type === 'text' ? block.text : ''))
		.filter(Boolean)
		.join(' | ');
}

type StatedUsage = NonNullable<NonNullable<StreamLine['message']>['usage']>;

/**
 * What the provider (or a target that speaks its API) said one request cost.
 * A streamed answer states the prompt on `message_start` and the final output
 * on the last `message_delta`; a plain one states both in its `usage`.
 */
function answeredUsage(responseBody: string): { usage: RequestUsage; text: string } {
	const usage: RequestUsage = { write: 0, read: 0, input: 0, output: 0, commands: [] };
	let text = '';
	const read = (value: StatedUsage | undefined): void => {
		if (!value) return;
		usage.write = Math.max(usage.write, value.cache_creation_input_tokens ?? 0);
		usage.read = Math.max(usage.read, value.cache_read_input_tokens ?? 0);
		usage.input = Math.max(usage.input, value.input_tokens ?? 0);
		usage.output = Math.max(usage.output, value.output_tokens ?? 0);
	};
	const events = responseBody.trimStart().startsWith('{')
		? [responseBody]
		: responseBody
				.split('\n')
				.filter((line) => line.startsWith('data: {'))
				.map((line) => line.slice('data: '.length));
	for (const raw of events) {
		let event: {
			usage?: StatedUsage;
			message?: { usage?: StatedUsage };
			content?: unknown;
			delta?: { type?: string; text?: string };
		};
		try {
			event = JSON.parse(raw);
		} catch {
			continue;
		}
		read(event.message?.usage);
		read(event.usage);
		text += blockText(event.content);
		if (event.delta?.type === 'text_delta') text += event.delta.text ?? '';
	}
	return { usage, text };
}

/** One Messages request a recorder saw: its shape, never its content. */
interface RecordedRequest {
	model: string;
	maxTokens: number | null;
	/** How many tools it declares. */
	tools: number;
	/** Its `thinking` setting (`adaptive`, `enabled`, ...), or null when it states none. */
	thinking: string | null;
	/** How each system block starts, and how the last message starts. */
	system: string;
	lastMessage: string;
	/** What the proxy's router says of this body: `route`, or why it is a turn. */
	plan: 'route' | BackgroundRouteSkip;
	status: number;
	durationMs: number;
	usage: RequestUsage;
	/** How the answer starts. */
	answer: string;
}

/** The Messages requests among what a recorder carried. */
function recordedRequests(exchanges: readonly RelayedExchange[]): RecordedRequest[] {
	const requests: RecordedRequest[] = [];
	for (const exchange of exchanges) {
		if (exchange.method !== 'POST' || !/\/v1\/messages(\?|$)/.test(exchange.path)) continue;
		const body = JSON.parse(exchange.requestBody) as {
			model?: string;
			max_tokens?: number;
			tools?: unknown[];
			thinking?: { type?: string };
			system?: unknown;
			messages?: Array<{ content?: unknown }>;
		};
		const plan = planBackgroundRoute(exchange.requestBody, 'claude-code');
		const answered = answeredUsage(exchange.responseBody);
		requests.push({
			model: body.model ?? '',
			maxTokens: body.max_tokens ?? null,
			tools: body.tools?.length ?? 0,
			thinking: body.thinking?.type ?? null,
			system: head(blockText(body.system), 160),
			lastMessage: head(blockText(body.messages?.at(-1)?.content), 160),
			plan: plan.route ? 'route' : plan.reason,
			status: exchange.status,
			durationMs: exchange.durationMs,
			usage: answered.usage,
			answer: head(answered.text, 160),
		});
	}
	return requests;
}

/** One run of the background session. */
interface BackgroundSessionResult {
	/** Each turn's answer. Every turn ended without an error, or the run threw. */
	replies: string[];
	/** Messages requests the proxy carried, and what its router did with each. */
	carried: number;
	routed: number;
	routedTo: string[];
	/** How each routed request ended, as `<status> <outcome>`. */
	routedOutcomes: Record<string, number>;
	stayed: Record<string, number>;
	routedLatencyMsMax: number;
	/** Every Messages request that reached the provider, and that reached the target. */
	provider: RecordedRequest[];
	target: RecordedRequest[];
	/** The provider's count for what reached it, by the formula above. */
	promptCostUnits: number;
	/** The part of that which the router calls a background request. */
	backgroundPromptCostUnits: number;
	outputTokens: number;
}

/** The same session without a target and with one. */
interface BackgroundSessionPair {
	passthrough: BackgroundSessionResult;
	routed: BackgroundSessionResult;
}

const results: {
	platform?: string;
	modes: Partial<Record<TokenProxyRequestMode, ModeResult>>;
	background?: {
		model: string;
		modelLoadMs: number;
		/** The pair of sessions, by how Claude Code was started. */
		print?: BackgroundSessionPair;
		tui?: BackgroundSessionPair;
	};
	codex?: {
		requests: number;
		exitCode: number;
		wallMs: number;
		/** From Codex's first request to the POST that carried the turn. */
		msBeforeTurnWasSent: number | null;
		byRequest: Record<string, number>;
	};
} = { modes: {} };

describe.skipIf(!RUN)('token proxy against real providers (MAESTRO_TOKEN_PROXY_E2E=1)', () => {
	let scratch: string;
	let server: TokenProxyServer | null = null;
	/** The recorders the background case started. */
	const relays: RecordingRelay[] = [];

	/** A proxy in one mode with its own verdict cache; returns the log it fills. */
	async function startProxy(mode: TokenProxyRequestMode, name: string) {
		const log: TokenProxyRequestLog[] = [];
		const cache = createCompressionCache({ dir: () => path.join(scratch, `cache-${name}`) });
		server = createTokenProxyServer({
			onRequest: (entry) => log.push(entry),
			modeFor: () => mode,
			compress: (kind, body, { early }) =>
				compressRequestBody(kind, body, {
					early,
					cache,
					// The heuristic tier only: no local model is part of this question.
					summarize: async () => ({ status: 'skipped' }),
				}),
		});
		const port = await server.listen(0);
		return { log, port };
	}

	async function stopProxy(): Promise<void> {
		await server?.close({ force: true });
		server = null;
	}

	beforeAll(() => {
		scratch = mkdtempSync(path.join(os.tmpdir(), 'maestro-token-proxy-e2e-'));
		results.platform = `${process.platform}-${process.arch}`;
	});

	afterAll(async () => {
		await stopProxy();
		if (RUN_BACKGROUND) {
			await resetTokenProxyForTests();
			await resetModelServerForTests();
			resetAgentRunOnForTests();
			await Promise.all(relays.map((relay) => relay.close()));
		}
		const report = JSON.stringify(results, null, 2);
		const out = path.join(os.tmpdir(), 'maestro-local-model-e2e');
		mkdirSync(out, { recursive: true });
		writeFileSync(path.join(out, 'token-proxy-e2e-results.json'), `${report}\n`);
		console.log(`[token-proxy-e2e] results\n${report}`);
		rmSync(scratch, { recursive: true, force: true });
	});

	it(
		'carries a tool-using Claude Code session in every mode and records what each cost',
		async () => {
			// A throwaway turn first, so the part of the prompt every session shares
			// (system prompt, tool definitions) is in the provider's cache before the
			// first measured mode. Without it the first mode pays that write alone.
			const warm = path.join(scratch, 'claude-warm');
			mkdirSync(warm, { recursive: true });
			const warmProxy = await startProxy('passthrough', 'warm');
			await claudeTurn(TURNS[2], {
				cwd: warm,
				baseUrl: `http://127.0.0.1:${warmProxy.port}/anthropic`,
			});
			await stopProxy();

			for (const mode of MODES) {
				// One directory per mode: Claude Code keys its sessions by cwd.
				const cwd = path.join(scratch, `claude-${mode}`);
				mkdirSync(cwd, { recursive: true });
				writeFileSync(path.join(cwd, 'build.log'), buildLog());
				const { log, port } = await startProxy(mode, mode);
				const baseUrl = `http://127.0.0.1:${port}/anthropic`;

				const turns: RequestUsage[][] = [];
				let resume: string | undefined;
				for (const prompt of TURNS) {
					const turn = await claudeTurn(prompt, { cwd, baseUrl, resume });
					resume = turn.sessionId;
					turns.push(turn.requests);
				}
				await stopProxy();

				const messages = log.filter((entry) => entry.kind === 'anthropic-messages');
				const changed = messages.filter((entry) => entry.compression?.changed);
				const requests = turns.flat();
				results.modes[mode] = {
					carried: messages.length,
					changedRequests: changed.length,
					blocksCompressed: messages.reduce(
						(sum, entry) => sum + (entry.compression?.blocks?.length ?? 0),
						0
					),
					estimatedTokensSaved: messages.reduce(
						(sum, entry) =>
							sum +
							((entry.compression?.originalTokens ?? 0) - (entry.compression?.sentTokens ?? 0)),
						0
					),
					addedLatencyMsMax: Math.max(
						0,
						...messages.map((entry) => entry.compression?.addedLatencyMs ?? 0)
					),
					turns,
					total: {
						write: requests.reduce((sum, request) => sum + request.write, 0),
						read: requests.reduce((sum, request) => sum + request.read, 0),
						input: requests.reduce((sum, request) => sum + request.input, 0),
						output: requests.reduce((sum, request) => sum + request.output, 0),
					},
					promptCostUnits: promptCostUnits(requests),
				};

				// Every turn reached the provider through the proxy and came back whole.
				expect(messages.length).toBeGreaterThanOrEqual(TURNS.length);
				for (const entry of messages) {
					expect(entry.status).toBe(200);
					expect(entry.mode).toBe(mode);
				}
				// Nothing was skipped for a reason (an encoding the proxy cannot read, a failure).
				expect(messages.filter((entry) => entry.compression?.skipped)).toEqual([]);
				if (mode === 'passthrough') expect(changed).toEqual([]);
				else expect(changed.length).toBeGreaterThan(0);
			}

			// The one structural claim about `compress-early`: it shortens a result on
			// the request that first carries it, so it changes at least as many
			// requests as `compress`, which waits one request.
			expect(results.modes['compress-early']!.changedRequests).toBeGreaterThanOrEqual(
				results.modes.compress!.changedRequests
			);
		},
		SESSION_TIMEOUT_MS
	);

	it.skipIf(!RUN_BACKGROUND)(
		'sends only background requests to a local model and records what the provider was spared',
		async () => {
			configureModelServer({ dataDir: () => MODELS_DIR, osSeal: () => seal, safeSend: () => {} });
			expect(
				await isInstalled(BACKGROUND_MODEL),
				`${BACKGROUND_MODEL} is not installed in ${MODELS_DIR}`
			).toBe(true);
			const { engine } = await getModelServerReport();
			expect(engine.installed, 'the llama-server engine is not installed').toBe(true);

			// Loading the model is outside the session, as it is in the other suites:
			// what is measured is the requests, not a cold start.
			const loadStarted = Date.now();
			const loaded = await modelServerForHarness(BACKGROUND_MODEL);
			expect(loaded.ok, loaded.ok ? '' : loaded.error).toBe(true);
			if (!loaded.ok) return;
			const modelLoadMs = Date.now() - loadStarted;

			// One recorder in front of the provider and one in front of the model
			// server: the proxy's log says where a request went, these say which
			// request it was and what the provider counted for it.
			const providerRelay = await startRecordingRelay(defaultTokenProxyUpstreams().anthropic);
			const targetRelay = await startRecordingRelay(loaded.baseUrl);
			relays.push(providerRelay, targetRelay);

			// The stored agent, and the wiring `main/index.ts` does around it. The
			// proxy is the product's own service: it reads this record per request.
			const agent: Record<string, unknown> = {
				id: 'token-proxy-e2e-background',
				name: 'Token proxy e2e',
				toolType: 'claude-code',
			};
			configureAgentRunOn({
				sessions: () => [agent],
				endpoints: () => [],
				shellEnvVars: () => ({}),
				modelServer: async (model) => {
					const ready = await modelServerForHarness(model);
					return ready.ok ? { ...ready, baseUrl: targetRelay.url } : ready;
				},
			});
			const log: TokenProxyRequestLog[] = [];
			configureTokenProxy({
				sessions: () => [agent],
				dataDir: () => scratch,
				createServer: (options) =>
					createTokenProxyServer({
						...options,
						upstreams: { ...defaultTokenProxyUpstreams(), anthropic: providerRelay.url },
						// Kept here and not in the stats database, which is its own suite.
						onRequest: (entry) => log.push(entry),
					}),
			});
			agent.gatewayUrl = tokenProxyGatewayUrl(await ensureTokenProxyPort(), 'anthropic');

			const edit = parseBackgroundRequestsEdit('claude-code', {
				target: { type: 'source', endpointId: MODEL_SERVER_ENDPOINT_ID, model: BACKGROUND_MODEL },
			});
			if (!edit.ok || !edit.backgroundRequests) throw new Error('The target was not accepted.');
			const backgroundRequests = edit.backgroundRequests;

			/** One session as the stored agent: the launch's own base URL, with the agent in it. */
			const runSession = async (
				name: string,
				maestroP?: string
			): Promise<BackgroundSessionResult> => {
				const launch = await applyAgentGatewayToSpawn({
					agentId: String(agent.id),
					toolType: 'claude-code',
					args: [],
				});
				if (!launch.ok || !launch.gateway) throw new Error('The agent was given no gateway.');
				const cwd = path.join(scratch, `claude-background-${name}`);
				mkdirSync(cwd, { recursive: true });
				writeFileSync(path.join(cwd, 'build.log'), buildLog());
				const from = {
					log: log.length,
					provider: providerRelay.exchanges.length,
					target: targetRelay.exchanges.length,
				};

				const replies: string[] = [];
				let resume: string | undefined;
				for (const prompt of BACKGROUND_TURNS) {
					const turn = await claudeTurn(prompt, {
						cwd,
						baseUrl: launch.gateway.url,
						resume,
						allowedTools: BACKGROUND_ALLOWED_TOOLS,
						maestroP,
					});
					resume = turn.sessionId;
					replies.push(head(turn.reply, 240));
				}
				// A request the CLI left when it exited is recorded as its socket closes.
				await new Promise((resolve) => setTimeout(resolve, 500));

				const carried = log.slice(from.log).filter((entry) => entry.kind === 'anthropic-messages');
				const routed = carried.filter((entry) => entry.background?.routedTo !== undefined);
				const stayed: Record<string, number> = {};
				const routedOutcomes: Record<string, number> = {};
				for (const entry of carried) {
					const counts = routed.includes(entry) ? routedOutcomes : stayed;
					const key = routed.includes(entry)
						? `${entry.status} ${entry.outcome}`
						: (entry.background?.skipped ?? 'no-target');
					counts[key] = (counts[key] ?? 0) + 1;
				}
				const provider = recordedRequests(providerRelay.exchanges.slice(from.provider));
				const usages = provider.map((request) => request.usage);
				// The proxy never failed a request, and never answered one itself.
				expect(carried.filter((entry) => entry.outcome === 'upstream-failed')).toEqual([]);
				return {
					replies,
					carried: carried.length,
					routed: routed.length,
					routedTo: [...new Set(routed.map((entry) => entry.background?.routedTo ?? ''))],
					routedOutcomes,
					stayed,
					routedLatencyMsMax: Math.max(
						0,
						...routed.map((entry) => entry.background?.addedLatencyMs ?? 0)
					),
					provider,
					target: recordedRequests(targetRelay.exchanges.slice(from.target)),
					promptCostUnits: promptCostUnits(usages),
					backgroundPromptCostUnits: promptCostUnits(
						provider.filter((request) => request.plan === 'route').map((request) => request.usage)
					),
					outputTokens: usages.reduce((sum, usage) => sum + usage.output, 0),
				};
			};

			const measured: NonNullable<typeof results.background> = {
				model: BACKGROUND_MODEL,
				modelLoadMs,
			};
			results.background = measured;

			const launches = [
				{ how: 'print' as const, maestroP: undefined },
				...(MAESTRO_P ? [{ how: 'tui' as const, maestroP: MAESTRO_P }] : []),
			];
			for (const { how, maestroP } of launches) {
				delete agent.backgroundRequests;
				// A throwaway session first, for the reason the modes above have one.
				// One per launch: the TUI's system prompt is not the print mode's.
				await runSession(`${how}-warm`, maestroP);
				const passthrough = await runSession(`${how}-passthrough`, maestroP);
				agent.backgroundRequests = backgroundRequests;
				const routed = await runSession(`${how}-routed`, maestroP);
				measured[how] = { passthrough, routed };

				// Without a target nothing is read for routing, and the target hears nothing.
				expect(passthrough.routed).toBe(0);
				expect(passthrough.stayed).toEqual({ 'no-target': passthrough.carried });
				expect(passthrough.target).toEqual([]);

				// With one, a request went to the target or to the provider, never to
				// both: the two recorders together saw exactly what the proxy carried.
				expect(routed.routed).toBeGreaterThan(0);
				expect(routed.routedTo).toEqual([formatRunOnSpec(backgroundRequests.target)]);
				expect(routed.target.length).toBe(routed.routed);
				expect(routed.provider.length).toBe(routed.carried - routed.routed);
				// Nothing the router calls a background request reached the provider,
				// and nothing that declares tools (a loop's own request) left it.
				expect(routed.provider.filter((request) => request.plan === 'route')).toEqual([]);
				expect(routed.target.filter((request) => request.tools > 0)).toEqual([]);
				for (const request of routed.target) expect(request.model).toBe(BACKGROUND_MODEL);
			}
		},
		SESSION_TIMEOUT_MS * 2
	);

	it.skipIf(!RUN_CODEX)(
		'carries a Codex turn on a ChatGPT login when Codex is given the config argument',
		async () => {
			const cwd = path.join(scratch, 'codex');
			mkdirSync(cwd, { recursive: true });
			const { log, port } = await startProxy('passthrough', 'codex');
			const url = `http://127.0.0.1:${port}/chatgpt`;

			// The argument `resolveAgentGateway()` adds for Codex, in the place the
			// launch puts it: ahead of the subcommand.
			const started = Date.now();
			const result = await runProviderCli(
				'codex',
				[
					'-c',
					`openai_base_url=${JSON.stringify(url)}`,
					'exec',
					'--skip-git-repo-check',
					'Reply with the single word: ok',
				],
				{ cwd, timeoutMs: TURN_TIMEOUT_MS, env: providerCliEnv({ OPENAI_BASE_URL: url }) }
			);
			await stopProxy();

			const carried = log.filter((entry) => entry.route === 'chatgpt');
			// What Codex asked for and how each kind of request ended, counted.
			const byRequest: Record<string, number> = {};
			for (const entry of carried) {
				const key = `${entry.method} ${entry.path} -> ${entry.status} (${entry.outcome})`;
				byRequest[key] = (byRequest[key] ?? 0) + 1;
			}
			const post = carried.find((entry) => entry.kind === 'openai-responses');
			results.codex = {
				requests: carried.length,
				exitCode: result.code,
				wallMs: Date.now() - started,
				msBeforeTurnWasSent: post
					? post.startedAt - Math.min(...carried.map((entry) => entry.startedAt))
					: null,
				byRequest,
			};
			expect(result.code, (result.stderr || result.stdout).slice(0, 2000)).toBe(0);
			expect(carried.filter((entry) => entry.kind === 'openai-responses').length).toBeGreaterThan(
				0
			);
			expect(carried.some((entry) => entry.status === 200)).toBe(true);
		},
		TURN_TIMEOUT_MS + 30_000
	);
});
