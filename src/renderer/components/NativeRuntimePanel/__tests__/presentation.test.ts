import { describe, expect, it } from 'vitest';
import {
	formatCostUsd,
	humanizeStatKey,
	isDeviceInventoryLabel,
	presentSessionActivity,
	presentStats,
	summarizeTodos,
	truncateMiddle,
	currentModelLabel,
} from '../presentation';

describe('presentSessionActivity', () => {
	it('keeps ordinary conversation entries in order with their ids', () => {
		const entries = presentSessionActivity([
			{ id: 'a', label: 'Fix the login bug' },
			{ id: 'b', label: 'Sure — starting with the reproduction.' },
		]);
		expect(entries).toEqual([
			{ id: 'a', label: 'Fix the login bug' },
			{ id: 'b', label: 'Sure — starting with the reproduction.' },
		]);
	});

	it('filters raw markup payloads like system notices and XML', () => {
		const entries = presentSessionActivity([
			{ id: 'a', label: '<system-notice>compaction complete</system-notice>' },
			{ id: 'b', label: '<workstation><os>win32</os></workstation>' },
			{ id: 'c', label: '<?xml version="1.0"?>' },
			{ id: 'd', label: '  <system-conventions>rules</system-conventions>' },
			{ id: 'e', label: 'Real message about <code> usage' },
		]);
		expect(entries.map((entry) => entry.id)).toEqual(['e']);
	});

	it('filters device-inventory dumps but keeps prose with a single key mention', () => {
		expect(isDeviceInventoryLabel('OS: win32 10.0\nKernel: Windows 11 Pro\nCPU: AMD Ryzen 9')).toBe(
			true
		);
		const entries = presentSessionActivity([
			{ id: 'a', label: 'OS: win32\nCPU: AMD Ryzen 9\nGPU: RTX 3090' },
			{ id: 'b', label: 'The OS: field should be validated' },
		]);
		expect(entries.map((entry) => entry.id)).toEqual(['b']);
	});

	it('de-duplicates repeated labels keeping the first occurrence', () => {
		const entries = presentSessionActivity([
			{ id: 'a', label: 'Same message' },
			{ id: 'b', label: 'same   message' },
			{ id: 'c', label: 'Different message' },
		]);
		expect(entries.map((entry) => entry.id)).toEqual(['a', 'c']);
	});

	it('drops empty and whitespace-only labels and handles null trees', () => {
		expect(presentSessionActivity(null)).toEqual([]);
		expect(presentSessionActivity([{ id: 'a', label: '   ' }])).toEqual([]);
	});
});

describe('presentStats', () => {
	it('maps known token and cost keys to labelled cards', () => {
		const { cards } = presentStats({
			inputTokens: 21,
			outputTokens: 1400,
			cacheReadInputTokens: 2_500_000,
			totalCostUsd: 0.0042,
		});
		expect(cards).toEqual([
			{ id: 'inputTokens', label: 'Input', value: '21' },
			{ id: 'outputTokens', label: 'Output', value: '1.4k' },
			{ id: 'cacheReadInputTokens', label: 'Cache read', value: '2.5M' },
			{ id: 'totalCostUsd', label: 'Cost', value: '$0.0042' },
		]);
	});

	it('derives a clamped context gauge from total tokens and window', () => {
		const { context } = presentStats({ totalTokens: 50_000, contextWindow: 200_000 });
		expect(context).toEqual({ usedLabel: '50.0k', windowLabel: '200.0k', percent: 25 });

		const overflow = presentStats({ totalTokens: 500_000, contextWindow: 200_000 });
		expect(overflow.context?.percent).toBe(100);

		expect(presentStats({ totalTokens: 10 }).context).toBeNull();
		expect(presentStats({ totalTokens: 10, contextWindow: 0 }).context).toBeNull();
	});

	it('humanizes leftover keys into rows instead of raw key: value dumps', () => {
		const { rows } = presentStats({
			inputTokens: 1,
			turnCount: 7,
			sessionFile: '/tmp/omp/session.jsonl',
		});
		expect(rows).toEqual([
			{ label: 'Turn count', value: '7' },
			{ label: 'Session file', value: '/tmp/omp/session.jsonl' },
		]);
	});

	it('returns an empty presentation for null stats', () => {
		expect(presentStats(null)).toEqual({ cards: [], context: null, rows: [] });
	});
});

describe('formatting helpers', () => {
	it('formats costs with sub-cent precision', () => {
		expect(formatCostUsd(0)).toBe('$0.00');
		expect(formatCostUsd(0.0042)).toBe('$0.0042');
		expect(formatCostUsd(1.5)).toBe('$1.50');
	});

	it('humanizes camelCase and snake_case stat keys', () => {
		expect(humanizeStatKey('cacheReadInputTokens')).toBe('Cache read input tokens');
		expect(humanizeStatKey('total_cost_usd')).toBe('Total cost usd');
	});

	it('middle-truncates long paths and leaves short values intact', () => {
		expect(truncateMiddle('short', 48)).toBe('short');
		const long = 'C:/Users/Administrator/Software/Maestro/.run/very-long-session-file-name.jsonl';
		const truncated = truncateMiddle(long, 32);
		expect(truncated.length).toBeLessThanOrEqual(33);
		expect(truncated).toContain('…');
		expect(truncated.startsWith('C:/Users/Admini')).toBe(true);
		expect(truncated.endsWith('.jsonl')).toBe(true);
	});
});

describe('summarizeTodos', () => {
	it('counts done versus total items across phases', () => {
		expect(
			summarizeTodos([
				{
					name: 'Build',
					items: [
						{ content: 'a', state: 'done' },
						{ content: 'b', state: 'in_progress' },
					],
				},
				{ name: 'Ship', items: [{ content: 'c', state: 'open' }] },
			])
		).toEqual({ done: 1, total: 3 });
		expect(summarizeTodos(null)).toEqual({ done: 0, total: 0 });
	});
});

describe('currentModelLabel', () => {
	const base = { tree: null, todos: null, subagents: null, stats: null };

	it('prefers the option label for the selected model', () => {
		expect(
			currentModelLabel({
				...base,
				controls: [
					{
						id: 'model',
						label: 'Model',
						kind: 'select',
						value: 'anthropic:claude',
						options: [{ id: 'anthropic:claude', label: 'Claude' }],
					},
				],
			})
		).toBe('Claude');
	});

	it('falls back to the raw value and returns null without a selection', () => {
		expect(
			currentModelLabel({
				...base,
				controls: [{ id: 'model', label: 'Model', kind: 'select', value: 'openai:gpt' }],
			})
		).toBe('openai:gpt');
		expect(currentModelLabel({ ...base, controls: [] })).toBeNull();
	});
});
