/**
 * @file run-on-e2e.test.ts
 *
 * Run on, end to end on real hardware: an agent record whose `runOn` names the
 * Maestro model server, launched through the product's own path, with the real
 * harness and a real model.
 *
 * The path is `testAgentRunOn()`, the function behind the Test button and
 * `maestro-cli agent test-run-on`. It is the agent's own launch (the stored
 * record, `prepareLaunchRunOn`, `buildAgentLaunchPlan`, `runToCompletion`), so
 * nothing here builds a command by hand. The stores are wired the way
 * `main/index.ts` wires them, with the real model server behind
 * `modelServerForHarness`.
 *
 * For every provider that has a Run on recipe and whose CLI is on PATH, one
 * turn must complete, and three things must show the server served it:
 * - the process was started with the server's address, the server's key and
 *   the target's model, and nothing else as the model;
 * - the server's log gained a generation while the turn ran;
 * - the harness had no login to fall back on: each runs in a home of its own.
 *
 * A harness that is not on PATH is skipped, and its test title says so. A
 * target the server cannot serve must be refused by name with nothing spawned.
 *
 * Unit tests inject the turn, so they cannot tell whether a real harness
 * accepts the variables and arguments the plan gives it, or whether a real
 * model answers through them. This is the one test that can, and its numbers
 * go into `docs/architecture/local-models.md`.
 *
 * Opt-in only (a model load and one turn per harness): SKIPPED unless
 *   MAESTRO_LOCAL_MODEL_E2E=1
 * The model is the first id in MAESTRO_LOCAL_MODEL_E2E_MODELS when one is
 * named, else the first installed text model that qualified as an agent with
 * the most harnesses. It is never downloaded here: install one with the model
 * server or qualification suite first.
 * Run with:
 *   MAESTRO_LOCAL_MODEL_E2E=1 env -u MAESTRO_USER_DATA npx vitest run src/__tests__/main/local-models/run-on-e2e.test.ts
 *
 * Installs are read from the scratch dir the other local-model e2e suites share
 * (`$TMPDIR/maestro-local-model-e2e`, or MAESTRO_LOCAL_MODEL_E2E_DIR). The turns
 * spend nothing: every harness talks only to the local server. Results are
 * written to `run-on-e2e-results.json` there.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

const RUN = process.env.MAESTRO_LOCAL_MODEL_E2E === '1';
const MODELS_ENV = (process.env.MAESTRO_LOCAL_MODEL_E2E_MODELS ?? '').trim();
const DATA_DIR =
	process.env.MAESTRO_LOCAL_MODEL_E2E_DIR ?? path.join(os.tmpdir(), 'maestro-local-model-e2e');

vi.mock('electron', () => ({
	app: { getPath: () => DATA_DIR },
	safeStorage: { isEncryptionAvailable: () => false },
}));

import { getAgentDefinition } from '../../../main/agents';
import { isInstalled } from '../../../main/local-models/model-store';
import { configureAgentRunOn, resetAgentRunOnForTests } from '../../../main/local-models/run-on';
import {
	configureRunOnTest,
	resetRunOnTestForTests,
	testAgentRunOn,
} from '../../../main/local-models/run-on-test';
import { modelServerForHarness } from '../../../main/local-models/server/server-endpoint';
import { getModelServerReport } from '../../../main/local-models/server/service';
import {
	configureModelServer,
	getModelServerKey,
	getModelServerStatus,
	modelServerLogPath,
	resetModelServerForTests,
} from '../../../main/local-models/server/supervisor';
import { scratchKeySeal } from '../../helpers/scratchKeySeal';
import { AGENT_IDS } from '../../../shared/agentIds';
import { LOCAL_MODEL_CATALOG, getLocalModel } from '../../../shared/local-models/model-catalog';
import { MODEL_SERVER_ENDPOINT_ID } from '../../../shared/local-models/model-server';
import {
	agentRunOnSupport,
	parseRunOnEdit,
	runOnDefaultContextTokens,
	type RunOnTestResult,
} from '../../../shared/local-models/run-on';
import { runToCompletion } from '../../../shared/maestro-lib/run/run-to-completion';
import type { TurnProcessSpec } from '../../../shared/maestro-lib/run/start-turn';
import {
	readServerTimings,
	serverLogSince,
	serverLogSize,
	tokensPerSecond,
} from '../../helpers/agentQualification';
import { isOnPath, providerCliEnv, runProviderCli } from '../../helpers/providerCli';

if (RUN) {
	// The launch plan builds the harness's environment from this process's, as
	// the desktop app does from its own. An agent shell is not that environment:
	// its `CLAUDE_CODE_*` and Maestro variables would reach the harness.
	const clean = providerCliEnv({});
	for (const key of Object.keys(process.env)) if (!(key in clean)) delete process.env[key];
	// `paths.ts` prefers MAESTRO_USER_DATA over Electron. Nothing resolves a path
	// until a test runs, so pinning it here keeps every one in the scratch dir.
	process.env.MAESTRO_USER_DATA = DATA_DIR;
}

const GB = 1024 ** 3;
/** Loading the model: `ensureModelServerFor` waits for a cold load from disk. */
const LOAD_TIMEOUT_MS = 15 * 60_000;
/** The product's own turn budget is 5 minutes; this is the test's on top of the load. */
const TURN_TIMEOUT_MS = 7 * 60_000;
const RESULTS_FILE = path.join(DATA_DIR, 'run-on-e2e-results.json');

