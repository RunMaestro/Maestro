/**
 * @file claudeCostTracker.test.ts
 * @description Tests for src/shared/claudeCostTracker.ts - reading claude's
 * session cost tracker and reducing a result's running totals to one turn's.
 *
 * The numbers are captured from three `claude -p` turns of one session
 * (claude 2.1.296): `modelUsage` and `total_cost_usd` grew turn over turn
 * while `usage` stayed per-turn.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	addToCostState,
	claudeConfigDirFor,
	claudeTranscriptPath,
	claudeTurnCost,
	clearRememberedClaudeSessionCosts,
	costStateFromResult,
	parseCostStateRow,
	readClaudeTurnBaseline,
	readLastClaudeCostState,
	rememberClaudeSessionCost,
	rememberedClaudeSessionCost,
	withContextWindow,
	type ClaudeCostState,
} from '../../shared/claudeCostTracker';

const SONNET = 'claude-sonnet-5-5';

const turnTwoResult = {
	type: 'result',
	session_id: 'sid',
	total_cost_usd: 0.2151969,
	usage: {
		input_tokens: 2,
		output_tokens: 3,
		cache_read_input_tokens: 19481,
		cache_creation_input_tokens: 23940,
	},
	modelUsage: {
		[SONNET]: {
			inputTokens: 4,
			outputTokens: 6,
			cacheReadInputTokens: 31849,
			cacheCreationInputTokens: 52986,
			webSearchRequests: 0,
			costUSD: 0.2151969,
			contextWindow: 1_000_000,
			maxOutputTokens: 128000,
		},
	},
};

// The cost-state row claude wrote at the end of turn one.
const afterTurnOne: ClaudeCostState = {
	totalCostUSD: 0.1174548,
	modelUsage: {
		[SONNET]: {
			inputTokens: 2,
			outputTokens: 3,
			cacheReadInputTokens: 12368,
			cacheCreationInputTokens: 29046,
			webSearchRequests: 0,
			costUSD: 0.1174548,
		},
	},
};

describe('parseCostStateRow', () => {
	// Shape captured from a real transcript (claude 2.1.296).
	const costStateRow = {
		type: 'cost-state',
		sessionId: 'be866c57',
		totalCostUSD: 1.7517958999999996,
		startTime: 1791819695144,
		modelUsage: {
			'claude-haiku-5-5': {
				inputTokens: 15936,
				outputTokens: 1551,
				thinkingTokens: 801,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				webSearchRequests: 1,
				costUSD: 0.0123691,
			},
			'claude-opus-5-5[1m]': {
				inputTokens: 52,
				outputTokens: 13418,
				thinkingTokens: 2016,
				cacheReadInputTokens: 2871014,
				cacheCreationInputTokens: 112082,
				webSearchRequests: 0,
				costUSD: 1.7394268,
			},
		},
		hasUnknownModelCost: false,
	};

	it('reads the total and every model the session used', () => {
		const state = parseCostStateRow(costStateRow);

		expect(state?.totalCostUSD).toBe(1.7517958999999996);
		expect(state?.modelUsage['claude-haiku-5-5']).toEqual({
			inputTokens: 15936,
			outputTokens: 1551,
			thinkingTokens: 801,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			webSearchRequests: 1,
			costUSD: 0.0123691,
		});
	});

	// The `[1m]` id is the only window the tracker proves; `claude -p` reports one.
	it('adds the 1M window to a [1m] model and no window to the rest', () => {
		const state = parseCostStateRow(costStateRow);

		expect(state?.modelUsage['claude-opus-5-5[1m]'].contextWindow).toBe(1_000_000);
		expect(state?.modelUsage['claude-haiku-5-5'].contextWindow).toBeUndefined();
	});

	it('ignores every other row', () => {
		expect(parseCostStateRow({ type: 'assistant', message: {} })).toBeNull();
		expect(parseCostStateRow(null)).toBeNull();
		expect(parseCostStateRow('cost-state')).toBeNull();
	});

	it('reads missing or non-numeric fields as zero', () => {
		const state = parseCostStateRow({
			type: 'cost-state',
			modelUsage: { [SONNET]: { inputTokens: 'x' }, broken: null },
		});

		expect(state).toEqual({
			totalCostUSD: 0,
			modelUsage: {
				[SONNET]: {
					inputTokens: 0,
					outputTokens: 0,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					webSearchRequests: 0,
					costUSD: 0,
				},
			},
		});
	});
});

describe('withContextWindow', () => {
	it('leaves an entry without a window marker untouched', () => {
		const entry = afterTurnOne.modelUsage[SONNET];
		expect(withContextWindow(SONNET, entry)).toBe(entry);
	});
});

describe('claudeTurnCost', () => {
	it("reduces a resumed result's running totals to this turn's", () => {
		const turn = claudeTurnCost(turnTwoResult, afterTurnOne);

		expect(turn.totalCostUsd).toBeCloseTo(0.0977421, 9);
		expect(turn.modelUsage?.[SONNET]).toMatchObject({
			inputTokens: 2,
			outputTokens: 3,
			cacheReadInputTokens: 19481,
			cacheCreationInputTokens: 23940,
			webSearchRequests: 0,
			// Descriptive fields are carried as they were reported.
			contextWindow: 1_000_000,
			maxOutputTokens: 128000,
		});
		expect(turn.modelUsage?.[SONNET].costUSD).toBeCloseTo(0.0977421, 9);
		expect(turn.estimated).toBeUndefined();
	});

	// An unused model keeps its old counts in the session map; reporting it
	// would hand its context window to this turn.
	it('drops a model this turn did not use', () => {
		const baseline: ClaudeCostState = {
			totalCostUSD: afterTurnOne.totalCostUSD + 0.01,
			modelUsage: {
				...afterTurnOne.modelUsage,
				'claude-haiku-5-5': {
					inputTokens: 10,
					outputTokens: 10,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					webSearchRequests: 0,
					costUSD: 0.01,
				},
			},
		};
		const result = {
			...turnTwoResult,
			total_cost_usd: turnTwoResult.total_cost_usd + 0.01,
			modelUsage: {
				...turnTwoResult.modelUsage,
				'claude-haiku-5-5': baseline.modelUsage['claude-haiku-5-5'],
			},
		};

		expect(Object.keys(claudeTurnCost(result, baseline).modelUsage ?? {})).toEqual([SONNET]);
	});

	it('passes a fresh session (no tracker yet) through unchanged', () => {
		const turn = claudeTurnCost(turnTwoResult, null);

		expect(turn).toEqual({
			modelUsage: turnTwoResult.modelUsage,
			totalCostUsd: turnTwoResult.total_cost_usd,
		});
	});

	// A report below the baseline cannot be a running total that started from it
	// (a claude that does not restore its tracker, or a maestro-p estimate).
	it('leaves a report that does not continue the baseline alone', () => {
		const cheaper = {
			...turnTwoResult,
			total_cost_usd: 0.05,
			modelUsage: {
				[SONNET]: { ...turnTwoResult.modelUsage[SONNET], inputTokens: 1, costUSD: 0.05 },
			},
		};

		expect(claudeTurnCost(cheaper, afterTurnOne).totalCostUsd).toBe(0.05);
	});

	it('prices the per-turn usage when the baseline is unknown', () => {
		const turn = claudeTurnCost(turnTwoResult, undefined, SONNET);

		expect(turn.estimated).toBe(true);
		expect(turn.modelUsage?.[SONNET]).toMatchObject({
			inputTokens: 2,
			outputTokens: 3,
			cacheReadInputTokens: 19481,
			cacheCreationInputTokens: 23940,
			contextWindow: 1_000_000,
		});
		expect(turn.totalCostUsd).toBeGreaterThan(0);
		// Far below the session's running total it would otherwise repeat.
		expect(turn.totalCostUsd).toBeLessThan(turnTwoResult.total_cost_usd);
	});

	it('prices an unknown-baseline turn at the model the session spent most on when the turn model is not known', () => {
		const turn = claudeTurnCost(turnTwoResult, undefined);

		expect(Object.keys(turn.modelUsage ?? {})).toEqual([SONNET]);
	});
});

describe('costStateFromResult and addToCostState', () => {
	it('reads a result back as the tracker for the next turn', () => {
		expect(costStateFromResult(turnTwoResult)?.totalCostUSD).toBe(0.2151969);
		expect(costStateFromResult({ type: 'result' } as never)).toBeNull();
	});

	it('adds one turn onto a session tracker', () => {
		const turn = claudeTurnCost(turnTwoResult, afterTurnOne).modelUsage!;
		const sum = addToCostState(afterTurnOne, turn);

		expect(sum.totalCostUSD).toBeCloseTo(0.2151969, 9);
		expect(sum.modelUsage[SONNET].cacheReadInputTokens).toBe(31849);
	});

	it('starts from nothing without a baseline', () => {
		expect(addToCostState(null, afterTurnOne.modelUsage)).toEqual(afterTurnOne);
	});
});

describe('remembered session totals', () => {
	beforeEach(() => clearRememberedClaudeSessionCosts());

	it('returns what a session last reported', () => {
		rememberClaudeSessionCost('sid', afterTurnOne);
		expect(rememberedClaudeSessionCost('sid')).toBe(afterTurnOne);
		expect(rememberedClaudeSessionCost('other')).toBeUndefined();
	});
});

describe('transcripts', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cost-tracker-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const write = (rows: unknown[]) => {
		const file = path.join(dir, 'session.jsonl');
		fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
		return file;
	};
	const costRow = (total: number) => ({
		type: 'cost-state',
		totalCostUSD: total,
		modelUsage: { [SONNET]: { inputTokens: 1, costUSD: total } },
	});

	it('reads the last cost-state row', () => {
		const file = write([costRow(0.1), { type: 'user' }, costRow(0.2), { type: 'last-prompt' }]);

		expect(readLastClaudeCostState(file)?.totalCostUSD).toBe(0.2);
	});

	// A killed turn writes no row, so the last one can sit behind a lot of output.
	it('finds a row behind more than one read chunk', () => {
		const filler = { type: 'assistant', text: 'x'.repeat(100_000) };
		const file = write([costRow(0.3), filler, filler, filler, filler]);

		expect(readLastClaudeCostState(file)?.totalCostUSD).toBe(0.3);
	});

	it('tells a transcript with no tracker apart from one it cannot read', () => {
		expect(readLastClaudeCostState(write([{ type: 'user' }]))).toBeNull();
		expect(readLastClaudeCostState(path.join(dir, 'missing.jsonl'))).toBeUndefined();
	});

	it('locates a session transcript the way claude names it', () => {
		const configDir = path.join(dir, 'cfg');
		const transcript = claudeTranscriptPath(configDir, '/work/my.repo/', 'sid');
		fs.mkdirSync(path.dirname(transcript), { recursive: true });
		fs.writeFileSync(transcript, JSON.stringify(costRow(0.4)) + '\n');

		expect(path.basename(path.dirname(transcript))).toBe('-work-my-repo');
		expect(
			readClaudeTurnBaseline({
				resumeSessionId: 'sid',
				cwd: '/work/my.repo/',
				env: { CLAUDE_CONFIG_DIR: configDir },
				homeDir: '/nowhere',
				remote: false,
			})?.totalCostUSD
		).toBe(0.4);
	});

	it('reports a remote session baseline as unknown', () => {
		expect(
			readClaudeTurnBaseline({
				resumeSessionId: 'sid',
				cwd: '/w',
				env: {},
				homeDir: dir,
				remote: true,
			})
		).toBeUndefined();
	});

	it('falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset or blank', () => {
		expect(claudeConfigDirFor({}, '/home/u')).toBe(path.join('/home/u', '.claude'));
		expect(claudeConfigDirFor({ CLAUDE_CONFIG_DIR: '  ' }, '/home/u')).toBe(
			path.join('/home/u', '.claude')
		);
		expect(claudeConfigDirFor({ CLAUDE_CONFIG_DIR: '/c' }, '/home/u')).toBe('/c');
	});
});
