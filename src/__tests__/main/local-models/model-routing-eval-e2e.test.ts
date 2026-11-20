/**
 * @file model-routing-eval-e2e.test.ts
 *
 * Model routing, measured. Every router the `model-routing` task can be
 * assigned is asked, through `routeTurn` (the call a send makes), about the
 * same hand-labeled coding requests, on real models:
 *
 *   - the embedding router, on each catalog embedding model;
 *   - a local judge, on each small text model, in-process and on the Maestro
 *     model server, with the server on its default device and forced to the CPU
 *     (`--device none`) as a stand-in for a laptop without a GPU;
 *   - System One on the hosted Jev, when a key resolves.
 *
 * For each it reports how often the router agrees with the labels (tier and
 * effort), which way it misses (too little model is the costly way), the
 * latency a send would feel (cold, p50, p95, and the share of answers inside
 * the 400 ms a typed send waits), and what 1,000 decisions cost. The numbers go
 * into `docs/architecture/local-models.md`.
 *
 * **The set is split, and nothing is tuned on the half that is reported.** The
 * TUNE half is `MODEL_ROUTING_EXAMPLES`, the prompts the embedding router ships
 * with: how many neighbours vote, and whether a vote's margin says anything, is
 * worked out there by leave-one-out. The REPORT half is the fixture
 * `src/__tests__/fixtures/model-routing-prompts.json`; agreement is reported on
 * it with the constants the app ships, and it selects nothing.
 *
 * What is ASSERTED is structure: every routing is a decision or a named skip,
 * every one is in the decision ledger once, and no router failed in a way
 * `routeTurn` could not classify. Quality and speed are RECORDED: a slow
 * machine is a finding, not a broken build. Quality is asserted only where the
 * catalog makes a promise: a curated model the task still offers
 * (`isLocalModelOfferedForTask`) must tell the tiers apart, which is to say it
 * must beat a router that answers one level for everything. So recording a
 * model under the task's `unofferedLocalModels` is the only way to keep a
 * failing router in the catalog.
 *
 * Opt-in only. SKIPPED unless one of these is set; each runs what it can:
 *   MAESTRO_LOCAL_MODEL_E2E=1   the local routers (a model that is not in the
 *                               scratch dir is downloaded: 34 MB to 2.7 GB)
 *   MAESTRO_JEV_E2E=1           the hosted Jev (about 40 small requests, a
 *                               fraction of a cent; it skips with no key)
 * Choose the local candidates with
 *   MAESTRO_LOCAL_MODEL_E2E_MODELS=<id>,<id>,...
 * An embedding model is measured as the embedding router and a text model as a
 * local judge, the way `modelRouterKind` reads an assignment. Add CPU runs
 * held to a thread count (an 18-core desktop CPU is not a laptop's) with
 *   MAESTRO_ROUTING_EVAL_CPU_THREADS=4,8
 * Run with (Electron's Node, the runtime the app loads the models in):
 *   MAESTRO_LOCAL_MODEL_E2E=1 MAESTRO_JEV_E2E=1 ELECTRON_RUN_AS_NODE=1 env -u MAESTRO_USER_DATA \
 *     node_modules/electron/dist/Electron.app/Contents/MacOS/Electron node_modules/vitest/vitest.mjs run \
 *     src/__tests__/main/local-models/model-routing-eval-e2e.test.ts
 *
 * Installs land in the scratch data dir the other local-model suites share,
 * never the live Maestro one. The prompts are made up, so nothing of the user's
 * is sent anywhere. The Jev key is never printed. Measurements go to the
 * console and to `model-routing-eval-results.json` in the scratch dir.
 */

import { describe, it, expect, vi, beforeAll, afterAll, type TestContext } from 'vitest';
import {
	execFileSync,
	spawn as spawnProcess,
	type ChildProcess,
	type SpawnOptions,
} from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const LOCAL = process.env.MAESTRO_LOCAL_MODEL_E2E === '1';
const JEV = process.env.MAESTRO_JEV_E2E === '1';
const MODELS_ENV = (process.env.MAESTRO_LOCAL_MODEL_E2E_MODELS ?? '').trim();
const CPU_THREADS_ENV = (process.env.MAESTRO_ROUTING_EVAL_CPU_THREADS ?? '').trim();
const DATA_DIR =
	process.env.MAESTRO_LOCAL_MODEL_E2E_DIR ?? path.join(os.tmpdir(), 'maestro-local-model-e2e');
