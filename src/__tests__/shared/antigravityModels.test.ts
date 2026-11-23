import { describe, expect, it } from 'vitest';
import {
	antigravityEffortUnion,
	antigravitySdkSelection,
	parseAntigravityModelList,
	resolveAntigravityModelEffortArgs,
	resolveAntigravitySelection,
	splitAntigravityModelEffort,
} from '../../shared/antigravityModels';

// Verbatim `agy models` output on agy 1.5.14.
const AGY_MODELS = `Fetching available models...
gemini-4-neon-high\tGemini 4 Neon (High)
gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)
gemini-4-neon-medium\tGemini 4 Neon (Medium)
gemini-4-neon-low\tGemini 4 Neon (Low)
gemini-4-carbon-medium\tGemini 4 Carbon (Medium)
gemini-4-carbon-high\tGemini 4 Carbon (High)
gemini-4-carbon-low\tGemini 4 Carbon (Low)
gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)
gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)
gemini-pro-orchestrator-neon\tOrchestrator (Neon)
gemini-pro-orchestrator\tOrchestrator (Carbon)
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
claude-opus-5-5-low\tClaude Opus 5.5 (Low)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`;

describe('parseAntigravityModelList', () => {
	const catalog = parseAntigravityModelList(AGY_MODELS);

	it('lists each base model once, in first-seen order, skipping the heading', () => {
		expect(catalog.models).toEqual([
			'gemini-4-neon',
			'gemini-4-carbon',
			'gemini-4-hydrogen',
			'gemini-pro-orchestrator-neon',
			'gemini-pro-orchestrator',
			'gemini-3.8-flash',
			'claude-opus-5-5',
			'gpt-oss-120b',
		]);
	});

	it('records the efforts each model accepts, in ladder order', () => {
		expect(catalog.efforts['gemini-4-neon']).toEqual(['low', 'medium', 'high', 'xhigh']);
		expect(catalog.efforts['gemini-4-carbon']).toEqual(['low', 'medium', 'high']);
		expect(catalog.efforts['gpt-oss-120b']).toEqual(['medium']);
		expect(catalog.efforts['gemini-pro-orchestrator-neon']).toEqual([]);
	});

	it('unions the efforts across models', () => {
		expect(antigravityEffortUnion(catalog)).toEqual(['low', 'medium', 'high', 'xhigh']);
	});

	it('ignores prose, blank lines and CRLF line ends', () => {
		const parsed = parseAntigravityModelList(
			'Fetching available models...\r\n\r\nsome note without a tab\r\nx-low\tX (Low)\r\n'
		);
		expect(parsed.models).toEqual(['x']);
		expect(parsed.efforts.x).toEqual(['low']);
	});

	it('does not let an inherited key masquerade as a model', () => {
		expect(parseAntigravityModelList('constructor-low\tC\n').models).toEqual(['constructor']);
		expect(parseAntigravityModelList('').efforts.toString).toBeUndefined();
	});
});

describe('splitAntigravityModelEffort', () => {
	it.each([
		['gemini-4-neon-xhigh', { base: 'gemini-4-neon', effort: 'xhigh' }],
		['gemini-3.8-flash-low', { base: 'gemini-3.8-flash', effort: 'low' }],
		['gemini-4-neon', { base: 'gemini-4-neon' }],
		['gemini-pro-orchestrator-neon', { base: 'gemini-pro-orchestrator-neon' }],
	])('%s', (id, expected) => {
		expect(splitAntigravityModelEffort(id)).toEqual(expected);
	});
});

describe('resolveAntigravitySelection', () => {
	it('lets an explicit effort replace the suffix agy would otherwise reject as a conflict', () => {
		expect(resolveAntigravitySelection('gemini-4-neon-high', 'low')).toEqual({
			model: 'gemini-4-neon',
			effort: 'low',
		});
	});

	it('keeps a suffixed id whose suffix matches the effort, which agy accepts', () => {
		expect(resolveAntigravitySelection('gemini-4-hydrogen-low', 'low')).toEqual({
			model: 'gemini-4-hydrogen-low',
			effort: 'low',
		});
	});

	it('runs a suffixed id as written when no effort is set', () => {
		expect(resolveAntigravitySelection('gemini-4-neon-high', undefined)).toEqual({
			model: 'gemini-4-neon-high',
		});
	});

	it('drops an effort for an orchestrator, which takes none', () => {
		expect(resolveAntigravitySelection('gemini-pro-orchestrator-neon', 'low')).toEqual({
			model: 'gemini-pro-orchestrator-neon',
		});
		expect(resolveAntigravitySelection('gemini-pro-orchestrator', 'high')).toEqual({
			model: 'gemini-pro-orchestrator',
		});
	});

	it('passes an effort alone through', () => {
		expect(resolveAntigravitySelection(undefined, 'high')).toEqual({ effort: 'high' });
	});
});

describe('resolveAntigravityModelEffortArgs', () => {
	it('rewrites a conflicting pair in place and keeps every other argument', () => {
		expect(
			resolveAntigravityModelEffortArgs([
				'-p',
				'hi',
				'--model',
				'gemini-4-neon-high',
				'--effort',
				'low',
				'--print-timeout',
				'30m',
			])
		).toEqual([
			'-p',
			'hi',
			'--model',
			'gemini-4-neon',
			'--effort',
			'low',
			'--print-timeout',
			'30m',
		]);
	});

	it('lets a later custom-arg --effort win, as agy reads it', () => {
		expect(
			resolveAntigravityModelEffortArgs([
				'--model',
				'gemini-4-hydrogen-high',
				'--effort',
				'low',
				'--effort=xhigh',
			])
		).toEqual(['--model', 'gemini-4-hydrogen', '--effort', 'xhigh']);
	});

	it('removes --effort for an orchestrator', () => {
		expect(
			resolveAntigravityModelEffortArgs(['--model', 'gemini-pro-orchestrator', '--effort', 'high'])
		).toEqual(['--model', 'gemini-pro-orchestrator']);
	});

	it('leaves a pair agy accepts untouched, including custom-arg spellings', () => {
		const args = ['--model', 'ordinary-model', '--effort', 'high', '--effort="none"'];
		expect(resolveAntigravityModelEffortArgs(args)).toBe(args);
	});

	it('leaves args with no model or effort flag untouched', () => {
		const args = ['--output-format', 'stream-json', '-p', 'x'];
		expect(resolveAntigravityModelEffortArgs(args)).toBe(args);
	});
});

describe('antigravitySdkSelection', () => {
	it('splits a suffixed id so the SDK gets an API model name and a thinking level', () => {
		expect(antigravitySdkSelection('gemini-4-neon-xhigh', undefined)).toEqual({
			model: 'gemini-4-neon',
			effort: 'xhigh',
		});
	});

	it('keeps an explicit effort over the suffix', () => {
		expect(antigravitySdkSelection('gemini-4-neon-xhigh', 'low')).toEqual({
			model: 'gemini-4-neon',
			effort: 'low',
		});
	});

	it('passes an effort with no model through for the SDK default model', () => {
		expect(antigravitySdkSelection(undefined, 'medium')).toEqual({ effort: 'medium' });
	});
});
