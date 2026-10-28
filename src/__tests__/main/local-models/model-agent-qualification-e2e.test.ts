/**
 * @file model-agent-qualification-e2e.test.ts
 *
 * The qualification pass of the model server e2e (`model-server-e2e.test.ts`):
 * which local models can drive a real agent harness. For each named model it
 * starts the Maestro model server on it and runs Claude Code and Codex, each on
 * PATH, through the server on one scripted task in a scratch git repo (read
 * `notes.md`, fix the bug the failing test shows, run `node test.js`, report).
 * The task and the rules that judge a run live in `helpers/agentQualification.ts`.
 *
 * A run passes when the test goes green within 10 turns, the harness itself
 * saw it pass, and no tool call is malformed. A harness qualifies a model when a
 * majority of its attempts pass (3 by default, MAESTRO_LOCAL_MODEL_E2E_ATTEMPTS;
 * the rest are skipped once the majority is settled). Only a model qualified by
 * at least one harness gets the catalog's `agent` role, with those harnesses in
 * `agentHarnesses`. A failed qualification is a RESULT, not a test failure: the
 * suite fails only when the server cannot serve the model or a harness cannot
 * be run at all.
 *
 * Opt-in only. Gigabytes per model and minutes per run: SKIPPED unless
 *   MAESTRO_LOCAL_MODEL_E2E=1
 * The models, from MAESTRO_LOCAL_MODEL_E2E_MODELS:
 *   unset or "installed"  the text models already installed in the scratch dir
 *   "all"                 every catalog text model (downloads what is missing)
 *   <id>,<id>,...         those models (downloads what is missing)
 * Run with:
 *   MAESTRO_LOCAL_MODEL_E2E=1 env -u MAESTRO_USER_DATA npx vitest run src/__tests__/main/local-models/model-agent-qualification-e2e.test.ts
 *
 * On Node 26 the global `fetch` downloads a Hugging Face file at about a
 * twentieth of the link speed (Electron's Node 24 does not), so for a download
 * run the suite under Electron's Node:
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron node_modules/vitest/vitest.mjs run <this file>
 *
 * Installs land in the scratch dir the other local-model e2e suites share
 * (`$TMPDIR/maestro-local-model-e2e`, or MAESTRO_LOCAL_MODEL_E2E_DIR). A model
 * this suite downloads that is 25 GB or larger is deleted after its runs. Every
 * run is merged into `agent-qualification-e2e-results.json` there, and the
 * table in `docs/architecture/local-models.md` is written from it.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

const MODELS_ENV = (process.env.MAESTRO_LOCAL_MODEL_E2E_MODELS ?? '').trim() || 'installed';
const RUN = process.env.MAESTRO_LOCAL_MODEL_E2E === '1';
const ATTEMPTS_ENV = Number(process.env.MAESTRO_LOCAL_MODEL_E2E_ATTEMPTS);
const DATA_DIR =
	process.env.MAESTRO_LOCAL_MODEL_E2E_DIR ?? path.join(os.tmpdir(), 'maestro-local-model-e2e');

vi.mock('electron', () => ({
	app: { getPath: () => DATA_DIR },
	safeStorage: { isEncryptionAvailable: () => false },
}));

// `paths.ts` prefers MAESTRO_USER_DATA over Electron. An agent shell exports it
// pointing at the LIVE data dir, and the model list below is read at collection
// time, so it is pinned to the scratch dir before anything resolves a path.
if (RUN) process.env.MAESTRO_USER_DATA = DATA_DIR;

import { isInstalled } from '../../../main/local-models/model-store';
import { downloadLocalModel, removeLocalModel } from '../../../main/local-models/service';
import {
	getModelServerReport,
	installModelServerEngine,
} from '../../../main/local-models/server/service';
import {
	configureModelServer,
	ensureModelServerFor,
	getModelServerKey,
	modelServerLogPath,
	resetModelServerForTests,
	startModelServer,
	stopModelServer,
} from '../../../main/local-models/server/supervisor';
import { LOCAL_MODEL_CATALOG, getLocalModel } from '../../../shared/local-models/model-catalog';
import type { LocalModelAgentHarness } from '../../../shared/local-models/types';
import { scratchKeySeal } from '../../helpers/scratchKeySeal';
import { isOnPath, providerCliEnv, runProviderCli } from '../../helpers/providerCli';
import {
	checkQualificationRepo,
	claudeCodeQualificationLaunch,
	codexQualificationLaunch,
	harnessQualified,
	judgeQualification,
	qualificationSettled,
	QUALIFICATION_ATTEMPTS,
	readClaudeStream,
	readCodexStream,
	readServerTimings,
	serverLogSince,
	serverLogSize,
	tokensPerSecond,
	writeQualificationRepo,
	type QualificationRecord,
	type QualificationServer,
} from '../../helpers/agentQualification';

const GB = 1024 ** 3;
const DOWNLOAD_TIMEOUT_MS = 4 * 60 * 60_000;
const LOAD_TIMEOUT_MS = 15 * 60_000;
/** One harness run. A run still going at this point fails as `timeout`. */
const RUN_TIMEOUT_MS = 15 * 60_000;
/** A model this suite downloads at this size or larger is deleted after its runs. */
const KEEP_UNDER_BYTES = 25 * GB;
const RESULTS_FILE = path.join(DATA_DIR, 'agent-qualification-e2e-results.json');
const ATTEMPTS =
	Number.isInteger(ATTEMPTS_ENV) && ATTEMPTS_ENV > 0 ? ATTEMPTS_ENV : QUALIFICATION_ATTEMPTS;