const RESULTS_FILE = path.join(DATA_DIR, 'model-routing-eval-results.json');

/** The settings the routers read: the one assignment under test. */
const settings = vi.hoisted(() => new Map<string, unknown>());
/** Every decision a router filed, in order. The ledger itself is not opened. */
const ledger = vi.hoisted(() => [] as Array<Record<string, unknown>>);
/** Failures `routeTurn` could not classify. Any entry fails the run. */
const unexpected = vi.hoisted(() => [] as string[]);

vi.mock('electron', () => ({
	app: { getPath: () => DATA_DIR },
	safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: (key: string, fallback?: unknown) => (settings.has(key) ? settings.get(key) : fallback),
	}),
}));
vi.mock('../../../main/stats/singleton', () => ({
	getStatsDB: () => ({ isReady: () => false }),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(async (error: unknown) => {
		unexpected.push(error instanceof Error ? error.message : String(error));
	}),
	captureMessage: vi.fn(),
}));
// The shipped prompt text, read from the file the app bundles.
vi.mock('../../../main/prompt-manager', () => ({
	getPrompt: (id: string) =>
		readFileSync(path.join(process.cwd(), 'src', 'prompts', `${id}.md`), 'utf8'),
}));
vi.mock('../../../main/local-models/system-one/decisions', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/local-models/system-one/decisions')>()),
	keepSystemOneDecision: (decision: Record<string, unknown>) => {
		ledger.push(decision);
	},
}));
// The shipped examples alone vote: a correction left in the scratch dir would
// make a run measure somebody's corrections instead of the router.
vi.mock('../../../main/local-models/model-routing-corrections', () => ({
	getModelRoutingCorrectionStore: () => ({ list: async () => [] }),
}));
vi.mock('../../../main/local-models/classifier', () => ({ classifyText: vi.fn() }));
vi.mock('../../../main/local-models/speech-to-text', () => ({ transcribeSpeech: vi.fn() }));

import { embedTexts } from '../../../main/local-models/embeddings';
import {
	EmbeddingRouter,
	getEmbeddingRouter,
	type ModelRouterEmbedder,
} from '../../../main/local-models/model-router';
import { __setOnnxEncoderPool, OnnxEncoderPool } from '../../../main/local-models/onnx-encoder';
import { routeTurn } from '../../../main/local-models/route-turn';
import {
	LLAMA_GET_OPTIONS,
	llamaBackendLabel,
	type LlamaBackendInfo,
} from '../../../main/local-models/runtime/llama-options';
import { loadLocalRuntime } from '../../../main/local-models/runtime/load-runtime';
import { __setNativeImporter } from '../../../main/local-models/runtime/native-loader';
import {
	getModelServerReport,
	installModelServerEngine,
} from '../../../main/local-models/server/service';
import {
	configureModelServer,
	ensureModelServerFor,
	getModelServerStatus,
	resetModelServerForTests,
	stopModelServer,
} from '../../../main/local-models/server/supervisor';
import {
	downloadLocalModel,
	ensureLocalRuntimeForModel,
	verifyLocalModel,
} from '../../../main/local-models/service';
import type { LocalModelSource } from '../../../main/local-models/sources';
import {
	configureSystemOne,
	resetSystemOneServiceForTests,
	resolveSystemOneEngine,
	updateSystemOneSettingsRequest,
} from '../../../main/local-models/system-one/service';
import { __setLocalTextEngine, LocalTextEngine } from '../../../main/local-models/text-gen';
import { obscuringSeal } from '../../../main/utils/safe-storage-seal';
import {
	BGE_SMALL_EN_ID,
	EMBEDDINGGEMMA_300M_ID,
	QWEN3_1_7B_ID,
	QWEN3_5_4B_ID,
	getLocalModel,
	isCuratedLocalModelId,
} from '../../../shared/local-models/model-catalog';
import {
	MODEL_ROUTING_NEIGHBOURS,
	type ModelRoutingExample,
} from '../../../shared/local-models/model-routing';
import { MODEL_ROUTING_EXAMPLES } from '../../../shared/local-models/model-routing-examples';
import {
	MODEL_ROUTING_TASK_ID,
	MODEL_ROUTING_TIMEOUT_MS,
	MODEL_ROUTING_UNATTENDED_TIMEOUT_MS,
	isModelRouteSkipped,
} from '../../../shared/local-models/model-routing-task';
import {
	TYPESAFE_API_KEY_ENV_VAR,
	TYPESAFE_API_KEY_FILE,
	describeSystemOneKey,
} from '../../../shared/local-models/system-one-settings';
import {
	isLocalModelOfferedForTask,
	type LocalModelAssignment,
} from '../../../shared/local-models/tasks';
import { percentileOfSorted } from '../../../shared/percentiles';
import { TIER_LEVELS, type ModelTier } from '../../../shared/tierLevels';
import reportFixture from '../../fixtures/model-routing-prompts.json';
import { scratchKeySeal } from '../../helpers/scratchKeySeal';