const seal = scratchKeySeal();

/**
 * A home of its own for each harness, set the way a user would set it: in the
 * agent's own environment variables. It keeps the user's login, hooks, MCP
 * servers and memory out of the turn, and the user's session list untouched.
 * A provider that gains a recipe needs a row here before this suite passes.
 */
const HARNESS_HOMES: Readonly<Record<string, (home: string) => Record<string, string>>> = {
	'claude-code': (home) => ({ CLAUDE_CONFIG_DIR: home }),
	codex: (home) => ({ CODEX_HOME: home }),
	'copilot-cli': (home) => ({ COPILOT_HOME: home }),
	opencode: (home) => ({
		XDG_CONFIG_HOME: path.join(home, 'config'),
		XDG_DATA_HOME: path.join(home, 'data'),
		XDG_STATE_HOME: path.join(home, 'state'),
	}),
};

/** Every provider with a Run on recipe, and the command its harness is started with. */
const HARNESSES = AGENT_IDS.filter((id) => agentRunOnSupport(id).supported).map((toolType) => {
	const command = getAgentDefinition(toolType)?.command ?? toolType;
	return { toolType, command, available: RUN && isOnPath(command) };
});

interface HarnessRecord {
	command: string;
	version?: string;
	skipped?: string;
	ok?: boolean;
	code?: string;
	message?: string;
	reply?: string;
	durationMs?: number;
	requests?: number;
	promptTokens?: number;
	generatedTokens?: number;
	tokensPerSecond?: number | null;
}

/** The first named model, else the installed agent model the most harnesses qualified. */
async function pickModel(): Promise<string | null> {
	const named = MODELS_ENV.split(',')
		.map((id) => id.trim())
		.filter((id) => id && id !== 'installed' && id !== 'all');
	if (named.length > 0) return named[0];
	const agents = LOCAL_MODEL_CATALOG.filter(
		(entry) => entry.kind === 'text-gen' && entry.roles?.includes('agent')
	).sort((a, b) => (b.agentHarnesses?.length ?? 0) - (a.agentHarnesses?.length ?? 0));
	for (const entry of agents) if (await isInstalled(entry.id)) return entry.id;
	return null;
}

