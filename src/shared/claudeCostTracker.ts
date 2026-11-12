/**
 * Claude Code's cost tracker, and this turn's share of it.
 *
 * A `claude -p` result reports two kinds of number, and they mean different
 * things (measured against claude 2.1.296 over three turns of one session):
 *
 *  - `usage` is THIS turn's: the same per-turn figures on every turn.
 *  - `modelUsage` and `total_cost_usd` are the SESSION's: claude restores its
 *    tracker on `--resume` and reports the running total. Three turns costing
 *    0.117, 0.098 and 0.020 reported 0.117, 0.215 and 0.235.
 *
 * Maestro records one row per turn, so it added those running totals turn
 * after turn: a session's recorded cost grew with the SQUARE of its turn count
 * (one Maestro tab recorded $48.86 for three turns that cost $27.55). The
 * TUI that maestro-p drives keeps the same tracker, so both token sources
 * over-counted the same way.
 *
 * The tracker is written to the session transcript as a `cost-state` row each
 * time claude exits, and the last such row is exactly what the next resume
 * restores. So the total as of the start of a turn is the last `cost-state`
 * row in the transcript before the turn spawned, and this turn's spend is the
 * reported total minus that baseline.
 *
 * No Electron imports: the desktop parser, the CLI spawner, and maestro-p all
 * use this module.
 */

import * as fs from 'fs';
import * as path from 'path';

import { getModelContextWindowOverride } from './agentConstants';
import { calculateModelCost } from './modelPricing';
import { encodeClaudeProjectPath } from './pathUtils';

/**
 * One model's entry in a `modelUsage` map, in claude's own field names. The
 * counters are additive; anything else claude sends (`contextWindow`,
 * `maxOutputTokens`, `canonicalModel`) describes the model and is carried as is.
 */
export interface ClaudeModelCost {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	webSearchRequests: number;
	costUSD: number;
	thinkingTokens?: number;
	contextWindow?: number;
	[field: string]: unknown;
}

/** Claude's tracker: the session's total cost and its per-model breakdown. */
export interface ClaudeCostState {
	totalCostUSD: number;
	modelUsage: Record<string, ClaudeModelCost>;
}

/** The additive counters of a {@link ClaudeModelCost}; everything else is descriptive. */
const ADDITIVE_FIELDS = [
	'inputTokens',
	'outputTokens',
	'cacheReadInputTokens',
	'cacheCreationInputTokens',
	'webSearchRequests',
	'costUSD',
	'thinkingTokens',
] as const;

/** Reported totals are float sums; a difference smaller than this is rounding. */
const COST_EPSILON = 1e-9;

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Add the context window a model id implies. `claude -p` reports a window per
 * model, but the tracker the TUI writes does not, and the only window the id
 * itself proves is the `[1m]` extended one. Anything else is left unset rather
 * than guessed: a wrong window is worse than none, because the caller then
 * trusts it over its own configured value.
 */
export function withContextWindow(model: string, entry: ClaudeModelCost): ClaudeModelCost {
	const window = getModelContextWindowOverride(model);
	return window === null ? entry : { ...entry, contextWindow: window };
}

/** The tracker carried by a transcript row, or null when the row is not a `cost-state` row. */
export function parseCostStateRow(entry: unknown): ClaudeCostState | null {
	if (!entry || typeof entry !== 'object') return null;
	const row = entry as Record<string, unknown>;
	if (row.type !== 'cost-state') return null;
	const modelUsage: Record<string, ClaudeModelCost> = {};
	const raw = row.modelUsage;
	if (raw && typeof raw === 'object') {
		for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
			if (!value || typeof value !== 'object') continue;
			const stats = value as Record<string, unknown>;
			const entry: ClaudeModelCost = {
				inputTokens: num(stats.inputTokens),
				outputTokens: num(stats.outputTokens),
				cacheReadInputTokens: num(stats.cacheReadInputTokens),
				cacheCreationInputTokens: num(stats.cacheCreationInputTokens),
				webSearchRequests: num(stats.webSearchRequests),
				costUSD: num(stats.costUSD),
			};
			if (typeof stats.thinkingTokens === 'number') entry.thinkingTokens = stats.thinkingTokens;
			modelUsage[model] = withContextWindow(model, entry);
		}
	}
	return { totalCostUSD: num(row.totalCostUSD), modelUsage };
}