const seal = scratchKeySeal();

const TEXT_MODEL_IDS = LOCAL_MODEL_CATALOG.filter((entry) => entry.kind === 'text-gen').map(
	(entry) => entry.id
);

async function resolveModelIds(): Promise<string[]> {
	if (!RUN) return [];
	if (MODELS_ENV === 'all') return TEXT_MODEL_IDS;
	if (MODELS_ENV === 'installed') {
		const installed: string[] = [];
		for (const id of TEXT_MODEL_IDS) if (await isInstalled(id)) installed.push(id);
		return installed;
	}
	return MODELS_ENV.split(',')
		.map((id) => id.trim())
		.filter(Boolean);
}

const ids = await resolveModelIds();

const HARNESSES: Array<{ harness: LocalModelAgentHarness; command: string; available: boolean }> = [
	{ harness: 'claude-code', command: 'claude', available: RUN && isOnPath('claude') },
	{ harness: 'codex', command: 'codex', available: RUN && isOnPath('codex') },
];

let scratch = '';
/** `--version` of each harness on PATH, recorded beside the results. */
const harnessVersions: Record<string, string> = {};

/** One harness's attempts on one model, and whether they qualified it. */
interface HarnessResults {
	qualified: boolean;
	attempts: QualificationRecord[];
}

interface ModelResults {
	runs: Partial<Record<LocalModelAgentHarness, HarnessResults>>;
	contextSize: number;
	loadMs?: number;
	removedAfter: boolean;
}

function readResults(): Record<string, unknown> {
	if (!existsSync(RESULTS_FILE)) return {};
	return JSON.parse(readFileSync(RESULTS_FILE, 'utf8')) as Record<string, unknown>;
}

/** Merge one model's results into the file, so runs of different models accumulate. */
function record(id: string, results: ModelResults): void {
	const merged = readResults();
	const models = (merged.models ?? {}) as Record<string, ModelResults>;
	models[id] = { ...results, runs: { ...models[id]?.runs, ...results.runs } };
	merged.host = {
		platform: `${process.platform}-${process.arch}`,
		cpu: os.cpus()[0]?.model ?? 'unknown',
		totalRamGb: Math.round(os.totalmem() / GB),
	};
	merged.harnessVersions = harnessVersions;
	merged.models = models;
	writeFileSync(RESULTS_FILE, `${JSON.stringify(merged, null, 2)}\n`);
}

