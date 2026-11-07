/**
 * Tests for the Auto model: the word itself (shared/autoModel) and the three
 * rules a turn sent on it is resolved by (shared/autoTurn).
 *
 *   1. The model is kept while the provider's cache is warm; effort is not.
 *   2. No decision is not a failure: the agent's default applies.
 *   3. What the router answered is frozen in a stamp, and reads one way.
 */

import { describe, it, expect } from 'vitest';

import { AUTO_MODEL, isAutoModel, ownModel } from '../../shared/autoModel';
import {
	DEFAULT_PROMPT_CACHE_LIFETIME_MS,
	autoModelAxesNote,
	autoModelChoice,
	autoModelHold,
	autoModelProblem,
	autoModelSupport,
	autoRouteStamp,
	autoRouterNote,
	autoTurnDetail,
	autoTurnLabel,
	autoTurnNeedsRoute,
	autoTurnReport,
	isAutoModelOffered,
	isAutoRouteDecision,
	modelChoiceLabel,
	pendingAutoTurnStamp,
	promptCacheLifetimeMs,
	queuedAutoTurnStamp,
	resolveAutoTurn,
	turnModelStatsFields,
	unreachableAutoRoute,
	withAutoModelOption,
	type AutoRouteStamp,
} from '../../shared/autoTurn';
import type { ModelHint } from '../../shared/autorunModelHints';
import type { RunOnTarget } from '../../shared/local-models/run-on';
import type { TierTarget } from '../../shared/modelTiers';

const NOW = 1_800_000_000_000;
const LOCAL: RunOnTarget = { type: 'source', endpointId: 'ep-maestro', model: 'qwen3.5-4b' };

const routed = (
	tier: 'low' | 'medium' | 'high',
	effort: 'low' | 'medium' | 'high'
): AutoRouteStamp => ({ tier, effort, engine: 'Embedding router (Gemma)', calibrated: false });

const OFF: AutoRouteStamp = { skipped: 'off', detail: 'Model routing is off.' };
const TIMEOUT: AutoRouteStamp = {
	skipped: 'timeout',
	detail: 'No decision within 400 ms.',
	engine: 'Local judge (Qwen)',
};

describe('the Auto model word', () => {
	it('is recognized whatever its case and spacing, and nothing else is', () => {
		expect(isAutoModel(AUTO_MODEL)).toBe(true);
		expect(isAutoModel(' Auto ')).toBe(true);
		expect(isAutoModel('AUTO')).toBe(true);
		expect(isAutoModel('automatic')).toBe(false);
		expect(isAutoModel('opus')).toBe(false);
		expect(isAutoModel('')).toBe(false);
		expect(isAutoModel(undefined)).toBe(false);
		expect(isAutoModel(null)).toBe(false);
	});

	it('is never the model an agent names for itself', () => {
		expect(ownModel('auto')).toBeUndefined();
		expect(ownModel('opus')).toBe('opus');
		expect(ownModel(undefined)).toBeUndefined();
		expect(ownModel('')).toBeUndefined();
	});
});