/** Where claude keeps the transcript of `sessionId` for a project rooted at `cwd`. */
export function claudeTranscriptPath(configDir: string, cwd: string, sessionId: string): string {
	return path.join(configDir, 'projects', encodeClaudeProjectPath(cwd), `${sessionId}.jsonl`);
}

/** The config dir a claude process with this environment reads and writes. */
export function claudeConfigDirFor(
	env: Record<string, string | undefined>,
	homeDir: string
): string {
	const configured = env.CLAUDE_CONFIG_DIR;
	return configured && configured.trim() ? configured : path.join(homeDir, '.claude');
}

// The last cost-state row sits within the final few rows of a transcript at the
// start of a turn: claude writes it on exit, followed only by small bookkeeping
// rows. A turn that was killed writes none, so the previous row can sit behind
// that turn's rows; reading backwards in chunks finds it without loading the
// whole file in the usual case.
const TAIL_CHUNK_BYTES = 256 * 1024;
// Past this, give up and report the baseline as unknown. Bounds the synchronous
// read on the thread that spawns the turn.
const MAX_SCAN_BYTES = 16 * 1024 * 1024;

/**
 * The tracker as of the last `cost-state` row in a transcript.
 *
 * Three answers, kept apart because they lead to different handling:
 *  - a {@link ClaudeCostState}: the session's total so far;
 *  - `null`: the transcript was read and holds no tracker, so nothing will be
 *    restored and the next report is this turn's alone;
 *  - `undefined`: the transcript could not be read (missing, on another host,
 *    or the row lies further back than {@link MAX_SCAN_BYTES}). Unknown.
 */
export function readLastClaudeCostState(
	transcriptPath: string
): ClaudeCostState | null | undefined {
	let fd: number;
	try {
		fd = fs.openSync(transcriptPath, 'r');
	} catch {
		return undefined;
	}
	try {
		const size = fs.fstatSync(fd).size;
		let end = size;
		let carry = '';
		while (end > 0) {
			if (size - end >= MAX_SCAN_BYTES) return undefined;
			const start = Math.max(0, end - TAIL_CHUNK_BYTES);
			const buffer = Buffer.alloc(end - start);
			fs.readSync(fd, buffer, 0, buffer.length, start);
			const text = buffer.toString('utf-8') + carry;
			const lines = text.split('\n');
			// The first piece may be the tail of a line that started in the
			// previous chunk; keep it for the next pass unless this is the start.
			carry = start > 0 ? (lines.shift() ?? '') : '';
			for (let i = lines.length - 1; i >= 0; i -= 1) {
				const line = lines[i];
				if (!line.includes('"cost-state"')) continue;
				try {
					const state = parseCostStateRow(JSON.parse(line));
					if (state) return state;
				} catch {
					// A torn row; keep looking further up.
				}
			}
			end = start;
		}
		if (carry.includes('"cost-state"')) {
			try {
				const state = parseCostStateRow(JSON.parse(carry));
				if (state) return state;
			} catch {
				// Not a whole row.
			}
		}
		return null;
	} catch {
		return undefined;
	} finally {
		fs.closeSync(fd);
	}
}

/** Everything a spawn knows that locates a resumed session's transcript. */
export interface ClaudeTurnBaselineInput {
	/** The provider session the turn resumes. */
	resumeSessionId: string;
	/** The folder claude runs in; it names the transcript's project directory. */
	cwd: string;
	/** The environment claude runs with; `CLAUDE_CONFIG_DIR` picks the account. */
	env: Record<string, string | undefined>;
	homeDir: string;
	/** True when claude runs on another host, whose transcript cannot be read here. */
	remote: boolean;
}

/**
 * The session's tracker as a turn spawns, from its transcript. A remote turn's
 * transcript is on the other host, so its baseline is unknown (`undefined`).
 */
export function readClaudeTurnBaseline(
	input: ClaudeTurnBaselineInput
): ClaudeCostState | null | undefined {
	if (input.remote) return undefined;
	return readLastClaudeCostState(
		claudeTranscriptPath(
			claudeConfigDirFor(input.env, input.homeDir),
			input.cwd,
			input.resumeSessionId
		)
	);
}