/** One harness on one model: a fresh repo, the run, and its verdict. */
async function qualify(
	harness: LocalModelAgentHarness,
	command: string,
	server: QualificationServer
): Promise<{ record: QualificationRecord; stdout: string; stderr: string }> {
	const runDir = mkdtempSync(path.join(scratch, `${server.model}-${harness}-`));
	const repo = path.join(runDir, 'repo');
	writeQualificationRepo(repo);
	const home = path.join(runDir, 'home');
	mkdirSync(home, { recursive: true });
	const launch =
		harness === 'claude-code'
			? claudeCodeQualificationLaunch(server, home)
			: codexQualificationLaunch(server, home);
	const env = providerCliEnv(launch.env);
	// Claude Code prefers an API key over the server's token when both are set.
	delete env.ANTHROPIC_API_KEY;

	const logFrom = serverLogSize(modelServerLogPath());
	const result = await runProviderCli(command, launch.args, {
		cwd: repo,
		env,
		timeoutMs: RUN_TIMEOUT_MS,
	});
	const transcript =
		harness === 'claude-code' ? readClaudeStream(result.stdout) : readCodexStream(result.stdout);
	const state = checkQualificationRepo(repo);
	const verdict = judgeQualification({ transcript, repo: state, timedOut: result.timedOut });
	const timings = readServerTimings(serverLogSince(modelServerLogPath(), logFrom));
	writeFileSync(path.join(runDir, 'stdout.jsonl'), result.stdout);
	writeFileSync(path.join(runDir, 'stderr.txt'), result.stderr);
	return {
		record: {
			harness,
			checkedAt: new Date().toISOString(),
			...verdict,
			turns: transcript.turns,
			toolCalls: transcript.toolCalls,
			wallMs: result.wallMs,
			tokensPerSecond: tokensPerSecond(timings.generatedTokens, timings.generationMs),
			promptTokensPerSecond: tokensPerSecond(timings.promptTokens, timings.promptMs),
			requests: timings.requests,
			compactions: transcript.compactions,
		},
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

describe.skipIf(!RUN)('agent qualification through the model server (opt-in)', () => {
	beforeAll(async () => {
		mkdirSync(DATA_DIR, { recursive: true });
		// Kept under the data dir rather than removed: a failed run's stream is
		// the evidence for its failure mode.
		scratch = mkdtempSync(path.join(DATA_DIR, 'qualification-'));
		configureModelServer({ dataDir: () => DATA_DIR, osSeal: () => seal, safeSend: () => {} });
		const { engine } = await getModelServerReport();
		if (!engine.installed || engine.stale || engine.choice !== 'default') {
			await installModelServerEngine('default');
		}
		for (const { command, available } of HARNESSES) {
			if (!available) continue;
			const version = await runProviderCli(command, ['--version'], {
				cwd: scratch,
				env: providerCliEnv({}),
				timeoutMs: 30_000,
			});
			harnessVersions[command] = version.stdout.trim().split('\n').pop() ?? '';
		}
	}, DOWNLOAD_TIMEOUT_MS);

	afterAll(async () => {
		await resetModelServerForTests();
		// Compared, not asserted: a different machine or harness version may
		// disagree with the catalog, and that is what the doc table is for.
		const models = (readResults().models ?? {}) as Record<string, ModelResults>;
		const drift: string[] = [];
		for (const id of ids) {
			const runs = models[id]?.runs ?? {};
			const passed = HARNESSES.filter(({ harness }) => runs[harness]?.qualified).map(
				(h) => h.harness
			);
			const catalog = getLocalModel(id)?.agentHarnesses ?? [];
			if (passed.join(',') !== catalog.join(',')) {
				drift.push(`${id}: passed [${passed.join(', ')}], catalog [${catalog.join(', ')}]`);
			}
		}
		console.log(
			drift.length
				? `[agent-qualification-e2e] catalog drift\n${drift.join('\n')}`
				: '[agent-qualification-e2e] catalog agrees with every result'
		);
	});

	it('names only text models the catalog has, and at least one harness is on PATH', () => {
		expect(ids.length, `no models to qualify (${MODELS_ENV})`).toBeGreaterThan(0);
		for (const id of ids) expect(getLocalModel(id)?.kind, id).toBe('text-gen');
		expect(HARNESSES.some((h) => h.available)).toBe(true);
	});

	it.each(ids)(
		'qualifies %s with each harness',
		async (id) => {
			const entry = getLocalModel(id)!;
			const results: ModelResults = {
				runs: {},
				contextSize: entry.defaultContext!,
				removedAfter: false,
			};
			let downloaded = false;
			try {
				if (!(await isInstalled(id))) {
					const download = await downloadLocalModel(id);
					expect(download.error ?? null).toBeNull();
					downloaded = true;
				}

				// A fresh server per model: the presets file is written at start.
				await stopModelServer();
				const started = Date.now();
				await startModelServer();
				const ensured = await ensureModelServerFor(id);
				results.loadMs = Date.now() - started;
				expect(ensured).toMatchObject({ ok: true, model: id });
				if (!ensured.ok) return;

				const server: QualificationServer = {
					baseUrl: ensured.baseUrl,
					key: await getModelServerKey(),
					model: id,
					contextSize: entry.defaultContext!,
				};
				for (const { harness, command, available } of HARNESSES) {
					if (!available) continue;
					const attempts: QualificationRecord[] = [];
					while (!qualificationSettled(attempts, ATTEMPTS)) {
						const run = await qualify(harness, command, server);
						attempts.push(run.record);
						results.runs[harness] = {
							qualified: harnessQualified(attempts, ATTEMPTS),
							attempts,
						};
						record(id, results);
						// The harness must at least have run: an empty stream is a broken
						// recipe or install, not a verdict on the model.
						expect(
							run.stdout.trim().length,
							`${harness} produced no output: ${run.stderr.slice(-1000)}`
						).toBeGreaterThan(0);
					}
				}
			} finally {
				await stopModelServer();
				if (downloaded && entry.bytes >= KEEP_UNDER_BYTES) {
					await removeLocalModel(id);
					results.removedAfter = true;
				}
				record(id, results);
			}
		},
		DOWNLOAD_TIMEOUT_MS + LOAD_TIMEOUT_MS + HARNESSES.length * ATTEMPTS * RUN_TIMEOUT_MS
	);
});