describe('rule 1: the model a live session keeps', () => {
	it('gives a provider with no row the default lifetime, which no row is under', () => {
		expect(promptCacheLifetimeMs('opencode')).toBe(DEFAULT_PROMPT_CACHE_LIFETIME_MS);
		expect(promptCacheLifetimeMs('claude-code')).toBeGreaterThanOrEqual(
			DEFAULT_PROMPT_CACHE_LIFETIME_MS
		);
		expect(DEFAULT_PROMPT_CACHE_LIFETIME_MS).toBe(5 * 60 * 1000);
	});

	it('holds nothing at a session start', () => {
		expect(autoModelHold('claude-code', undefined, NOW)).toBeUndefined();
	});

	it('keeps the model and the place of a session active inside the cache lifetime', () => {
		const lastActiveAt = NOW - promptCacheLifetimeMs('claude-code');
		expect(
			autoModelHold('claude-code', { model: 'haiku', runOn: LOCAL, lastActiveAt }, NOW)
		).toEqual({ model: 'haiku', runOn: LOCAL });
	});

	it('keeps the agent default too: a hold with no model is still a hold', () => {
		expect(autoModelHold('claude-code', { lastActiveAt: NOW - 1000 }, NOW)).toEqual({});
	});

	it('lets go of a session idle past the cache lifetime', () => {
		const lastActiveAt = NOW - promptCacheLifetimeMs('claude-code') - 1;
		expect(autoModelHold('claude-code', { model: 'haiku', lastActiveAt }, NOW)).toBeUndefined();
	});

	it('reads a session nobody timed as cold', () => {
		expect(autoModelHold('claude-code', { model: 'haiku' }, NOW)).toBeUndefined();
	});

	it('never holds the word auto as a model', () => {
		expect(autoModelHold('claude-code', { model: 'auto', lastActiveAt: NOW }, NOW)).toEqual({});
	});
});

describe('resolveAutoTurn', () => {
	it('launches a free turn on the tier the router chose, at its effort', () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('medium', 'low'),
			agentEffort: 'high',
		});

		expect(turn.model).toBe('sonnet');
		expect(turn.effort).toBe('low');
		expect(turn.runOn).toBeUndefined();
		expect(turn.tierSource).toBe('built-in');
		expect(turn.stamp).toEqual({ status: 'routed', route: routed('medium', 'low') });
		expect(turn.notes[0]).toBe('Auto: Embedding router (Gemma) chose tier medium, effort low.');
		expect(turn.notes.join(' ')).toContain('tier="medium" (auto) -> model sonnet');
	});

	it("maps the router's effort to the provider's own ladder", () => {
		const turn = resolveAutoTurn({ toolType: 'claude-code', route: routed('high', 'high') });
		expect(turn.model).toBe('opus');
		expect(turn.effort).toBe('max');
	});

	it('rule 1: a held session keeps its model and takes only the effort', () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('high', 'low'),
			hold: { model: 'haiku' },
			agentEffort: 'high',
		});

		expect(turn.model).toBe('haiku');
		expect(turn.effort).toBe('low');
		expect(turn.tierSource).toBeUndefined();
		expect(turn.stamp).toEqual({
			status: 'routed',
			hold: { model: 'haiku' },
			route: routed('high', 'low'),
		});
		expect(turn.notes[0]).toContain("The session keeps haiku while the provider's cache is warm.");
	});

	it('rule 1: a held session stays on the place a tier sent it', () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('high', 'medium'),
			hold: { model: 'qwen3.5-4b', runOn: LOCAL },
		});

		expect(turn.model).toBe('qwen3.5-4b');
		expect(turn.runOn).toEqual(LOCAL);
		expect(turn.stamp.runOn).toEqual(LOCAL);
	});

	it('rule 1: a hold on the agent default passes no model at all', () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('high', 'high'),
			hold: {},
		});
		expect(turn.model).toBeUndefined();
		expect(turn.effort).toBe('max');
		expect(turn.stamp.hold).toEqual({});
	});

	it("rule 2: with the router off the agent's default model and effort apply", () => {
		const turn = resolveAutoTurn({ toolType: 'claude-code', route: OFF, agentEffort: 'high' });

		expect(turn.model).toBeUndefined();
		expect(turn.effort).toBe('high');
		expect(turn.refusal).toBeUndefined();
		expect(turn.stamp).toEqual({ status: 'router-off', route: OFF });
		expect(turn.notes).toEqual([
			"Auto (router off): Model routing is off. The agent's default model and effort apply.",
		]);
	});

	it('rule 2: a router that did not answer is no decision, never a failure', () => {
		const turn = resolveAutoTurn({ toolType: 'claude-code', route: TIMEOUT, agentEffort: 'low' });

		expect(turn.model).toBeUndefined();
		expect(turn.effort).toBe('low');
		expect(turn.stamp.status).toBe('no-decision');
		expect(turn.notes[0]).toMatch(/^Auto \(no decision\): No decision within 400 ms\./);
	});

	it('rule 2: a turn nobody routed is no decision as well', () => {
		const turn = resolveAutoTurn({ toolType: 'claude-code' });
		expect(turn.stamp).toEqual({ status: 'no-decision' });
		expect(turn.model).toBeUndefined();
		expect(turn.notes[0]).toMatch(/^Auto: no router was asked\./);
	});

	it('rules 1 and 2 together: no decision still keeps a warm session on its model', () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: TIMEOUT,
			hold: { model: 'sonnet' },
			agentEffort: 'medium',
		});
		expect(turn.model).toBe('sonnet');
		expect(turn.effort).toBe('medium');
		expect(turn.stamp).toEqual({
			status: 'no-decision',
			hold: { model: 'sonnet' },
			route: TIMEOUT,
		});
	});

	it('launches a tier the agent maps to a source on that source', () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('low', 'low'),
			routing: { tierTargets: { low: LOCAL as TierTarget } },
		});

		expect(turn.model).toBe('qwen3.5-4b');
		expect(turn.runOn).toEqual(LOCAL);
		expect(turn.tierSource).toBe('agent');
		expect(turn.stamp.runOn).toEqual(LOCAL);
	});

	it('refuses a tier whose target cannot be used, and names it', () => {
		const turn = resolveAutoTurn({
			toolType: 'factory-droid',
			route: routed('low', 'low'),
			routing: { tierTargets: { low: LOCAL as TierTarget } },
		});

		expect(turn.refusal?.code).toBe('tier-unsupported-source');
		expect(turn.stamp.refusal).toBe(turn.refusal?.message);
		expect(turn.stamp.refusal).toMatch(/This agent's "low" tier target/);
	});

	it('applies only the effort on a provider with no tier mapping, and says so', () => {
		const turn = resolveAutoTurn({ toolType: 'copilot-cli', route: routed('high', 'high') });

		expect(turn.model).toBeUndefined();
		expect(turn.effort).toBe('xhigh');
		expect(turn.refusal).toBeUndefined();
		expect(turn.warnings.join(' ')).toMatch(/no model tier mapping/);
	});

	it('applies nothing on a provider with neither axis, without failing', () => {
		const turn = resolveAutoTurn({
			toolType: 'opencode',
			route: routed('low', 'low'),
			agentEffort: undefined,
		});
		expect(turn.model).toBeUndefined();
		expect(turn.effort).toBeUndefined();
		expect(turn.refusal).toBeUndefined();
		expect(turn.warnings).toHaveLength(2);
	});
});