// ── this turn's share ────────────────────────────────────────────────────────

/** The cost fields of a `claude -p` result envelope. */
export interface ClaudeReportedCost {
	session_id?: unknown;
	modelUsage?: unknown;
	total_cost_usd?: unknown;
	usage?: unknown;
}

/** This turn's spend, in the shape the usage aggregator reads. */
export interface ClaudeTurnCost {
	modelUsage?: Record<string, ClaudeModelCost>;
	totalCostUsd: number;
	/** True when no baseline was known and the cost was priced from the rate table. */
	estimated?: boolean;
}

function asModelUsage(raw: unknown): Record<string, ClaudeModelCost> | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	return raw as Record<string, ClaudeModelCost>;
}

/**
 * Whether `reported` can be a running total that started from `baseline`.
 * A running total never shrinks, so any counter below the baseline means the
 * report is not one (a claude that does not restore its tracker, or a
 * maestro-p estimate), and subtracting would destroy it.
 */
function continuesBaseline(
	reported: Record<string, ClaudeModelCost> | undefined,
	reportedTotal: number,
	baseline: ClaudeCostState
): boolean {
	if (reportedTotal + COST_EPSILON < baseline.totalCostUSD) return false;
	for (const [model, before] of Object.entries(baseline.modelUsage)) {
		const now = reported?.[model];
		if (!now) return false;
		for (const field of ADDITIVE_FIELDS) {
			if (num(now[field]) + COST_EPSILON < num(before[field])) return false;
		}
	}
	return true;
}

/** `reported` minus `baseline`, per model. Models this turn did not touch are dropped. */
function subtractModelUsage(
	reported: Record<string, ClaudeModelCost>,
	baseline: ClaudeCostState
): Record<string, ClaudeModelCost> {
	const turn: Record<string, ClaudeModelCost> = {};
	for (const [model, now] of Object.entries(reported)) {
		const before = baseline.modelUsage[model];
		const entry: ClaudeModelCost = { ...now };
		let touched = false;
		for (const field of ADDITIVE_FIELDS) {
			if (!(field in now)) continue;
			const delta = Math.max(0, num(now[field]) - num(before?.[field]));
			entry[field] = delta;
			if (delta > COST_EPSILON) touched = true;
		}
		// A model used only in earlier turns stays in the session's map with the
		// same counts. Reporting it would hand its context window to this turn.
		if (touched) turn[model] = entry;
	}
	return turn;
}

/**
 * The main model of a turn when the caller did not see it: the one the
 * session spent most on, which is where the per-turn `usage` belongs.
 */
function dominantModel(reported: Record<string, ClaudeModelCost> | undefined): string | undefined {
	let best: string | undefined;
	let bestCost = -1;
	for (const [model, entry] of Object.entries(reported ?? {})) {
		if (num(entry.costUSD) > bestCost) {
			bestCost = num(entry.costUSD);
			best = model;
		}
	}
	return best;
}

/**
 * Price this turn from its per-turn `usage` when the session's earlier total
 * is unknown. Covers the main model only (subagent and side-call spend is in
 * the session totals, which cannot be split without the baseline), so it reads
 * low rather than repeating the whole session's cost on this turn.
 */
function estimateFromTurnUsage(
	result: ClaudeReportedCost,
	reported: Record<string, ClaudeModelCost> | undefined,
	turnModel: string | undefined
): ClaudeTurnCost {
	const usage = (result.usage ?? {}) as Record<string, unknown>;
	const model = turnModel ?? dominantModel(reported);
	const tokens = {
		inputTokens: num(usage.input_tokens),
		outputTokens: num(usage.output_tokens),
		cacheReadTokens: num(usage.cache_read_input_tokens),
		cacheCreationTokens: num(usage.cache_creation_input_tokens),
	};
	const costUSD = calculateModelCost(tokens, model);
	if (!model) return { totalCostUsd: costUSD, estimated: true };
	const entry: ClaudeModelCost = {
		inputTokens: tokens.inputTokens,
		outputTokens: tokens.outputTokens,
		cacheReadInputTokens: tokens.cacheReadTokens,
		cacheCreationInputTokens: tokens.cacheCreationTokens,
		webSearchRequests: 0,
		costUSD,
	};
	const window = num(reported?.[model]?.contextWindow);
	if (window > 0) entry.contextWindow = window;
	return {
		modelUsage: { [model]: withContextWindow(model, entry) },
		totalCostUsd: costUSD,
		estimated: true,
	};
}