/** The report half: agreement is measured here and nothing is chosen from it. */
const REPORT_PROMPTS = reportFixture.prompts as ModelRoutingExample[];

/** One router, every condition: a download on the first run, then the routings. */
const ROUTER_TEST_TIMEOUT_MS = 60 * 60_000;
/** The first routing pays for a model load, the example vectors, or a connection. */
const COLD_TIMEOUT_MS = 10 * 60_000;
/**
 * Wide on purpose. The run MEASURES latency against the send's 400 ms; held to
 * 400 ms it would record a slow router as forty skips and no agreement at all.
 */
const MEASURE_TIMEOUT_MS = 2 * 60_000;

/**
 * The warm-up prompt, from the TUNE half, so the report half is never asked
 * twice (Jev answers the same request the same way, and a repeat would measure
 * nothing).
 */
const WARM_UP_PROMPT = MODEL_ROUTING_EXAMPLES[0].text;

/** Who the decision records name. */
const EVAL_AGENT = { id: 'model-routing-eval' };

/** How many neighbours the leave-one-out tries. The app ships one of them. */
const NEIGHBOUR_CANDIDATES = [1, 3, 5, 7, 9, 11];

/**
 * Confidences a "too unsure to act on" rule could be set at. The embedding
 * router's confidence is a vote margin and Jev's is the peak of a distribution,
 * so the two are read on the same floors and never compared with each other.
 */
const CONFIDENCE_FLOORS = [0.1, 0.2, 0.3, 0.5, 0.7, 0.9];

const DEFAULT_CANDIDATES = [BGE_SMALL_EN_ID, EMBEDDINGGEMMA_300M_ID, QWEN3_1_7B_ID, QWEN3_5_4B_ID];
const CANDIDATES = MODELS_ENV
	? MODELS_ENV.split(',')
			.map((id) => id.trim())
			.filter(Boolean)
	: DEFAULT_CANDIDATES;
const EMBEDDING_CANDIDATES = CANDIDATES.filter((id) => getLocalModel(id)?.kind === 'embedding');
const JUDGE_CANDIDATES = CANDIDATES.filter((id) => getLocalModel(id)?.kind === 'text-gen');

const CPU_THREADS = CPU_THREADS_ENV.split(',')
	.map((value) => Number.parseInt(value.trim(), 10))
	.filter((count) => Number.isInteger(count) && count > 0);

/** One way the model server is started, as extra `llama-server` arguments. */
interface ServerCondition {
	label: string;
	args: string[];
}

const SERVER_CONDITIONS: ServerCondition[] = [
	{ label: 'model server, default device', args: [] },
	{ label: 'model server, CPU only (--device none)', args: ['--device', 'none'] },
	...CPU_THREADS.map((count) => ({
		label: `model server, CPU only, ${count} threads`,
		args: ['--device', 'none', '--threads', String(count)],
	})),
];

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface PromptOutcome {
	text: string;
	tier: ModelTier;
	effort: ModelTier;
	gotTier?: ModelTier;
	gotEffort?: ModelTier;
	tierConfidence?: number;
	/** Why there was no decision. */
	skipped?: string;
	latencyMs: number;
}

interface ConfidenceSplit {
	floor: number;
	/** Decisions whose tier margin is at or above the floor. */
	kept: number;
	agreeKept: number;
	/** Decisions below the floor: the ones such a rule would not act on. */
	dropped: number;
	agreeDropped: number;
}