describe('a marker outranks the router on the axes it sets', () => {
	const marker = (hint: Partial<ModelHint>): ModelHint => ({ line: 3, ...hint });

	it('asks the router only while an axis is left to it', () => {
		expect(autoTurnNeedsRoute(null)).toBe(true);
		expect(autoTurnNeedsRoute(marker({ tier: 'high' }))).toBe(true);
		expect(autoTurnNeedsRoute(marker({ effort: 'low' }))).toBe(true);
		expect(autoTurnNeedsRoute(marker({ tier: 'high', effort: 'default' }))).toBe(true);
		expect(autoTurnNeedsRoute(marker({ tier: 'high', effort: 'low' }))).toBe(false);
	});

	it("keeps the marker's tier and takes the router's effort", () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('low', 'low'),
			marker: marker({ tier: 'high', scopes: { tier: 'task' } }),
		});
		expect(turn.model).toBe('opus');
		expect(turn.effort).toBe('low');
		expect(turn.notes.join(' ')).toContain('tier="high" (task) -> model opus');
		expect(turn.notes.join(' ')).toContain('effort="low" (auto) -> low');
	});

	it("keeps the marker's effort and takes the router's tier", () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('low', 'low'),
			marker: marker({ effort: 'high', scopes: { effort: 'subscription' } }),
		});
		expect(turn.model).toBe('haiku');
		expect(turn.effort).toBe('max');
	});

	it('reads default as an axis left to the agent, which on Auto is the router', () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('medium', 'medium'),
			marker: marker({ tier: 'default', effort: 'default' }),
		});
		expect(turn.model).toBe('sonnet');
		expect(turn.effort).toBe('high');
	});

	it('needs no route and writes no Auto line when the marker sets both axes', () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			marker: marker({ tier: 'high', effort: 'low', scopes: { tier: 'task', effort: 'task' } }),
		});
		expect(turn.model).toBe('opus');
		expect(turn.effort).toBe('low');
		expect(turn.notes.some((note) => note.startsWith('Auto'))).toBe(false);
	});

	it("still reports a marker's misspelled value", () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('low', 'low'),
			marker: marker({ invalid: [{ attribute: 'tier', value: 'hgih' }] }),
		});
		expect(turn.model).toBe('haiku');
		expect(turn.warnings.join(' ')).toContain('Ignored tier="hgih" on line 4');
	});
});