/**
 * This turn's spend from a result envelope.
 *
 * @param baseline The session's tracker as of the start of the turn:
 *   a state to subtract, `null` when the session had none (a fresh session, or
 *   a transcript with no tracker), or `undefined` when it is unknown.
 * @param turnModel The model this turn's main thread ran on, when the caller
 *   saw it. Used only to price the estimate.
 */
export function claudeTurnCost(
	result: ClaudeReportedCost,
	baseline: ClaudeCostState | null | undefined,
	turnModel?: string
): ClaudeTurnCost {
	const reported = asModelUsage(result.modelUsage);
	const reportedTotal = num(result.total_cost_usd);
	if (baseline === null) return { modelUsage: reported, totalCostUsd: reportedTotal };
	if (baseline === undefined) return estimateFromTurnUsage(result, reported, turnModel);
	if (!continuesBaseline(reported, reportedTotal, baseline)) {
		return { modelUsage: reported, totalCostUsd: reportedTotal };
	}
	return {
		modelUsage: reported ? subtractModelUsage(reported, baseline) : undefined,
		totalCostUsd: Math.max(0, reportedTotal - baseline.totalCostUSD),
	};
}

/** The tracker a result envelope reports, for use as the next turn's baseline. */
export function costStateFromResult(result: ClaudeReportedCost): ClaudeCostState | null {
	const reported = asModelUsage(result.modelUsage);
	if (!reported && result.total_cost_usd === undefined) return null;
	return parseCostStateRow({
		type: 'cost-state',
		totalCostUSD: result.total_cost_usd,
		modelUsage: reported,
	});
}

/**
 * Add one turn's spend onto a session's tracker. maestro-p uses it to report a
 * running total, as `claude -p` does, when claude wrote no `cost-state` row
 * and only this turn's spend is known.
 */
export function addToCostState(
	baseline: ClaudeCostState | null,
	turn: Record<string, ClaudeModelCost>
): ClaudeCostState {
	const modelUsage: Record<string, ClaudeModelCost> = { ...(baseline?.modelUsage ?? {}) };
	for (const [model, entry] of Object.entries(turn)) {
		const before = modelUsage[model];
		const sum: ClaudeModelCost = { ...(before ?? {}), ...entry };
		for (const field of ADDITIVE_FIELDS) {
			if (!(field in entry) && !(before && field in before)) continue;
			sum[field] = num(before?.[field]) + num(entry[field]);
		}
		modelUsage[model] = sum;
	}
	const turnCost = Object.values(turn).reduce((total, entry) => total + num(entry.costUSD), 0);
	return { totalCostUSD: (baseline?.totalCostUSD ?? 0) + turnCost, modelUsage };
}

// ── what this app has already seen ───────────────────────────────────────────

// The last tracker each session reported in this run. A remote session's
// transcript sits on another host, so after its first turn this is the only
// baseline there is. Bounded: oldest sessions are dropped first.
const MAX_REMEMBERED_SESSIONS = 500;
const lastReportedBySession = new Map<string, ClaudeCostState>();

/** Remember the tracker a session's result reported. */
export function rememberClaudeSessionCost(sessionId: string, state: ClaudeCostState): void {
	lastReportedBySession.delete(sessionId);
	lastReportedBySession.set(sessionId, state);
	if (lastReportedBySession.size > MAX_REMEMBERED_SESSIONS) {
		const oldest = lastReportedBySession.keys().next().value;
		if (oldest !== undefined) lastReportedBySession.delete(oldest);
	}
}

/** The tracker a session last reported in this run, if any. */
export function rememberedClaudeSessionCost(sessionId: string): ClaudeCostState | undefined {
	return lastReportedBySession.get(sessionId);
}

/** For tests: forget every remembered session. */
export function clearRememberedClaudeSessionCosts(): void {
	lastReportedBySession.clear();
}
