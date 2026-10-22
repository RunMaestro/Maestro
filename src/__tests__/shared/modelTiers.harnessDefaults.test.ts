/**
 * Harness tier defaults: the rows a harness shows, how a target is spelled and
 * checked, what Suggest proposes, and the warning for a model a harness no
 * longer lists.
 *
 * The Suggest rules are pinned against catalogues captured from real installs
 * (`fixtures/tier-catalogues`): Codex CLI 0.162.1's `models_cache.json`, an
 * `opencode models` listing, and the Copilot list from models.dev. A rule that
 * starts guessing shows up here as a tier that should have stayed blank.
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

import {
	GEMMA_4_E4B_ID,
	GPT_OSS_120B_ID,
	GPT_OSS_20B_ID,
	QWEN3_1_7B_ID,
	QWEN3_CODER_NEXT_ID,
} from '../../shared/local-models/model-catalog';
import {
	MODEL_SERVER_ENDPOINT_ID,
	MODEL_SERVER_NAME,
} from '../../shared/local-models/model-server';
import type { RunOnPickerSource } from '../../shared/local-models/run-on-picker';
import {
	codexCatalogModels,
	formatTierTargetSpec,
	harnessTierRows,
	parseTierTargetEdit,
	parseTierTargetSpec,
	staleTierModels,
	suggestHarnessTierDefaults,
	TIER_AGENT_MODEL_LABEL,
	tierHarnessIds,
	tierHarnessProblem,
	tierTargetLabel,
	withHarnessTierDefault,
	withHarnessTierTargets,
	type CodexCatalogModel,
	type HarnessCatalogModel,
	type HarnessTierDefaults,
	type TierTarget,
} from '../../shared/modelTiers';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'tier-catalogues');

const CODEX_RAW = (
	JSON.parse(fs.readFileSync(path.join(FIXTURES, 'codex-models-cache.json'), 'utf8')) as {
		models: CodexCatalogModel[];
	}
).models;
const CODEX = codexCatalogModels(CODEX_RAW);

const ids = (list: readonly string[]): HarnessCatalogModel[] => list.map((id) => ({ id }));

const OPENCODE = ids(
	fs
		.readFileSync(path.join(FIXTURES, 'opencode-models.txt'), 'utf8')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '')
);

const COPILOT = ids(
	JSON.parse(fs.readFileSync(path.join(FIXTURES, 'copilot-models.json'), 'utf8')) as string[]
);

/** What Claude Code's discovery always lists first, plus two full ids. */
const CLAUDE = ids([
	'fable',
	'sonnet',
	'opus',
	'haiku',
	'opus[1m]',
	'sonnet[1m]',
	'claude-opus-4-8',
	'claude-haiku-4-5-20251001',
]);

const SERVER = (models: string[]): RunOnPickerSource => ({
	endpointId: MODEL_SERVER_ENDPOINT_ID,
	name: MODEL_SERVER_NAME,
	models,
});

const LOCAL: TierTarget = { type: 'source', endpointId: MODEL_SERVER_ENDPOINT_ID, model: 'm' };

describe('which harnesses have tiers', () => {
	it('lists the pickable harnesses that take a model, and no others', () => {
		const harnesses = tierHarnessIds();
		expect(harnesses).toEqual(
			expect.arrayContaining(['claude-code', 'codex', 'opencode', 'copilot-cli', 'factory-droid'])
		);
		expect(harnesses).not.toContain('terminal');
		for (const harness of harnesses) expect(tierHarnessProblem(harness)).toBeNull();
	});

	it('refuses an id that is not a harness by naming the ones that are', () => {
		expect(tierHarnessProblem('claud')).toMatch(/Unknown harness "claud".*claude-code/);
		expect(tierHarnessProblem('terminal')).toMatch(/Unknown harness "terminal"/);
	});
});

