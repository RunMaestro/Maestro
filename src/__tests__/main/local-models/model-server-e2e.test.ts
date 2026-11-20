/**
 * @file model-server-e2e.test.ts
 *
 * The Maestro model server, end to end on real hardware: install the real
 * `llama-server` engine for this platform through the service the card and the
 * CLI call, start it against the smallest installed text model, and prove what
 * a harness needs from it:
 * - all three protocols answer (`/v1/chat/completions`, Anthropic `/v1/messages`,
 *   OpenAI `/v1/responses`), and each refuses a request without the key;
 * - a network start with no usable key is refused, and nothing listens;
 * - a real Claude Code turn and a real Codex turn complete against it, through
 *   the recipes in the model server phase of the Models playbook, when `claude`
 *   and `codex` are on PATH.
 *
 * Unit tests run a stand-in server (`fake-llama-server.mjs`), so they cannot tell
 * whether the pinned build starts here, whether router mode loads a catalog
 * GGUF from the generated presets, or whether a harness accepts what it serves.
 * This is the one test that can, and its numbers (start time, first-token
 * latency, tokens per second) go into `docs/architecture/local-models.md`.
 *
 * Opt-in only (about 12 MB of engine over the network on the first run, a
 * model load, and two harness turns): SKIPPED unless
 *   MAESTRO_LOCAL_MODEL_E2E=1
 * Run with:
 *   MAESTRO_LOCAL_MODEL_E2E=1 env -u MAESTRO_USER_DATA npx vitest run src/__tests__/main/local-models/model-server-e2e.test.ts
 *
 * Installs land in a scratch data dir, never the live Maestro one, and the dir
 * is kept between runs so only the first run pays the downloads. Override it
 * with MAESTRO_LOCAL_MODEL_E2E_DIR. The harness turns spend nothing: both CLIs
 * talk only to the local server.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

const RUN = process.env.MAESTRO_LOCAL_MODEL_E2E === '1';
const DATA_DIR =
	process.env.MAESTRO_LOCAL_MODEL_E2E_DIR ?? path.join(os.tmpdir(), 'maestro-local-model-e2e');

vi.mock('electron', () => ({
	app: { getPath: () => DATA_DIR },
	safeStorage: { isEncryptionAvailable: () => false },
}));

import { downloadLocalModel, verifyLocalModel } from '../../../main/local-models/service';
import { collectServerModels } from '../../../main/local-models/server/presets';
import {
	getModelServerReport,
	installModelServerEngine,
} from '../../../main/local-models/server/service';
import {
	configureModelServer,
	ensureModelServerFor,
	getModelServerKey,
	getModelServerStatus,
	resetModelServerForTests,
	startModelServer,
	stopModelServer,
	updateModelServerConfig,
} from '../../../main/local-models/server/supervisor';
import { isModelServerError } from '../../../main/local-models/errors';
import { scratchKeySeal } from '../../helpers/scratchKeySeal';
import { probePort } from '../../../main/utils/tcp-port';
import {
	getLocalModel,
	localModelGgufFile,
	QWEN3_1_7B_ID,
} from '../../../shared/local-models/model-catalog';
import { isOnPath, providerCliEnv, runProviderCli } from '../../helpers/providerCli';

/** Generous on a slow link: the model alone is 1.1 GB when it is not there yet. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const SERVER_TIMEOUT_MS = 5 * 60_000;
const TURN_TIMEOUT_MS = 5 * 60_000;

const HAS_CLAUDE = RUN && isOnPath('claude');
const HAS_CODEX = RUN && isOnPath('codex');

/**
 * The OS key store, stood in for so the network refusal can take it away. A
 * real seal would need Electron's `safeStorage`, which works only in the app.
 */
let keyStoreAvailable = true;
const seal = scratchKeySeal(() => keyStoreAvailable);

const MB = 1024 * 1024;
const PROMPT = 'Explain in one paragraph why a build cache speeds up CI.';

/** Measurements written at the end, for the architecture doc. */
const results: Record<string, unknown> = {};

let scratch = '';
let model = '';
let contextSize = 0;
let baseUrl = '';
let key = '';

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