describe('rule 3: what is frozen', () => {
	it('stamps a decision with the two levels and who chose them', () => {
		const stamp = autoRouteStamp({
			tier: 'medium',
			effort: 'low',
			tierConfidence: 0.7,
			engine: { id: 'jev-cloud', label: 'Jev (TypeSafe cloud)', calibrated: true },
			latencyMs: 212,
		});
		expect(stamp).toEqual({
			tier: 'medium',
			effort: 'low',
			engine: 'Jev (TypeSafe cloud)',
			calibrated: true,
		});
		expect(isAutoRouteDecision(stamp)).toBe(true);
	});

	it('stamps a skip with its reason, and the router when one was asked', () => {
		expect(
			autoRouteStamp({ skipped: 'off', detail: 'Model routing is off.', latencyMs: 0 })
		).toEqual({ skipped: 'off', detail: 'Model routing is off.' });
		expect(
			autoRouteStamp({
				skipped: 'timeout',
				detail: 'slow',
				engine: { id: 'local-judge', label: 'Local judge (Qwen)', calibrated: false },
				latencyMs: 400,
			})
		).toEqual({ skipped: 'timeout', detail: 'slow', engine: 'Local judge (Qwen)' });
		expect(isAutoRouteDecision(OFF)).toBe(false);
		expect(isAutoRouteDecision(undefined)).toBe(false);
	});

	it('stamps a router that could not be reached as no decision', () => {
		const stamp = unreachableAutoRoute('The desktop app is closed.');
		expect(stamp).toEqual({ skipped: 'unavailable', detail: 'The desktop app is closed.' });
		expect(resolveAutoTurn({ toolType: 'claude-code', route: stamp }).stamp.status).toBe(
			'no-decision'
		);
	});

	it('marks a turn the router has not answered as pending, with what it holds', () => {
		expect(pendingAutoTurnStamp(undefined)).toEqual({ status: 'pending' });
		expect(pendingAutoTurnStamp({ model: 'haiku', runOn: LOCAL })).toEqual({
			status: 'pending',
			hold: { model: 'haiku', runOn: LOCAL },
			runOn: LOCAL,
		});
	});

	it('reads as the pill does', () => {
		const free = resolveAutoTurn({ toolType: 'claude-code', route: routed('medium', 'low') });
		expect(autoTurnLabel(free.stamp, free.model)).toBe('Auto → medium · sonnet');

		const local = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('low', 'low'),
			routing: { tierTargets: { low: LOCAL as TierTarget } },
		});
		expect(autoTurnLabel(local.stamp, 'qwen3.5-4b · Maestro')).toBe(
			'Auto → low · qwen3.5-4b · Maestro'
		);

		const kept = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('high', 'low'),
			hold: { model: 'haiku' },
		});
		expect(autoTurnLabel(kept.stamp, kept.model)).toBe('Auto → haiku (kept)');

		expect(autoTurnLabel(resolveAutoTurn({ toolType: 'claude-code', route: OFF }).stamp)).toBe(
			'Auto (router off)'
		);
		expect(autoTurnLabel(resolveAutoTurn({ toolType: 'claude-code', route: TIMEOUT }).stamp)).toBe(
			'Auto (no decision)'
		);
		expect(autoTurnLabel(pendingAutoTurnStamp(undefined))).toBe('Auto');
	});
});