describe('the Codex catalogue as captured', () => {
	it('keeps the listed models with the description and priority Codex states', () => {
		expect(CODEX.map((model) => model.id)).toEqual([
			'gpt-6.1-sol',
			'gpt-6-astra',
			'gpt-6-sol',
			'gpt-6-luna',
			'gpt-5.6-sol',
			'gpt-5.6-terra',
			'gpt-5.6-luna',
		]);
		expect(CODEX[0]).toEqual({
			id: 'gpt-6.1-sol',
			description: 'Latest workhorse model for coding and everyday work.',
			priority: 1,
		});
	});

	it('drops a hidden model and an entry with no slug', () => {
		expect(
			codexCatalogModels([
				{ slug: 'a', visibility: 'hide' },
				{ visibility: 'list' },
				{ slug: 'b', description: '  ', priority: Number.NaN },
			])
		).toEqual([{ id: 'b' }]);
	});
});

describe('Suggest', () => {
	it('names the newest member of each Codex family, by the catalogue order', () => {
		expect(suggestHarnessTierDefaults('codex', CODEX)).toEqual({
			low: { target: { type: 'provider-model', model: 'gpt-6-luna' }, reason: 'newest Luna' },
			medium: { target: { type: 'provider-model', model: 'gpt-6.1-sol' }, reason: 'newest Sol' },
			high: {
				target: { type: 'provider-model', model: 'gpt-6-astra' },
				reason: 'the only Astra listed',
			},
		});
	});

	it('follows a family to its next generation instead of the built-in slug', () => {
		const next = [...CODEX, { id: 'gpt-7-luna', priority: 0 }];
		expect(suggestHarnessTierDefaults('codex', next).low.target).toEqual({
			type: 'provider-model',
			model: 'gpt-7-luna',
		});
	});

	it('falls back to what the catalogue says about a model when a family is gone', () => {
		const renamed: HarnessCatalogModel[] = [
			{ id: 'gpt-8', description: 'Latest workhorse model.', priority: 1 },
			{ id: 'gpt-8-max', description: 'Frontier intelligence.', priority: 2 },
			{ id: 'gpt-8-mini', description: 'Fast and affordable model.', priority: 3 },
			{ id: 'gpt-7-mini', description: 'Older fast model.', priority: 9 },
		];
		expect(suggestHarnessTierDefaults('codex', renamed)).toEqual({
			low: {
				target: { type: 'provider-model', model: 'gpt-8-mini' },
				reason: 'described as "Fast and affordable model."',
			},
			medium: {
				target: { type: 'provider-model', model: 'gpt-8' },
				reason: 'catalogue priority 1',
			},
			high: {
				target: { type: 'provider-model', model: 'gpt-8-max' },
				reason: 'described as "Frontier intelligence."',
			},
		});
	});

	it('leaves medium blank when the first model is already the high pick', () => {
		const topHeavy: HarnessCatalogModel[] = [
			{ id: 'x-max', description: 'Frontier model.', priority: 1 },
			{ id: 'x-other', priority: 2 },
		];
		const suggested = suggestHarnessTierDefaults('codex', topHeavy);
		expect(suggested.high.target).toEqual({ type: 'provider-model', model: 'x-max' });
		expect(suggested.medium.target).toBeNull();
		expect(suggested.low.target).toBeNull();
	});

	it('does not choose between several described models with no stated order', () => {
		const unordered = ids(['a', 'b']).map((model) => ({ ...model, description: 'A fast model.' }));
		expect(suggestHarnessTierDefaults('codex', unordered).low.target).toBeNull();
	});

	it("uses Claude Code's aliases, which always name the current model", () => {
		const suggested = suggestHarnessTierDefaults('claude-code', CLAUDE);
		expect(suggested.low.target).toEqual({ type: 'provider-model', model: 'haiku' });
		expect(suggested.medium.target).toEqual({ type: 'provider-model', model: 'sonnet' });
		expect(suggested.high.target).toEqual({ type: 'provider-model', model: 'opus' });
		expect(suggested.high.reason).toBe('the opus alias, which always names the current Opus');
	});

	it('offers the built-in mapping where the catalogue lists it (Factory Droid)', () => {
		const droid = ids([
			'gpt-5.1',
			'claude-sonnet-4-5-20250929',
			'claude-opus-4-5-20251101',
			'claude-haiku-4-5-20251001',
		]);
		expect(suggestHarnessTierDefaults('factory-droid', droid).low).toEqual({
			target: { type: 'provider-model', model: 'claude-haiku-4-5-20251001' },
			reason: 'the built-in mapping, which this catalogue lists',
		});
	});

	it('leaves every tier blank for an OpenCode listing: it states only names', () => {
		const suggested = suggestHarnessTierDefaults('opencode', OPENCODE, [
			SERVER([GPT_OSS_20B_ID, GPT_OSS_120B_ID]),
		]);
		// The listing holds Claude families (`anthropic/claude-opus-5-5`), and no
		// local model has passed the agent qualification with OpenCode. Neither
		// is a fact that picks one model, so nothing is suggested.
		for (const tier of ['low', 'medium', 'high'] as const) {
			expect(suggested[tier].target).toBeNull();
			expect(suggested[tier].reason).toMatch(/OpenCode's catalogue states nothing/);
		}
	});

	it('leaves every tier blank for the Copilot list, which holds two families at once', () => {
		expect(COPILOT.map((model) => model.id)).toEqual(
			expect.arrayContaining(['claude-opus-5.5', 'gpt-6-astra'])
		);
		const suggested = suggestHarnessTierDefaults('copilot-cli', COPILOT);
		expect(Object.values(suggested).every((tier) => tier.target === null)).toBe(true);
	});

	it('says so when a harness lists no catalogue at all', () => {
		expect(suggestHarnessTierDefaults('pi', []).low).toEqual({
			target: null,
			reason: 'No model catalogue was found for Pi. Pick one by hand.',
		});
	});

	describe('local models, when the provider catalogue names no tier', () => {
		it('ranks the models that run agents on this harness by size', () => {
			const suggested = suggestHarnessTierDefaults(
				'claude-code',
				[],
				[SERVER([GPT_OSS_120B_ID, QWEN3_1_7B_ID, GPT_OSS_20B_ID, GEMMA_4_E4B_ID])]
			);
			// The 1.7B model is the smallest listed, and it has not passed the agent
			// qualification, so it is not the low pick.
			expect(suggested.low).toEqual({
				target: { type: 'source', endpointId: MODEL_SERVER_ENDPOINT_ID, model: GEMMA_4_E4B_ID },
				reason: 'smallest local model that runs agents on Claude Code (7.5B parameters)',
			});
			expect(suggested.medium.target).toEqual({
				type: 'source',
				endpointId: MODEL_SERVER_ENDPOINT_ID,
				model: GPT_OSS_20B_ID,
			});
			expect(suggested.high.target).toEqual({
				type: 'source',
				endpointId: MODEL_SERVER_ENDPOINT_ID,
				model: GPT_OSS_120B_ID,
			});
		});

		it('reads the qualification per harness', () => {
			// Gemma 4 E4B passed with Claude Code only, so Codex starts at the 20B.
			const suggested = suggestHarnessTierDefaults(
				'codex',
				[],
				[SERVER([GEMMA_4_E4B_ID, GPT_OSS_20B_ID, QWEN3_CODER_NEXT_ID])]
			);
			expect(suggested.low.target).toMatchObject({ model: GPT_OSS_20B_ID });
			expect(suggested.high.target).toMatchObject({ model: QWEN3_CODER_NEXT_ID });
			expect(suggested.medium).toEqual({
				target: null,
				reason: 'Fewer than three local model sizes are listed, so none is the middle one.',
			});
		});

		it('ranks nothing from one model, or from a source that does not say what a model is', () => {
			const one = suggestHarnessTierDefaults('claude-code', [], [SERVER([GPT_OSS_20B_ID])]);
			expect(one.low.target).toBeNull();
			const ollama = suggestHarnessTierDefaults(
				'claude-code',
				[],
				[{ endpointId: 'ep-ollama', name: 'Ollama', models: ['qwen3:latest', 'qwen3:14b'] }]
			);
			expect(ollama.high.target).toBeNull();
		});

		it('is never mixed into a row the provider catalogue filled', () => {
			const suggested = suggestHarnessTierDefaults('claude-code', ids(['opus']), [
				SERVER([GEMMA_4_E4B_ID, GPT_OSS_20B_ID, GPT_OSS_120B_ID]),
			]);
			expect(suggested.high.target).toEqual({ type: 'provider-model', model: 'opus' });
			expect(suggested.low.target).toBeNull();
		});

		it('does not apply to a harness with no Run on recipe', () => {
			const suggested = suggestHarnessTierDefaults(
				'factory-droid',
				[],
				[SERVER([GEMMA_4_E4B_ID, GPT_OSS_20B_ID, GPT_OSS_120B_ID])]
			);
			expect(suggested.low.target).toBeNull();
		});
	});
});

describe('a tier whose model the harness no longer lists', () => {
	it('reports nothing when every tier model is listed', () => {
		expect(staleTierModels('codex', CODEX)).toEqual([]);
	});

	it('names the newest listed member of the family as the replacement', () => {
		const nextGeneration = codexCatalogModels([
			{ slug: 'gpt-7-luna', visibility: 'list', priority: 3 },
			{ slug: 'gpt-7-sol', visibility: 'list', priority: 1 },
			{ slug: 'gpt-6.1-sol', visibility: 'list', priority: 2 },
			{ slug: 'gpt-6-luna', visibility: 'hide', priority: 9 },
		]);
		expect(staleTierModels('codex', nextGeneration)).toEqual([
			{ tier: 'low', model: 'gpt-6-luna', source: 'built-in', replacement: 'gpt-7-luna' },
			{ tier: 'high', model: 'gpt-6-astra', source: 'built-in', replacement: null },
		]);
	});

	it('treats a hidden model as not listed', () => {
		const hidden = codexCatalogModels(
			CODEX_RAW.map((model) =>
				model.slug === 'gpt-6-astra' ? { ...model, visibility: 'hide' } : model
			)
		);
		expect(staleTierModels('codex', hidden)).toEqual([
			{ tier: 'high', model: 'gpt-6-astra', source: 'built-in', replacement: null },
		]);
	});

	it('checks the value a launch would use: a saved harness default hides the built-in', () => {
		const defaults: HarnessTierDefaults = {
			codex: { low: { type: 'provider-model', model: 'gpt-4-mini' }, high: LOCAL },
		};
		expect(staleTierModels('codex', CODEX, defaults)).toEqual([
			{ tier: 'low', model: 'gpt-4-mini', source: 'harness-default', replacement: 'gpt-6-luna' },
		]);
	});

	it('covers any harness, not Codex alone', () => {
		const defaults: HarnessTierDefaults = {
			'claude-code': { high: { type: 'provider-model', model: 'claude-opus-3' } },
		};
		expect(staleTierModels('claude-code', CLAUDE, defaults)).toEqual([
			{ tier: 'high', model: 'claude-opus-3', source: 'harness-default', replacement: 'opus' },
		]);
	});

	it('knows nothing is stale when the catalogue lists nothing', () => {
		expect(staleTierModels('codex', [])).toEqual([]);
	});
});

describe('the rows of a harness', () => {
	it('shows the built-in table for a harness with nothing saved', () => {
		expect(harnessTierRows('claude-code')).toEqual([
			{
				tier: 'low',
				target: { type: 'provider-model', model: 'haiku' },
				source: 'built-in',
				builtIn: 'haiku',
			},
			{
				tier: 'medium',
				target: { type: 'provider-model', model: 'sonnet' },
				source: 'built-in',
				builtIn: 'sonnet',
			},
			{
				tier: 'high',
				target: { type: 'provider-model', model: 'opus' },
				source: 'built-in',
				builtIn: 'opus',
			},
		]);
	});

	it('puts a saved default over the built-in table, tier by tier', () => {
		const rows = harnessTierRows('claude-code', { 'claude-code': { low: LOCAL } });
		expect(rows[0]).toEqual({
			tier: 'low',
			target: LOCAL,
			source: 'harness-default',
			builtIn: 'haiku',
		});
		expect(rows[1].source).toBe('built-in');
	});

	it('has no value for a tier no layer maps', () => {
		expect(harnessTierRows('opencode')[0]).toEqual({
			tier: 'low',
			target: null,
			source: null,
			builtIn: null,
		});
	});

	it('shows why a stored default cannot be used, with no value', () => {
		const rows = harnessTierRows('factory-droid', { 'factory-droid': { high: LOCAL } });
		expect(rows[2]).toMatchObject({ tier: 'high', target: null, source: 'harness-default' });
		expect(rows[2].problem).toMatch(/cannot run on/);
	});
});

describe('how a target is spelled', () => {
	it('round-trips every kind of target', () => {
		const targets: Array<TierTarget | undefined> = [
			undefined,
			{ type: 'provider-model' },
			{ type: 'provider-model', model: 'opus' },
			{ type: 'source', endpointId: 'ep-1', model: 'qwen3:latest' },
		];
		expect(targets.map(formatTierTargetSpec)).toEqual([
			'default',
			'provider',
			'provider:opus',
			'ep-1:qwen3:latest',
		]);
		for (const target of targets) {
			expect(parseTierTargetSpec(formatTierTargetSpec(target))).toEqual({ ok: true, target });
		}
	});

	it('spells a Run on provider target as the provider on the agent model', () => {
		expect(formatTierTargetSpec({ type: 'provider' })).toBe('provider');
	});

	it('keeps a colon inside a provider model name', () => {
		expect(parseTierTargetSpec('provider:ollama/qwen3:8b')).toEqual({
			ok: true,
			target: { type: 'provider-model', model: 'ollama/qwen3:8b' },
		});
	});

	it('refuses a word that is none of the forms', () => {
		expect(parseTierTargetSpec('opus')).toEqual({
			ok: false,
			error: 'A tier target is default, provider, provider:<model>, or <source id>:<model>.',
		});
		expect(parseTierTargetSpec('ep-1:').ok).toBe(false);
	});

	it('labels a target for a person', () => {
		expect(tierTargetLabel({ type: 'provider-model', model: 'opus' })).toBe('opus');
		expect(tierTargetLabel({ type: 'provider-model' })).toBe(TIER_AGENT_MODEL_LABEL);
		expect(
			tierTargetLabel({ type: 'source', endpointId: 'ep-1', model: 'qwen3' }, [
				{ id: 'ep-1', name: 'Ollama' },
			])
		).toBe('qwen3 on Ollama');
	});
});

describe('a target about to be stored', () => {
	it('clears a tier for nothing, and stores one spelling of the provider', () => {
		expect(parseTierTargetEdit('claude-code', undefined)).toEqual({ ok: true, target: undefined });
		expect(parseTierTargetEdit('claude-code', { type: 'provider' })).toEqual({
			ok: true,
			target: { type: 'provider-model' },
		});
	});

	it('refuses a source on a harness with no Run on recipe', () => {
		const edit = parseTierTargetEdit('factory-droid', LOCAL);
		expect(edit.ok).toBe(false);
	});

	it('refuses a source id that names nothing, when the saved sources are passed', () => {
		const target = { type: 'source', endpointId: 'ep-gone', model: 'm' };
		expect(parseTierTargetEdit('claude-code', target).ok).toBe(true);
		const edit = parseTierTargetEdit('claude-code', target, [{ id: 'ep-1', name: 'Ollama' }]);
		expect(edit).toMatchObject({ ok: false });
		expect(!edit.ok && edit.error).toMatch(/No source has the id "ep-gone"/);
	});

	it('refuses a malformed target', () => {
		expect(parseTierTargetEdit('claude-code', { type: 'source' }).ok).toBe(false);
		expect(parseTierTargetEdit('claude-code', 'opus').ok).toBe(false);
	});
});

describe('writing the harness defaults', () => {
	const opus: TierTarget = { type: 'provider-model', model: 'opus' };

	it('sets and clears one tier, keeping the record sparse', () => {
		const set = withHarnessTierDefault({}, 'claude-code', 'high', opus);
		expect(set).toEqual({ 'claude-code': { high: opus } });
		expect(withHarnessTierDefault(set, 'claude-code', 'high', undefined)).toEqual({});
	});

	it('replaces a whole row and leaves the other harnesses alone', () => {
		const defaults: HarnessTierDefaults = {
			'claude-code': { low: LOCAL, high: opus },
			codex: { low: LOCAL },
		};
		expect(withHarnessTierTargets(defaults, 'claude-code', { medium: opus })).toEqual({
			'claude-code': { medium: opus },
			codex: { low: LOCAL },
		});
		expect(withHarnessTierTargets(defaults, 'claude-code', {})).toEqual({ codex: { low: LOCAL } });
	});

	it('does not change the record it was given', () => {
		const defaults: HarnessTierDefaults = { codex: { low: LOCAL } };
		withHarnessTierDefault(defaults, 'codex', 'low', undefined);
		expect(defaults).toEqual({ codex: { low: LOCAL } });
	});
});