interface RouterMeasure {
	router: string;
	hardware: string;
	calibrated: boolean;
	prompts: number;
	decided: number;
	tierAgree: number;
	tierWithinOne: number;
	/** Too little model: the miss that costs a wrong answer. */
	underRouted: number;
	/** Too much model: the miss that costs money. */
	overRouted: number;
	effortAgree: number;
	bothAgree: number;
	/** Label, then what the router said. */
	confusion: Record<string, Record<string, number>>;
	coldMs: number;
	p50Ms: number;
	p95Ms: number;
	maxMs: number;
	/** Answers inside the 400 ms a typed send waits. */
	insideSendTimeout: number;
	/** Answers inside the 5 s an unattended turn waits. */
	insideUnattendedTimeout: number;
	costPer1000Usd: number;
	meanInputTokens: number | null;
	/**
	 * Whether the router's own confidence separates its right tiers from its
	 * wrong ones. Null for a router that states none (a local judge).
	 */
	confidence: ConfidenceSplit[] | null;
	extra?: Record<string, unknown>;
	outcomes: PromptOutcome[];
}

function levelIndex(level: ModelTier): number {
	return TIER_LEVELS.indexOf(level);
}

function summarize(
	router: string,
	hardware: string,
	calibrated: boolean,
	coldMs: number,
	outcomes: PromptOutcome[],
	records: Array<Record<string, unknown>>
): RouterMeasure {
	const decided = outcomes.filter((outcome) => outcome.gotTier && outcome.gotEffort);
	const confusion: Record<string, Record<string, number>> = {};
	for (const label of TIER_LEVELS) {
		confusion[label] = { low: 0, medium: 0, high: 0, none: 0 };
	}
	for (const outcome of outcomes) confusion[outcome.tier][outcome.gotTier ?? 'none']++;

	const gap = (outcome: PromptOutcome): number =>
		levelIndex(outcome.gotTier as ModelTier) - levelIndex(outcome.tier);
	const latencies = outcomes.map((outcome) => outcome.latencyMs).sort((a, b) => a - b);
	const costs = records.map((record) => (typeof record.costUsd === 'number' ? record.costUsd : 0));
	const inputTokens = records
		.map((record) => (record.usage as { inputTokens?: number } | undefined)?.inputTokens)
		.filter((tokens): tokens is number => typeof tokens === 'number' && tokens > 0);
	const stated = decided.flatMap((outcome) =>
		outcome.tierConfidence === undefined
			? []
			: [{ agrees: outcome.gotTier === outcome.tier, confidence: outcome.tierConfidence }]
	);

	return {
		router,
		hardware,
		calibrated,
		prompts: outcomes.length,
		decided: decided.length,
		tierAgree: decided.filter((outcome) => gap(outcome) === 0).length,
		tierWithinOne: decided.filter((outcome) => Math.abs(gap(outcome)) <= 1).length,
		underRouted: decided.filter((outcome) => gap(outcome) < 0).length,
		overRouted: decided.filter((outcome) => gap(outcome) > 0).length,
		effortAgree: decided.filter((outcome) => outcome.gotEffort === outcome.effort).length,
		bothAgree: decided.filter(
			(outcome) => outcome.gotTier === outcome.tier && outcome.gotEffort === outcome.effort
		).length,
		confusion,
		coldMs: Math.round(coldMs),
		p50Ms: Math.round(percentileOfSorted(latencies, 50)),
		p95Ms: Math.round(percentileOfSorted(latencies, 95)),
		maxMs: Math.round(latencies[latencies.length - 1] ?? 0),
		insideSendTimeout: latencies.filter((ms) => ms <= MODEL_ROUTING_TIMEOUT_MS).length,
		insideUnattendedTimeout: latencies.filter((ms) => ms <= MODEL_ROUTING_UNATTENDED_TIMEOUT_MS)
			.length,
		costPer1000Usd:
			costs.length === 0
				? 0
				: Number(
						((costs.reduce((sum, cost) => sum + cost, 0) / costs.length) * 1000).toPrecision(3)
					),
		meanInputTokens:
			inputTokens.length === 0
				? null
				: Math.round(inputTokens.reduce((sum, tokens) => sum + tokens, 0) / inputTokens.length),
		confidence:
			stated.length > 0 && stated.length === decided.length ? splitByConfidence(stated) : null,
		outcomes,
	};
}

/** Does a stated confidence separate the right tiers from the wrong ones? */
function splitByConfidence(
	votes: ReadonlyArray<{ agrees: boolean; confidence: number }>
): ConfidenceSplit[] {
	return CONFIDENCE_FLOORS.map((floor) => {
		const kept = votes.filter((vote) => vote.confidence >= floor);
		const dropped = votes.filter((vote) => vote.confidence < floor);
		return {
			floor,
			kept: kept.length,
			agreeKept: kept.filter((vote) => vote.agrees).length,
			dropped: dropped.length,
			agreeDropped: dropped.filter((vote) => vote.agrees).length,
		};
	});
}