describe.skipIf(!RUN)('Run on end to end (MAESTRO_LOCAL_MODEL_E2E=1)', () => {
	let scratch = '';
	let model = '';
	let contextTokens = 0;
	/** The stored agent records, as the sessions store would hold them. */
	const agents: Array<Record<string, unknown>> = [];
	/** Every process the test path started, in order. */
	const spawned: TurnProcessSpec[] = [];
	const results: Record<string, HarnessRecord> = {};
	let loadMs: number | undefined;

	function writeResults(): void {
		const report = {
			checkedAt: new Date().toISOString(),
			host: {
				platform: `${process.platform}-${process.arch}`,
				cpu: os.cpus()[0]?.model ?? 'unknown',
				totalRamGb: Math.round(os.totalmem() / GB),
			},
			model,
			contextTokens,
			loadMs,
			harnesses: results,
		};
		writeFileSync(RESULTS_FILE, `${JSON.stringify(report, null, 2)}\n`);
	}

	/** Store an agent on the server model, through the check every writer uses. */
	function storeAgent(toolType: string, modelId: string): string {
		const runDir = mkdtempSync(path.join(scratch, `${toolType}-`));
		const cwd = path.join(runDir, 'cwd');
		const home = path.join(runDir, 'home');
		mkdirSync(cwd, { recursive: true });
		mkdirSync(home, { recursive: true });
		const edit = parseRunOnEdit(toolType, {
			type: 'source',
			endpointId: MODEL_SERVER_ENDPOINT_ID,
			model: modelId,
			contextTokens,
		});
		if (!edit.ok || !edit.target) throw new Error(`The target was not accepted for ${toolType}.`);
		const id = `run-on-e2e-${toolType}-${agents.length}`;
		agents.push({
			id,
			name: `Run on e2e ${toolType}`,
			toolType,
			cwd,
			projectRoot: cwd,
			customEnvVars: HARNESS_HOMES[toolType]?.(home) ?? {},
			runOn: edit.target,
		});
		return id;
	}

	beforeAll(async () => {
		mkdirSync(DATA_DIR, { recursive: true });
		// Kept under the data dir rather than removed: a failed turn's home and
		// session files are the evidence for why it failed.
		scratch = mkdtempSync(path.join(DATA_DIR, 'run-on-'));
		configureModelServer({ dataDir: () => DATA_DIR, osSeal: () => seal, safeSend: () => {} });
		// The wiring `main/index.ts` does, over an in-memory sessions store.
		configureAgentRunOn({
			sessions: () => agents,
			endpoints: () => [],
			shellEnvVars: () => ({}),
			modelServer: modelServerForHarness,
		});
		configureRunOnTest({
			agentConfig: () => ({}),
			// Not detected: the harness is started by name and found on PATH.
			detectedAgentPath: async () => undefined,
			sshStore: () => ({ getSshRemotes: () => [] }),
			shellEnvVars: () => ({}),
			runTurn: (spec, options) => {
				spawned.push(spec);
				return runToCompletion(spec, options);
			},
		});

		model = (await pickModel()) ?? '';
		const entry = getLocalModel(model);
		contextTokens = runOnDefaultContextTokens({
			endpointId: MODEL_SERVER_ENDPOINT_ID,
			model,
		});
		for (const { toolType, command, available } of HARNESSES) {
			results[toolType] = { command };
			if (!available) {
				results[toolType].skipped = `${command} is not on PATH`;
				console.log(`[run-on-e2e] skipping ${toolType}: \`${command}\` is not on PATH`);
				continue;
			}
			const version = await runProviderCli(command, ['--version'], {
				cwd: scratch,
				env: providerCliEnv({}),
				timeoutMs: 30_000,
			});
			results[toolType].version = version.stdout.trim().split('\n')[0] ?? '';
		}
		if (entry) writeResults();
	}, LOAD_TIMEOUT_MS);

	afterAll(async () => {
		await resetModelServerForTests();
		resetAgentRunOnForTests();
		resetRunOnTestForTests();
		if (model) {
			writeResults();
			console.log(`[run-on-e2e] results\n${JSON.stringify(results, null, 2)}`);
		}
	});

	it('has an installed agent model, the engine, and a home for every provider with a recipe', async () => {
		expect(model, 'no agent model is installed in the scratch dir').not.toBe('');
		expect(getLocalModel(model)?.kind, model).toBe('text-gen');
		expect(await isInstalled(model), `${model} is not installed`).toBe(true);
		const { engine } = await getModelServerReport();
		expect(engine.installed, 'the llama-server engine is not installed').toBe(true);
		expect(HARNESSES.length).toBeGreaterThan(0);
		for (const { toolType } of HARNESSES) {
			expect(HARNESS_HOMES[toolType], `${toolType} has no home in HARNESS_HOMES`).toBeTypeOf(
				'function'
			);
		}
	});

	it(
		'refuses a model the server does not have, by name, and spawns nothing',
		async () => {
			const toolType = HARNESSES[0].toolType;
			const before = spawned.length;
			const result = await testAgentRunOn({
				agentId: storeAgent(toolType, 'run-on-e2e-no-such-model'),
			});
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.code).toBe('run-on-server-failed');
			expect(result.message).toContain('run-on-e2e-no-such-model');
			expect(spawned.length).toBe(before);
		},
		LOAD_TIMEOUT_MS
	);

	it.for(HARNESSES)(
		'completes a real $toolType turn served by the model server',
		async ({ toolType, command, available }, { skip }) => {
			skip(!available, `\`${command}\` is not on PATH`);
			const agentId = storeAgent(toolType, model);

			// Loading the model is outside the turn's budget, as it is for a user:
			// it is done here once so each harness's time is the turn alone.
			if (loadMs === undefined) {
				const started = Date.now();
				const server = await modelServerForHarness(model);
				expect(server.ok, server.ok ? '' : server.error).toBe(true);
				loadMs = Date.now() - started;
			}

			const logPath = modelServerLogPath();
			const logFrom = serverLogSize(logPath);
			const before = spawned.length;
			const result: RunOnTestResult = await testAgentRunOn({ agentId });
			const timings = readServerTimings(serverLogSince(logPath, logFrom));

			Object.assign(results[toolType], {
				ok: result.ok,
				...(result.ok ? { reply: result.reply } : { code: result.code, message: result.message }),
				durationMs: result.durationMs,
				requests: timings.requests,
				promptTokens: timings.promptTokens,
				generatedTokens: timings.generatedTokens,
				tokensPerSecond: tokensPerSecond(timings.generatedTokens, timings.generationMs),
			});
			writeResults();

			expect(result.ok, result.ok ? '' : `${result.code}: ${result.message}`).toBe(true);
			if (!result.ok) return;
			expect(result.model).toBe(model);
			expect(result.contextTokens).toBe(contextTokens);
			expect(result.reply.toLowerCase()).toContain('ready');

			// One process, started on the server: its address, its key, its model.
			expect(spawned.length).toBe(before + 1);
			const spec = spawned[before];
			const status = await getModelServerStatus();
			const key = await getModelServerKey();
			const launch = [...spec.args, ...Object.values(spec.env ?? {})].join('\n');
			expect(status.state).toBe('running');
			expect(status.loadedModels).toContain(model);
			expect(launch).toContain(status.baseUrl!);
			expect(Object.values(spec.env ?? {})).toContain(key);
			expect(spec.args.some((arg) => arg === model || arg.endsWith(`/${model}`))).toBe(true);
			expect(spec.cwd).toBe(agents.find((agent) => agent.id === agentId)?.cwd);

			// And the server did the work while the turn ran.
			expect(timings.requests).toBeGreaterThan(0);
			expect(timings.generatedTokens).toBeGreaterThan(0);
		},
		LOAD_TIMEOUT_MS + TURN_TIMEOUT_MS
	);
});
