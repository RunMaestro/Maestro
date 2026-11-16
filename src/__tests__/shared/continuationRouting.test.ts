/**
 * Tests for src/shared/continuationRouting.ts
 *
 * The module is a reader, not a router: every fact must be what the existing
 * owner (Run on, tiers, background requests) says, so these tests compare the
 * module's answer with the owner's own, and check that it never reaches for a
 * setting it was not handed.
 */

import { describe, it, expect } from 'vitest';
import {
	describeContinuationRouting,
	describeRoutingLines,
	ROUTING_NOT_CHECKED,
} from '../../shared/continuationRouting';
import { agentTierRows, resolveTierModel } from '../../shared/modelTiers';
import {
	backgroundRequestsSupport,
	parseBackgroundRequests,
} from '../../shared/local-models/background-requests';
import { agentRunOnSupport } from '../../shared/local-models/run-on';

const ENDPOINTS = [{ id: 'ep-1', name: 'Workstation' }];
const SOURCE = { type: 'source', endpointId: 'ep-1', model: 'qwen3' } as const;
const SOURCE_BACKGROUND = { target: SOURCE };

describe('describeContinuationRouting', () => {
	it('reads an agent with no settings as the provider, its default model, built-in tiers, no routing', () => {
		const routing = describeContinuationRouting({ toolType: 'claude-code' });
		expect(routing).toMatchObject({
			basis: 'configured-now',
			provider: 'claude-code',
			model: { value: null, setOn: 'provider-default' },
			effort: { value: null, setOn: 'provider-default' },
			runOn: { kind: 'provider', label: 'Provider' },
			backgroundRequests: { status: 'not-routed' },
		});
		expect(routing.tiers.map((t) => [t.tier, t.source])).toEqual([
			['low', 'built-in'],
			['medium', 'built-in'],
			['high', 'built-in'],
		]);
		// The tier targets are the tier owner's own answer, not a second table.
		expect(routing.tiers[0].target).toBe(resolveTierModel('claude-code', 'low'));
	});

	it('states what a configured routing does not establish, in the data and not only in the text', () => {
		const routing = describeContinuationRouting({ toolType: 'claude-code', runOn: SOURCE });
		expect(routing.notChecked).toEqual([...ROUTING_NOT_CHECKED]);
		expect(routing.notChecked.join(' ')).toMatch(/source is enabled, reachable/);
		expect(routing.notChecked.join(' ')).toMatch(/token proxy is on for this agent/);
		expect(routing.notChecked.join(' ')).toMatch(/earlier turns of this tab ran/);
		// A caller cannot reach into the shared list.
		expect(routing.notChecked).not.toBe(ROUTING_NOT_CHECKED);
	});

	it('takes the model and effort from the tab first, then the agent, and says which', () => {
		const both = describeContinuationRouting({
			toolType: 'claude-code',
			tabModel: ' tab-model ',
			agentModel: 'agent-model',
			tabEffort: 'high',
			agentEffort: 'low',
		});
		expect(both.model).toEqual({ value: 'tab-model', setOn: 'tab' });
		expect(both.effort).toEqual({ value: 'high', setOn: 'tab' });
		const agentOnly = describeContinuationRouting({
			toolType: 'claude-code',
			tabModel: '  ',
			agentModel: 'agent-model',
		});
		expect(agentOnly.model).toEqual({ value: 'agent-model', setOn: 'agent' });
		expect(agentOnly.effort.setOn).toBe('provider-default');
	});

	describe('Run on', () => {
		it('names a source by its saved name', () => {
			const routing = describeContinuationRouting({
				toolType: 'claude-code',
				runOn: SOURCE,
				endpoints: ENDPOINTS,
			});
			expect(routing.runOn.kind).toBe('source');
			expect(routing.runOn.label).toContain('qwen3');
			expect(routing.runOn.label).toContain('Workstation');
		});

		it('reads a malformed stored target as not usable, with the owner reason, and does not throw', () => {
			const routing = describeContinuationRouting({ toolType: 'claude-code', runOn: 'nonsense' });
			expect(routing.runOn.kind).toBe('invalid');
			expect(routing.runOn.label).toMatch(/model source is an object/);
			expect(describeRoutingLines(routing)[1]).toMatch(
				/^Model source: the stored target is not usable \(/
			);
		});

		it('does not believe a stored source on a harness that cannot run on one, and says why', () => {
			const support = agentRunOnSupport('terminal');
			expect(support.supported).toBe(false);
			const routing = describeContinuationRouting({
				toolType: 'terminal',
				runOn: SOURCE,
				endpoints: ENDPOINTS,
			});
			expect(routing.runOn.kind).toBe('unsupported');
			expect(routing.runOn.label).toBe(support.supported ? '' : support.reason);
			expect(describeRoutingLines(routing)[1]).toMatch(
				/^Model source: a source is stored, but this harness cannot run on one \(/
			);
			// An explicit provider target needs no recipe.
			expect(
				describeContinuationRouting({ toolType: 'terminal', runOn: { type: 'provider' } }).runOn
			).toEqual({ kind: 'provider', label: 'Provider' });
		});

		it('says a source is configured, not that it is reachable', () => {
			const routing = describeContinuationRouting({
				toolType: 'claude-code',
				runOn: SOURCE,
				endpoints: ENDPOINTS,
			});
			const line = describeRoutingLines(routing)[1];
			expect(line).toMatch(/^Model source: configured for .*qwen3/);
			expect(line).not.toMatch(/\bwill\b|\bsent\b|\breachable\b/);
		});

		it('does not apply the built-in tier table to an agent that runs on a source', () => {
			const routing = describeContinuationRouting({
				toolType: 'claude-code',
				runOn: SOURCE,
				endpoints: ENDPOINTS,
			});
			// The tier owner refuses the built-in model here; the module shows its answer.
			const owner = agentTierRows({ toolType: 'claude-code', runOn: SOURCE });
			expect(routing.tiers.map((t) => t.target)).toEqual(owner.map(() => null));
		});
	});

	describe('tiers', () => {
		it('shows an agent override, a harness default, and the layer each came from', () => {
			const routing = describeContinuationRouting({
				toolType: 'claude-code',
				tierTargets: { low: { type: 'provider-model', model: 'my-low' } },
				harnessTierDefaults: {
					'claude-code': { medium: { type: 'provider-model', model: 'my-mid' } },
				},
			});
			expect(routing.tiers.map((t) => [t.tier, t.target, t.source])).toEqual([
				['low', 'my-low', 'agent'],
				['medium', 'my-mid', 'harness-default'],
				['high', resolveTierModel('claude-code', 'high'), 'built-in'],
			]);
		});

		it('keeps the owner reason for a tier that cannot be used', () => {
			const routing = describeContinuationRouting({
				toolType: 'claude-code',
				tierTargets: { low: { type: 'bogus' } as never },
			});
			expect(routing.tiers[0]).toMatchObject({ tier: 'low', target: null, source: 'agent' });
			expect(routing.tiers[0].problem).toMatch(/cannot be used/);
			expect(describeRoutingLines(routing)[2]).toContain('low = unusable');
		});

		it('says a tier is not mapped for a provider with no tier table', () => {
			const lines = describeRoutingLines(describeContinuationRouting({ toolType: 'terminal' }));
			expect(lines[2]).toMatch(/low = Not mapped/);
		});
	});

	describe('background requests', () => {
		it('is configured, not claimed as sent, when set on a Claude Code agent, and names the source', () => {
			const routing = describeContinuationRouting({
				toolType: 'claude-code',
				backgroundRequests: { target: { type: 'source', endpointId: 'ep-1', model: 'tiny' } },
				endpoints: ENDPOINTS,
			});
			expect(routing.backgroundRequests.status).toBe('configured');
			expect(describeRoutingLines(routing)[3]).toMatch(
				/^Background requests: configured to go to tiny on Workstation\.$/
			);
			expect(describeRoutingLines(routing)[3]).not.toMatch(/\bsent to\b|\bwill\b/);
		});

		it('is not available for a provider the proxy cannot route, whatever is stored', () => {
			const routing = describeContinuationRouting({ toolType: 'codex' });
			expect(routing.backgroundRequests).toMatchObject({ status: 'unsupported' });
			expect(describeRoutingLines(routing)[3]).toBe(
				'Background requests: not available for this provider.'
			);
		});

		it.each([
			[
				'codex',
				{ target: { type: 'source', endpointId: 'synthetic-unavailable', model: 'synthetic' } },
			],
			['gemini-cli', { target: { type: 'source', endpointId: 'ep-1', model: 'tiny' } }],
			['codex', { target: 'not a target' }],
			['codex', 42],
			['codex', { target: { type: 'source' } }],
		])(
			'never believes a stored setting on %s, whose provider the proxy cannot route for',
			(toolType, stored) => {
				// The provider gate comes first: a valid, a stale and a malformed value read the same.
				const routing = describeContinuationRouting({
					toolType: toolType as never,
					backgroundRequests: stored,
					endpoints: ENDPOINTS,
				});
				expect(routing.backgroundRequests.status).toBe('unsupported');
				expect(describeRoutingLines(routing)[3]).toBe(
					'Background requests: not available for this provider.'
				);
			}
		);

		it('uses the owner reason for an unsupported provider', () => {
			const routing = describeContinuationRouting({
				toolType: 'codex',
				backgroundRequests: SOURCE_BACKGROUND,
			});
			expect(routing.backgroundRequests).toEqual({
				status: 'unsupported',
				reason: backgroundRequestsSupport('codex').supported
					? ''
					: (backgroundRequestsSupport('codex') as { reason: string }).reason,
			});
		});

		it('is reported as not usable when the stored setting is malformed, with the owner reason', () => {
			const routing = describeContinuationRouting({
				toolType: 'claude-code',
				backgroundRequests: 5,
			});
			const owner = parseBackgroundRequests(5);
			expect(owner.ok).toBe(false);
			expect(routing.backgroundRequests).toEqual({
				status: 'invalid',
				reason: owner.ok ? '' : owner.error,
			});
		});
	});

	describe('the report lines', () => {
		it('write one fact per line and use the words of the settings', () => {
			const lines = describeRoutingLines(
				describeContinuationRouting({ toolType: 'claude-code', tabModel: 'opus' })
			);
			expect(lines).toHaveLength(5);
			expect(lines[0]).toBe(
				"Provider claude-code; model opus (set on the tab); effort default (the provider's default)."
			);
			expect(lines[1]).toBe('Model source: Provider.');
			expect(lines[2]).toMatch(/^Tier targets: low = .* \(Built-in\), medium = .*, high = .*\.$/);
			expect(lines[3]).toBe('Background requests: not routed (they go to the provider).');
			expect(lines[4]).toBe(
				'Not checked: whether a source is enabled, reachable and serves the model, whether the token proxy is on for this agent (background requests need it), where earlier turns of this tab ran.'
			);
		});

		it('hold no em dash, no en dash and no score', () => {
			const lines = describeRoutingLines(
				describeContinuationRouting({ toolType: 'claude-code' })
			).join('\n');
			expect(lines).not.toMatch(
				new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`)
			);
			expect(lines).not.toMatch(/score|probab|saving/i);
		});
	});

	it('reads only what it is handed: no store, no clock, and the input is not changed', () => {
		const input = Object.freeze({
			toolType: 'claude-code' as const,
			tierTargets: Object.freeze({
				low: Object.freeze({ type: 'provider-model' as const, model: 'm' }),
			}),
			runOn: Object.freeze({ type: 'provider' as const }),
		});
		const first = describeContinuationRouting(input);
		expect(describeContinuationRouting(input)).toEqual(first);
	});
});