function share(count: number, total: number): string {
	return total === 0 ? '0/0' : `${count}/${total} (${Math.round((count / total) * 100)}%)`;
}

function formatMs(ms: number): string {
	return ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : `${ms.toLocaleString('en-US')} ms`;
}

/** The table the architecture doc carries, so a run can be pasted in whole. */
function formatReportTable(measures: readonly RouterMeasure[]): string {
	const header = [
		'Router',
		'Hardware',
		'Tier agreement',
		'Within one tier',
		'Too little / too much model',
		'Effort agreement',
		'Cold',
		'p50',
		'p95',
		`Inside ${MODEL_ROUTING_TIMEOUT_MS} ms`,
		'Cost per 1,000',
	];
	const rows = measures.map((measure) => [
		measure.router,
		measure.hardware,
		share(measure.tierAgree, measure.prompts),
		share(measure.tierWithinOne, measure.prompts),
		`${measure.underRouted} / ${measure.overRouted}`,
		share(measure.effortAgree, measure.prompts),
		formatMs(measure.coldMs),
		formatMs(measure.p50Ms),
		formatMs(measure.p95Ms),
		share(measure.insideSendTimeout, measure.prompts),
		measure.costPer1000Usd === 0 ? '$0' : `$${measure.costPer1000Usd}`,
	]);
	return [header, header.map(() => '---'), ...rows]
		.map((row) => `| ${row.join(' | ')} |`)
		.join('\n');
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Measurements written at the end, for the architecture doc. Never the key. */
const results: {
	environment: Record<string, unknown>;
	tune: Record<string, unknown>;
	routers: RouterMeasure[];
	skipped: string[];
} = { environment: {}, tune: {}, routers: [], skipped: [] };

function assign(assignment: LocalModelAssignment): void {
	settings.set('localModelAssignments', { [MODEL_ROUTING_TASK_ID]: assignment });
}

/** The model on disk and verified, and the runtime that reads it installed. */
async function ensureInstalled(modelId: string): Promise<void> {
	if (!(await verifyLocalModel(modelId)).ok) {
		const download = await downloadLocalModel(modelId);
		expect(download.error ?? null).toBeNull();
	}
	expect((await verifyLocalModel(modelId)).ok).toBe(true);
	const runtime = await ensureLocalRuntimeForModel(modelId);
	expect(runtime.error ?? null).toBeNull();
}

/**
 * Route the warm-up prompt, then every report prompt, through `routeTurn`, on
 * whatever router is assigned now. Checks that each routing was filed once.
 */
async function measure(hardware: string): Promise<RouterMeasure> {
	const filedBefore = ledger.length;

	const cold = await routeTurn(
		{ prompt: WARM_UP_PROMPT, agent: EVAL_AGENT },
		{ timeoutMs: COLD_TIMEOUT_MS }
	);
	if (isModelRouteSkipped(cold)) {
		throw new Error(`The warm-up routing gave no decision (${cold.skipped}): ${cold.detail}`);
	}

	const outcomes: PromptOutcome[] = [];
	for (const prompt of REPORT_PROMPTS) {
		const result = await routeTurn(
			{ prompt: prompt.text, agent: EVAL_AGENT },
			{ timeoutMs: MEASURE_TIMEOUT_MS }
		);
		expect(result.engine?.id).toBe(cold.engine.id);
		outcomes.push(
			isModelRouteSkipped(result)
				? { ...prompt, skipped: `${result.skipped}: ${result.detail}`, latencyMs: result.latencyMs }
				: {
						...prompt,
						gotTier: result.tier,
						gotEffort: result.effort,
						...(result.tierConfidence !== undefined
							? { tierConfidence: result.tierConfidence }
							: {}),
						latencyMs: result.latencyMs,
					}
		);
	}

	// The two local routers file their record after the answer is returned.
	const expected = REPORT_PROMPTS.length + 1;
	await vi.waitFor(() => expect(ledger.length - filedBefore).toBe(expected), { timeout: 10_000 });
	const records = ledger.slice(filedBefore + 1);
	for (const record of records) expect(record.taskId).toBe(MODEL_ROUTING_TASK_ID);

	return summarize(
		cold.engine.label,
		hardware,
		cold.engine.calibrated,
		cold.latencyMs,
		outcomes,
		records
	);
}

function record(measured: RouterMeasure): RouterMeasure {
	results.routers.push(measured);
	// A prompt with no decision is a finding, kept in `outcomes` with its reason.
	// A router with no decision at all measured nothing.
	expect(measured.decided).toBeGreaterThan(0);
	return measured;
}

/**
 * The catalog's promise, held to a measurement. A router that answers the same
 * level for every prompt scores the largest tier's share of the set and routes
 * nothing, so a model the task offers has to beat that. A model the task
 * records as unfit is measured and never fails the run.
 */
function expectOfferedModelRoutes(modelId: string, measured: RouterMeasure): void {
	const offered =
		isCuratedLocalModelId(modelId) && isLocalModelOfferedForTask(MODEL_ROUTING_TASK_ID, modelId);
	measured.extra = { ...measured.extra, offered };
	if (!offered) return;
	const largestTier = Math.max(
		...TIER_LEVELS.map((level) => REPORT_PROMPTS.filter((prompt) => prompt.tier === level).length)
	);
	expect(measured.tierAgree).toBeGreaterThan(largestTier);
}

/**
 * Leave-one-out over the TUNE half, on the real router class: each shipped
 * example is routed against the other 56, for every neighbour count. Vectors
 * are embedded once and looked up, so the sweep costs one batch of embeddings.
 */
async function tuneOnExamples(source: LocalModelSource): Promise<Record<string, unknown>> {
	const texts = MODEL_ROUTING_EXAMPLES.map((example) => example.text);
	const vectors = await embedTexts(source, texts, { mode: 'query' });
	const byText = new Map(texts.map((text, position) => [text, vectors[position]]));
	const lookup: ModelRouterEmbedder = async (_source, wanted) =>
		wanted.map((text) => {
			const vector = byText.get(text);
			if (!vector) throw new Error(`The tune sweep has no vector for "${text}".`);
			return vector;
		});

	const neighbours: Record<string, { tierAgree: number; effortAgree: number }> = {};
	let shippedVotes: Array<{ agrees: boolean; confidence: number }> = [];
	for (const count of NEIGHBOUR_CANDIDATES) {
		let tierAgree = 0;
		let effortAgree = 0;
		const votes: Array<{ agrees: boolean; confidence: number }> = [];
		for (const held of MODEL_ROUTING_EXAMPLES) {
			const router = new EmbeddingRouter({
				embed: lookup,
				examples: MODEL_ROUTING_EXAMPLES.filter((example) => example !== held),
				corrections: async () => [],
				neighbours: count,
			});
			const decision = await router.route(source, held.text);
			if (decision.tier === held.tier) tierAgree++;
			if (decision.effort === held.effort) effortAgree++;
			votes.push({ agrees: decision.tier === held.tier, confidence: decision.tierConfidence });
		}
		neighbours[String(count)] = { tierAgree, effortAgree };
		if (count === MODEL_ROUTING_NEIGHBOURS) shippedVotes = votes;
	}

	const best = NEIGHBOUR_CANDIDATES.reduce((winner, count) => {
		const a = neighbours[String(count)];
		const b = neighbours[String(winner)];
		return a.tierAgree > b.tierAgree ||
			(a.tierAgree === b.tierAgree && a.effortAgree > b.effortAgree)
			? count
			: winner;
	});
	return {
		examples: texts.length,
		shippedNeighbours: MODEL_ROUTING_NEIGHBOURS,
		bestNeighbours: best,
		neighbours,
		confidenceAtShippedNeighbours: splitByConfidence(shippedVotes),
	};
}

/** The `llama-server` process serving `modelId`, as `ps` shows it, or null. */
function servingProcessLine(modelId: string): string | null {
	if (process.platform === 'win32') return null;
	const lines = execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' }).split('\n');
	return (
		lines.find((line) => line.includes('llama-server') && line.includes(`--alias ${modelId}`)) ??
		null
	);
}

describe.skipIf(!LOCAL && !JEV)(
	'model routing eval (MAESTRO_LOCAL_MODEL_E2E=1, MAESTRO_JEV_E2E=1)',
	() => {
		let pool: OnnxEncoderPool;
		let textEngine: LocalTextEngine;
		let systemOneDir = '';
		let jevKey: string | null = null;

		function configureServer(condition: ServerCondition | null): void {
			configureModelServer({
				dataDir: () => DATA_DIR,
				// The scratch dir's key is shared with the other on-device suites.
				osSeal: () => scratchKeySeal(),
				safeSend: () => {},
				...(condition && condition.args.length > 0
					? {
							// The supervisor's own arguments, then the condition's. Router
							// mode hands them to the process it starts for each model.
							spawn: (command: string, args: string[], options: SpawnOptions): ChildProcess =>
								spawnProcess(command, [...args, ...condition.args], options),
						}
					: {}),
			});
		}

		beforeAll(async () => {
			// `paths.ts` prefers MAESTRO_USER_DATA over Electron. An agent shell
			// exports it pointing at the LIVE data dir, so pin it to the scratch dir.
			process.env.MAESTRO_USER_DATA = DATA_DIR;
			mkdirSync(DATA_DIR, { recursive: true });
			// See llama-e2e.test.ts: an importer vitest's module VM accepts.
			__setNativeImporter(
				(specifier) =>
					import(
						/* @vite-ignore */ path.isAbsolute(specifier)
							? pathToFileURL(specifier).href
							: specifier
					)
			);
			pool = new OnnxEncoderPool({ idleUnloadMs: 0 });
			__setOnnxEncoderPool(pool);
			textEngine = new LocalTextEngine({ idleUnloadMs: 0 });
			__setLocalTextEngine(textEngine);
			configureServer(null);

			// System One's own settings live in an empty folder: the local routers
			// read "Keep inputs in the ledger" from it, and the Jev run its engine.
			systemOneDir = mkdtempSync(path.join(os.tmpdir(), 'model-routing-eval-'));
			configureSystemOne({
				dataDir: () => systemOneDir,
				osSeal: obscuringSeal,
				shellEnvVars: () => ({}),
			});

			results.environment = {
				platform: `${process.platform}-${process.arch}`,
				cpu: os.cpus()[0]?.model ?? 'unknown',
				cores: os.cpus().length,
				totalRamGb: Math.round(os.totalmem() / 1024 ** 3),
				node: process.versions.electron
					? `Electron ${process.versions.electron} (Node ${process.versions.node})`
					: `Node ${process.versions.node}`,
				reportPrompts: REPORT_PROMPTS.length,
				tunePrompts: MODEL_ROUTING_EXAMPLES.length,
				sendTimeoutMs: MODEL_ROUTING_TIMEOUT_MS,
				unattendedTimeoutMs: MODEL_ROUTING_UNATTENDED_TIMEOUT_MS,
				measureTimeoutMs: MEASURE_TIMEOUT_MS,
			};
		});

		afterAll(async () => {
			await resetModelServerForTests();
			await textEngine.unload();
			await pool.unload();
			__setLocalTextEngine(null);
			__setOnnxEncoderPool(null);
			__setNativeImporter(null);
			resetSystemOneServiceForTests();
			rmSync(systemOneDir, { recursive: true, force: true });

			// Recorded rather than asserted, and written to a file as well as the
			// console, because vitest swallows the console output of a passing suite.
			const report = JSON.stringify(results, null, 2);
			// A boolean, not a matcher: a failed matcher would print the key it found.
			if (jevKey && report.includes(jevKey)) {
				throw new Error('The routing eval report holds the API key. It was not written.');
			}
			writeFileSync(RESULTS_FILE, `${report}\n`);
			const summary = {
				environment: results.environment,
				tune: results.tune,
				skipped: results.skipped,
				routers: results.routers.map(({ outcomes: _outcomes, ...measured }) => measured),
			};
			console.log(
				`[model-routing-eval] results (per-prompt outcomes in ${RESULTS_FILE})\n${JSON.stringify(summary, null, 2)}\n\n${formatReportTable(results.routers)}`
			);
		});

		for (const modelId of EMBEDDING_CANDIDATES) {
			it.skipIf(!LOCAL)(
				`measures the embedding router on ${modelId}`,
				async () => {
					await ensureInstalled(modelId);
					const source: LocalModelSource = { type: 'local', modelId };

					const tune = await tuneOnExamples(source);
					results.tune[modelId] = tune;

					// Cold for real: the model out of memory and no example vectors, the
					// state of the first routed send after a start.
					await pool.unload();
					getEmbeddingRouter().reset();
					assign(source);
					// ONNX Runtime's default provider. No session here asks for another.
					const measured = record(await measure('ONNX Runtime, CPU'));
					// Every decision carries the margin a low-confidence rule would read.
					expect(measured.confidence).not.toBeNull();
					expectOfferedModelRoutes(modelId, measured);
				},
				ROUTER_TEST_TIMEOUT_MS
			);
		}

		for (const modelId of JUDGE_CANDIDATES) {
			it.skipIf(!LOCAL)(
				`measures a local judge on ${modelId}, in-process and on the model server`,
				async () => {
					await ensureInstalled(modelId);
					assign({ type: 'local', modelId });

					// In-process: the path a local assignment takes while the model
					// server is not holding the model.
					await stopModelServer();
					await textEngine.unload();
					const llama = await loadLocalRuntime<{
						getLlama(options: Record<string, unknown>): Promise<LlamaBackendInfo>;
					}>('llama', 'model-routing-eval');
					const backend = llamaBackendLabel(await llama.getLlama({ ...LLAMA_GET_OPTIONS }));
					const inProcess = record(await measure(`in-process llama.cpp (${backend})`));
					expect(textEngine.loadedModelId).toBe(modelId);
					expectOfferedModelRoutes(modelId, inProcess);

					const report = await getModelServerReport();
					if (!report.engine.installed || report.engine.stale) {
						await installModelServerEngine('default');
					}
					const { engine } = await getModelServerReport();
					results.environment.modelServer = {
						release: engine.release,
						build: engine.label,
						accelerator: engine.accelerator?.label ?? null,
					};

					for (const condition of SERVER_CONDITIONS) {
						await stopModelServer();
						configureServer(condition);
						const started = Date.now();
						const ensured = await ensureModelServerFor(modelId);
						if (!ensured.ok) {
							throw new Error(`${condition.label}: ${ensured.code}: ${ensured.error}`);
						}
						const loadMs = Date.now() - started;
						expect((await getModelServerStatus()).loadedModels).toContain(modelId);

						// What the model's own process was started with: the proof that a
						// CPU-only run was one, read from the process and not assumed.
						const line = servingProcessLine(modelId);
						if (line !== null) {
							for (let position = 0; position < condition.args.length; position += 2) {
								expect(line).toContain(
									`${condition.args[position]} ${condition.args[position + 1]}`
								);
							}
							if (condition.args.length === 0) expect(line).not.toContain('--device');
						}

						const measured = record(await measure(condition.label));
						measured.extra = { serverStartAndLoadMs: loadMs, processChecked: line !== null };
						// The server's copy answered: no second copy was opened in-process.
						expect(textEngine.loadedModelId).toBeNull();
						expectOfferedModelRoutes(modelId, measured);
					}
					await stopModelServer();
				},
				ROUTER_TEST_TIMEOUT_MS
			);
		}

		it.skipIf(!JEV)(
			'measures System One on the hosted Jev',
			async (ctx: TestContext) => {
				await updateSystemOneSettingsRequest({ engine: 'jev-cloud' });
				const resolved = await resolveSystemOneEngine();
				if (resolved.id !== 'jev-cloud') {
					throw new Error(`Expected the hosted Jev to be the engine in force, got ${resolved.id}.`);
				}
				if (resolved.key.source === 'none') {
					const reason = `Jev: no API key found. Set ${TYPESAFE_API_KEY_ENV_VAR} or write the key to ~/${TYPESAFE_API_KEY_FILE.join('/')}. A key stored in Settings is sealed by the app and cannot be opened by a test.`;
					results.skipped.push(reason);
					console.warn(`[model-routing-eval] skipped: ${reason}`);
					ctx.skip(reason);
				}
				if (resolved.refusal) throw new Error(resolved.refusal.message);
				jevKey = resolved.engine.apiKey ?? null;

				assign({ type: 'system-one' });
				const measured = record(await measure('TypeSafe cloud, this network'));
				measured.extra = {
					baseUrl: resolved.engine.baseUrl,
					keySource: describeSystemOneKey(resolved.key),
				};
				expect(measured.calibrated).toBe(true);
			},
			ROUTER_TEST_TIMEOUT_MS
		);

		it('met no failure a router could not classify', () => {
			// `routeTurn` answers an unclassified failure as a skip and reports it;
			// a report here is a bug in a router, whatever the agreement says.
			expect(unexpected).toEqual([]);
		});
	}
);