describe('what a turn on Auto says about itself', () => {
	it('names the router and what was done with its answer', () => {
		const free = resolveAutoTurn({ toolType: 'claude-code', route: routed('medium', 'low') });
		expect(autoTurnDetail(free.stamp)).toBe(
			'Auto: Embedding router (Gemma) chose tier medium, effort low.'
		);

		const kept = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('high', 'low'),
			hold: { model: 'haiku' },
		});
		expect(autoTurnDetail(kept.stamp)).toContain('chose tier high, effort low.');
		expect(autoTurnDetail(kept.stamp)).toContain('The session keeps haiku');
	});

	it('says why there is no decision', () => {
		const off = resolveAutoTurn({ toolType: 'claude-code', route: OFF });
		expect(autoTurnDetail(off.stamp)).toContain('Auto (router off): Model routing is off.');
		const slow = resolveAutoTurn({ toolType: 'claude-code', route: TIMEOUT });
		expect(autoTurnDetail(slow.stamp)).toContain('Auto (no decision):');
		expect(autoTurnDetail(pendingAutoTurnStamp(undefined))).toBe(
			'Auto: waiting for the model router.'
		);
	});

	it('carries a refusal, so a pill never hides a turn that did not launch', () => {
		const refused = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('low', 'low'),
			routing: { tierTargets: { low: { type: 'nonsense' } as unknown as TierTarget } },
		});
		expect(refused.stamp.refusal).toBeTruthy();
		expect(autoTurnDetail(refused.stamp)).toContain(refused.stamp.refusal);
	});

	it('reports a turn in a label and a sentence, for a caller with no pill', () => {
		const turn = resolveAutoTurn({ toolType: 'claude-code', route: routed('medium', 'low') });
		expect(autoTurnReport(turn)).toEqual({
			label: 'Auto → medium · sonnet',
			detail: 'Auto: Embedding router (Gemma) chose tier medium, effort low.',
		});
		// A place the caller can name wins over the model.
		expect(autoTurnReport(turn, 'qwen · Maestro').label).toBe('Auto → medium · qwen · Maestro');
	});

	it('stamps a queued item from the answer frozen on it', () => {
		expect(queuedAutoTurnStamp(undefined)).toEqual({ status: 'pending' });
		const answer = routed('high', 'medium');
		expect(queuedAutoTurnStamp(answer)).toEqual({ status: 'routed', route: answer });
		expect(queuedAutoTurnStamp(OFF)).toEqual({ status: 'router-off', route: OFF });
		expect(queuedAutoTurnStamp(TIMEOUT)).toEqual({ status: 'no-decision', route: TIMEOUT });
		// The tier's target is read when the turn launches, so the label has none yet.
		expect(autoTurnLabel(queuedAutoTurnStamp(answer))).toBe('Auto → high');
	});
});