/** A JSON POST to the server, with the key unless `withKey` is false. */
async function post(
	route: string,
	body: Record<string, unknown>,
	withKey = true
): Promise<{ status: number; json: Record<string, unknown> }> {
	const response = await fetch(`${baseUrl}${route}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'anthropic-version': '2023-06-01',
			...(withKey ? { authorization: `Bearer ${key}` } : {}),
		},
		body: JSON.stringify(body),
	});
	const text = await response.text();
	let json: Record<string, unknown> = {};
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		json = { raw: text.slice(0, 500) };
	}
	return { status: response.status, json };
}

/** One small request per protocol, in each one's own shape. */
function protocolRequests(): Array<{ route: string; body: Record<string, unknown> }> {
	const ask = 'Reply with the single word: pong';
	const noThinking = { chat_template_kwargs: { enable_thinking: false } };
	return [
		{
			route: '/v1/chat/completions',
			body: { model, messages: [{ role: 'user', content: ask }], max_tokens: 32, ...noThinking },
		},
		{
			route: '/v1/messages',
			body: { model, max_tokens: 32, messages: [{ role: 'user', content: ask }], ...noThinking },
		},
		{
			route: '/v1/responses',
			body: { model, input: ask, max_output_tokens: 32, ...noThinking },
		},
	];
}

describe.skipIf(!RUN)('Maestro model server end to end (MAESTRO_LOCAL_MODEL_E2E=1)', () => {
	beforeAll(() => {
		// `paths.ts` prefers MAESTRO_USER_DATA over Electron. An agent shell
		// exports it pointing at the LIVE data dir, so pin it to the scratch dir.
		process.env.MAESTRO_USER_DATA = DATA_DIR;
		mkdirSync(DATA_DIR, { recursive: true });
		scratch = mkdtempSync(path.join(os.tmpdir(), 'maestro-model-server-e2e-'));
		configureModelServer({
			dataDir: () => DATA_DIR,
			osSeal: () => seal,
			safeSend: () => {},
		});
		results.dataDir = DATA_DIR;
		results.platform = `${process.platform}-${process.arch}`;
		results.cpu = os.cpus()[0]?.model ?? 'unknown';
		results.totalRamMb = Math.round(os.totalmem() / MB);
	});

	afterAll(async () => {
		await resetModelServerForTests();
		rmSync(scratch, { recursive: true, force: true });
		// Recorded rather than asserted: these are the numbers the doc records.
		// Written to a file as well as the console, because vitest swallows the
		// console output of a passing suite.
		const report = JSON.stringify(results, null, 2);
		writeFileSync(path.join(DATA_DIR, 'model-server-e2e-results.json'), `${report}\n`);
		console.log(`[model-server-e2e] results\n${report}`);
	});

	it(
		'installs the llama-server engine for this platform through the service',
		async () => {
			const before = await getModelServerReport();
			expect(before.engine.builds.length).toBeGreaterThan(0);

			const started = Date.now();
			if (!before.engine.installed || before.engine.stale || before.engine.choice !== 'default') {
				await installModelServerEngine('default');
			}
			results.engineInstallMs = Date.now() - started;

			const { engine } = await getModelServerReport();
			expect(engine.installed).toBe(true);
			expect(engine.stale).toBe(false);
			results.engine = {
				release: engine.release,
				build: engine.label,
				kind: engine.kind,
				installedMb: Math.round(engine.bytes / MB),
				accelerator: engine.accelerator?.label ?? null,
				acceleratorProblem: engine.accelerator?.problem ?? null,
			};
			// A host with no usable GPU reports a problem instead; this one must not.
			expect(engine.accelerator?.problem ?? null).toBeNull();
		},
		DOWNLOAD_TIMEOUT_MS
	);

	it(
		'starts against the smallest installed text model and loads it',
		async () => {
			let installed = await collectServerModels();
			if (installed.length === 0) {
				// Nothing to serve: fetch the catalog's small text model, the way the
				// other local-model e2e suites do.
				if (!(await verifyLocalModel(QWEN3_1_7B_ID)).ok) {
					const download = await downloadLocalModel(QWEN3_1_7B_ID);
					expect(download.error ?? null).toBeNull();
				}
				installed = await collectServerModels();
			}
			expect(installed.length).toBeGreaterThan(0);
			const bytesOf = (id: string): number => {
				const entry = getLocalModel(id);
				return (entry && localModelGgufFile(entry)?.bytes) || Number.MAX_SAFE_INTEGER;
			};
			const smallest = [...installed].sort((a, b) => bytesOf(a.id) - bytesOf(b.id))[0];
			model = smallest.id;
			contextSize = smallest.contextSize;

			let started = Date.now();
			const status = await startModelServer();
			results.startMs = Date.now() - started;
			expect(status.state).toBe('running');
			expect(status.host).toBe('127.0.0.1');
			expect(status.models).toContain(model);

			started = Date.now();
			const ensured = await ensureModelServerFor(model);
			results.modelLoadMs = Date.now() - started;
			expect(ensured).toMatchObject({ ok: true, model });
			if (!ensured.ok) return;

			baseUrl = ensured.baseUrl;
			key = await getModelServerKey();
			results.model = {
				id: model,
				ggufMb: Math.round(bytesOf(model) / MB),
				contextSize,
			};
			expect((await getModelServerStatus()).loadedModels).toEqual([model]);
		},
		DOWNLOAD_TIMEOUT_MS
	);

	it(
		'answers all three protocols with the key and refuses each without it',
		async () => {
			const answered: Record<string, number> = {};
			const refused: Record<string, string> = {};
			for (const { route, body } of protocolRequests()) {
				const withKey = await post(route, body);
				answered[route] = withKey.status;
				expect(withKey.status, JSON.stringify(withKey.json).slice(0, 500)).toBe(200);

				const withoutKey = await post(route, body, false);
				const error = withoutKey.json.error as { type?: string } | undefined;
				refused[route] = `${withoutKey.status} ${error?.type ?? ''}`.trim();
				expect(withoutKey.status).toBe(401);
				expect(error?.type).toBe('authentication_error');
			}
			results.protocols = answered;
			results.withoutKey = refused;
		},
		SERVER_TIMEOUT_MS
	);

	it(
		'measures first-token latency and tokens per second',
		async () => {
			// First token: the wall time from the request to the first streamed
			// piece of text, warm (the model is already loaded).
			const started = Date.now();
			const response = await fetch(`${baseUrl}/v1/chat/completions`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
				body: JSON.stringify({
					model,
					messages: [{ role: 'user', content: PROMPT }],
					max_tokens: 200,
					temperature: 0,
					stream: true,
					chat_template_kwargs: { enable_thinking: false },
				}),
			});
			expect(response.status).toBe(200);
			let firstTokenMs: number | null = null;
			const reader = response.body!.getReader();
			const decoder = new TextDecoder();
			let buffered = '';
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffered += decoder.decode(value, { stream: true });
				if (firstTokenMs === null && /"content":"[^"]/.test(buffered)) {
					firstTokenMs = Date.now() - started;
				}
			}
			results.firstTokenMs = firstTokenMs;
			expect(firstTokenMs).not.toBeNull();

			// Throughput by the server's own count (`timings`), on the same prompt the
			// in-process llama e2e measures, so the two engines compare.
			const measured = await post('/v1/chat/completions', {
				model,
				messages: [{ role: 'user', content: PROMPT }],
				max_tokens: 200,
				temperature: 0,
				// The streamed request above cached this prompt; without this the
				// server reports one prompt token and no prompt rate.
				cache_prompt: false,
				chat_template_kwargs: { enable_thinking: false },
			});
			expect(measured.status).toBe(200);
			const timings = measured.json.timings as
				| {
						prompt_n?: number;
						prompt_per_second?: number;
						predicted_n?: number;
						predicted_per_second?: number;
				  }
				| undefined;
			results.throughput = {
				promptTokens: timings?.prompt_n ?? null,
				promptTokensPerSecond: round1(timings?.prompt_per_second ?? 0),
				generatedTokens: timings?.predicted_n ?? null,
				tokensPerSecond: round1(timings?.predicted_per_second ?? 0),
			};
			expect(timings?.predicted_n ?? 0).toBeGreaterThan(0);
		},
		SERVER_TIMEOUT_MS
	);

	it.skipIf(!HAS_CLAUDE)(
		'completes a real Claude Code turn against it (skipped: `claude` is not on PATH)',
		async () => {
			const cwd = path.join(scratch, 'claude');
			mkdirSync(cwd, { recursive: true });
			const env = providerCliEnv({
				ANTHROPIC_BASE_URL: baseUrl,
				ANTHROPIC_AUTH_TOKEN: key,
				ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
				CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextSize),
				// A config dir of its own: no login, hooks, MCP servers or user memory,
				// so the prompt is the CLI's own and the user's session list is untouched.
				CLAUDE_CONFIG_DIR: path.join(scratch, 'claude-config'),
			});
			delete env.ANTHROPIC_API_KEY;

			const started = Date.now();
			const result = await runProviderCli(
				'claude',
				['--print', '--model', model, '--strict-mcp-config', '--output-format', 'json'],
				{ cwd, env, timeoutMs: TURN_TIMEOUT_MS, stdin: 'Reply with the single word: pong' }
			);
			const wallMs = Date.now() - started;
			expect(result.code, (result.stderr || result.stdout).slice(-2000)).toBe(0);

			const turn = JSON.parse(result.stdout) as {
				is_error?: boolean;
				result?: string;
				num_turns?: number;
				usage?: { input_tokens?: number; output_tokens?: number };
			};
			results.claude = {
				wallMs,
				reply: turn.result?.trim().slice(0, 200) ?? null,
				turns: turn.num_turns ?? null,
				inputTokens: turn.usage?.input_tokens ?? null,
				outputTokens: turn.usage?.output_tokens ?? null,
			};
			expect(turn.is_error).toBe(false);
			expect(turn.result?.trim().length ?? 0).toBeGreaterThan(0);
		},
		TURN_TIMEOUT_MS + 30_000
	);

	it.skipIf(!HAS_CODEX)(
		'completes a real Codex turn against it (skipped: `codex` is not on PATH)',
		async () => {
			const cwd = path.join(scratch, 'codex');
			mkdirSync(cwd, { recursive: true });

			const started = Date.now();
			const result = await runProviderCli(
				'codex',
				[
					'-c',
					`model_providers.maestro={name='Maestro',base_url='${baseUrl}/v1',env_key='MAESTRO_LOCAL_KEY',wire_api='responses'}`,
					'-c',
					"model_provider='maestro'",
					'exec',
					'--skip-git-repo-check',
					'-m',
					model,
					'Reply with the single word: pong',
				],
				{ cwd, env: providerCliEnv({ MAESTRO_LOCAL_KEY: key }), timeoutMs: TURN_TIMEOUT_MS }
			);
			const wallMs = Date.now() - started;
			expect(result.code, (result.stderr || result.stdout).slice(-2000)).toBe(0);

			const tokensUsed = /tokens used\s*\n?\s*([\d,]+)/i.exec(`${result.stderr}\n${result.stdout}`);
			results.codex = {
				wallMs,
				reply: result.stdout.trim().split('\n').pop()?.slice(0, 200) ?? null,
				tokensUsed: tokensUsed ? Number(tokensUsed[1].replace(/,/g, '')) : null,
			};
			expect(result.stdout.trim().length).toBeGreaterThan(0);
		},
		TURN_TIMEOUT_MS + 30_000
	);

	it(
		'refuses a network start with no usable key, and nothing listens',
		async () => {
			const { port } = await stopModelServer();
			expect(port).not.toBeNull();
			await updateModelServerConfig({ bind: 'network' });
			// The OS key store the key was sealed with is gone.
			keyStoreAvailable = false;
			try {
				let refusal: unknown = null;
				try {
					await startModelServer();
				} catch (error) {
					refusal = error;
				}
				expect(isModelServerError(refusal)).toBe(true);
				if (isModelServerError(refusal)) {
					expect(refusal.code).toBe('key-unavailable');
					results.networkWithoutKey = `${refusal.code}: ${refusal.message}`;
				}
				const status = await getModelServerStatus();
				expect(status).toMatchObject({ state: 'failed', bind: 'network', pid: null });
				// The port is still free on every interface: nothing was started.
				expect(await probePort(port!, '0.0.0.0')).toEqual({ free: true });
			} finally {
				keyStoreAvailable = true;
				await updateModelServerConfig({ bind: 'local' });
			}
		},
		SERVER_TIMEOUT_MS
	);
});