describe('whether Auto is offered', () => {
	it('acts on both axes where the provider has tiers and an effort ladder', () => {
		const support = autoModelSupport({ toolType: 'claude-code' });
		expect(support).toEqual({ model: true, effort: true });
		expect(isAutoModelOffered(support)).toBe(true);
		expect(autoModelAxesNote(support)).toBe('picks the model and the effort for each turn');
		expect(autoModelProblem({ toolType: 'claude-code' })).toBeNull();
	});

	it('is not offered where it would change nothing', () => {
		const support = autoModelSupport({ toolType: 'opencode' });
		expect(support).toEqual({ model: false, effort: false });
		expect(isAutoModelOffered(support)).toBe(false);
		expect(autoModelChoice({ toolType: 'opencode' })).toBeNull();
		expect(autoModelProblem({ toolType: 'opencode' })).toMatch(
			/^Auto would change nothing for this agent: .* Map a tier first/
		);
	});

	it('is offered on the model axis alone once a tier is mapped', () => {
		const mapped = { medium: { type: 'provider-model', model: 'big-pickle' } as TierTarget };
		// The agent's own tier map.
		const own = autoModelSupport({ toolType: 'opencode', tierTargets: mapped });
		expect(own).toEqual({ model: true, effort: false });
		expect(autoModelAxesNote(own)).toBe(
			'picks the model; this provider has no effort levels to pick'
		);
		// The harness default is a layer too.
		expect(autoModelSupport({ toolType: 'opencode' }, { opencode: mapped }).model).toBe(true);
		expect(autoModelProblem({ toolType: 'opencode', tierTargets: mapped })).toBeNull();
	});

	it('picks effort alone for an agent whose tiers do not apply', () => {
		// The built-in table names the provider's cloud models, so it does not
		// apply to an agent that runs on a Local Models source.
		const support = autoModelSupport({ toolType: 'claude-code', runOn: LOCAL });
		expect(support).toEqual({ model: false, effort: true });
		expect(autoModelAxesNote(support)).toBe(
			'picks effort; map tiers in the Models tab to also pick the model'
		);
	});

	it('says which router decides, or that none does', () => {
		const off = autoRouterNote(undefined);
		expect(off.on).toBe(false);
		expect(off.text).toMatch(/^The model router is off, so a turn runs on the agent's default\./);
		expect(off.text).toContain('Model routing');

		const engine = autoRouterNote({ 'model-routing': { type: 'system-one' } });
		expect(engine).toEqual({ on: true, text: 'Decided by System One.' });

		const judge = autoRouterNote(
			{ 'model-routing': { type: 'endpoint', endpointId: 'ep-1', model: 'qwen3:latest' } },
			[{ id: 'ep-1', name: 'Ollama' }]
		);
		expect(judge.on).toBe(true);
		expect(judge.text).toBe('Decided by Local judge (qwen3:latest on Ollama), not calibrated.');
	});

	it('builds one tooltip from the axes and the router', () => {
		const choice = autoModelChoice(
			{ toolType: 'claude-code' },
			{ assignments: { 'model-routing': { type: 'system-one' } } }
		);
		expect(choice).toEqual({
			support: { model: true, effort: true },
			routerOn: true,
			title: 'Auto: picks the model and the effort for each turn. Decided by System One.',
		});
		// Router off is still a choice: its turns run the agent's default.
		const off = autoModelChoice({ toolType: 'claude-code' });
		expect(off?.routerOn).toBe(false);
		expect(off?.title).toContain('The model router is off');
	});

	it('lists Auto after the default entry, once, and only when offered', () => {
		const choice = autoModelChoice({ toolType: 'claude-code' });
		expect(withAutoModelOption(['', 'opus', 'sonnet'], choice)).toEqual([
			'',
			AUTO_MODEL,
			'opus',
			'sonnet',
		]);
		expect(withAutoModelOption(['opus'], choice)).toEqual([AUTO_MODEL, 'opus']);
		expect(withAutoModelOption([], choice)).toEqual([AUTO_MODEL]);
		// A list that already carries the word does not get it twice.
		expect(withAutoModelOption(['Auto', 'opus'], choice)).toEqual([AUTO_MODEL, 'opus']);
		// Not offered: the list is the provider's own, and a stray word is dropped.
		const models = ['', 'opus'];
		expect(withAutoModelOption(models, null)).toBe(models);
		expect(withAutoModelOption(['auto', 'opus'], null)).toEqual(['opus']);
	});

	it('labels the word and leaves every other model alone', () => {
		expect(modelChoiceLabel('auto')).toBe('Auto');
		expect(modelChoiceLabel('AUTO')).toBe('Auto');
		expect(modelChoiceLabel('claude-opus-5-5')).toBe('claude-opus-5-5');
	});
});

describe("turnModelStatsFields: what a turn's stats row says about its model", () => {
	it('says nothing for a turn on a named model on the provider', () => {
		expect(turnModelStatsFields({})).toEqual({});
		expect(turnModelStatsFields({ runOn: undefined, auto: undefined })).toEqual({});
		expect(turnModelStatsFields({ runOn: { type: 'provider' } })).toEqual({});
	});

	it('names the source a turn launched on: its id and the model it serves', () => {
		expect(turnModelStatsFields({ runOn: LOCAL })).toEqual({
			runOnEndpoint: 'ep-maestro',
			runOnModel: 'qwen3.5-4b',
		});
	});

	it('keeps the context size out of the row: it is not where the turn ran', () => {
		expect(turnModelStatsFields({ runOn: { ...LOCAL, contextTokens: 65_536 } })).toEqual({
			runOnEndpoint: 'ep-maestro',
			runOnModel: 'qwen3.5-4b',
		});
	});

	it('names no source for a target that cannot be read, whole or in part', () => {
		expect(turnModelStatsFields({ runOn: { type: 'source', endpointId: 'ep-x' } })).toEqual({});
		expect(turnModelStatsFields({ runOn: { type: 'source', model: 'qwen3' } })).toEqual({});
		expect(turnModelStatsFields({ runOn: 'ep-x:qwen3' })).toEqual({});
		expect(turnModelStatsFields({ runOn: { type: 'elsewhere' } })).toEqual({});
	});

	it("records the router's tier when a router decided", () => {
		expect(
			turnModelStatsFields({ auto: { status: 'routed', route: routed('low', 'high') } })
		).toEqual({ routedTier: 'low' });
	});

	it('records no tier when no router decided', () => {
		expect(turnModelStatsFields({ auto: { status: 'pending' } })).toEqual({});
		expect(turnModelStatsFields({ auto: { status: 'router-off', route: OFF } })).toEqual({});
		expect(turnModelStatsFields({ auto: { status: 'no-decision', route: TIMEOUT } })).toEqual({});
		expect(
			turnModelStatsFields({ auto: { status: 'no-decision', route: unreachableAutoRoute('x') } })
		).toEqual({});
	});

	it('records both for a tier that launched on a source', () => {
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('low', 'low'),
			routing: { tierTargets: { low: LOCAL } },
		});

		expect(turnModelStatsFields({ runOn: turn.runOn, auto: turn.stamp })).toEqual({
			runOnEndpoint: 'ep-maestro',
			runOnModel: 'qwen3.5-4b',
			routedTier: 'low',
		});
	});

	it("records the router's tier for a held session, with the place the session kept", () => {
		// Rule 1: the tier is the router's answer and is not applied. The row says
		// both, so the tier split counts the decision and the source counts the work.
		const hold = autoModelHold(
			'claude-code',
			{ model: 'qwen3.5-4b', runOn: LOCAL, lastActiveAt: NOW - 1000 },
			NOW
		);
		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: routed('high', 'low'),
			...(hold ? { hold } : {}),
		});

		expect(turnModelStatsFields({ runOn: turn.runOn, auto: turn.stamp })).toEqual({
			runOnEndpoint: 'ep-maestro',
			runOnModel: 'qwen3.5-4b',
			routedTier: 'high',
		});
	});
});
