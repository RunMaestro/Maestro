import { describe, it, expect } from 'vitest';
import {
	cueAutoMarker,
	cueRunIsAutoRouted,
	cueTurnLaunch,
	applyCueTurnSettingsPatch,
	cueTurnSettingsOf,
	formatCueTurnSettings,
	hasCueTurnSettingsPatch,
	parseCueTurnSettingsInput,
	resolveCueTurnSettings,
	sameCueTurnSettings,
} from '../../../shared/cue/turn-settings';
import { resolveAutoTurn } from '../../../shared/autoTurn';

describe('cueTurnSettingsOf', () => {
	it('returns undefined when nothing is set, so ordinary subs thread nothing', () => {
		expect(cueTurnSettingsOf({})).toBeUndefined();
		expect(cueTurnSettingsOf({ model: '   ' })).toBeUndefined();
	});

	it('keeps only the set fields, with the model trimmed', () => {
		expect(cueTurnSettingsOf({ tier: 'high', model: undefined, effort: 'low' })).toEqual({
			tier: 'high',
			effort: 'low',
		});
		expect(cueTurnSettingsOf({ model: ' gpt-5.5-codex ' })).toEqual({ model: 'gpt-5.5-codex' });
	});
});

describe('resolveCueTurnSettings', () => {
	it('falls through to the agent values when the sub sets nothing', () => {
		const resolved = resolveCueTurnSettings('claude-code', undefined, 'sonnet', 'medium');
		expect(resolved).toMatchObject({ model: 'sonnet', effort: 'medium' });
		expect(resolved.notes).toEqual([]);
		expect(resolved.warnings).toEqual([]);
	});

	it('maps tier and effort to ladder positions, not same-named strings', () => {
		const resolved = resolveCueTurnSettings(
			'claude-code',
			{ tier: 'high', effort: 'high' },
			'sonnet',
			'low'
		);
		expect(resolved.model).toBe('opus');
		expect(resolved.effort).toBe('max');
		expect(resolved.notes.join(' ')).toContain('(subscription)');
	});

	it('passes a pinned model through verbatim and notes it', () => {
		const resolved = resolveCueTurnSettings('codex', { model: 'gpt-5.5-codex' }, 'gpt-5');
		expect(resolved.model).toBe('gpt-5.5-codex');
		expect(resolved.notes[0]).toBe('model="gpt-5.5-codex" (subscription)');
	});

	it('lets a pinned model win over a tier it was wrongly paired with', () => {
		const resolved = resolveCueTurnSettings('claude-code', { tier: 'low', model: 'opus-4-7' });
		expect(resolved.model).toBe('opus-4-7');
		expect(resolved.notes.some((n) => n.startsWith('tier='))).toBe(false);
	});

	it('keeps the agent model and warns when the provider has no tier table', () => {
		const resolved = resolveCueTurnSettings('copilot-cli', { tier: 'high' }, 'gpt-5');
		expect(resolved.model).toBe('gpt-5');
		expect(resolved.warnings).toHaveLength(1);
		expect(resolved.warnings[0]).toMatch(/copilot-cli has no model tier mapping/);
	});

	it('maps a codex tier to the family model', () => {
		const resolved = resolveCueTurnSettings('codex', { tier: 'high' }, 'gpt-6.1-sol');
		expect(resolved.model).toBe('gpt-6-astra');
		expect(resolved.warnings).toEqual([]);
	});

	it('warns when the provider has no effort setting', () => {
		const resolved = resolveCueTurnSettings('opencode', { effort: 'high' });
		expect(resolved.effort).toBeUndefined();
		expect(resolved.warnings[0]).toMatch(/opencode has no effort setting/);
	});
});

describe('resolveCueTurnSettings with tier targets', () => {
	const LOCAL = { type: 'source' as const, endpointId: 'ep-ollama', model: 'qwen3:latest' };

	it("launches a subscription's tier on the agent's own tier target", () => {
		const resolved = resolveCueTurnSettings('claude-code', { tier: 'low' }, 'sonnet', undefined, {
			tierTargets: { low: LOCAL },
		});
		expect(resolved).toMatchObject({ model: LOCAL.model, runOn: LOCAL, tierSource: 'agent' });
		expect(resolved.notes[0]).toContain('(subscription)');
	});

	it('reads the harness default when the agent sets no target for the tier', () => {
		const resolved = resolveCueTurnSettings('claude-code', { tier: 'high' }, 'sonnet', undefined, {
			harnessDefaults: { 'claude-code': { high: { type: 'provider-model', model: 'opus[1m]' } } },
		});
		expect(resolved).toMatchObject({
			model: 'opus[1m]',
			runOn: { type: 'provider' },
			tierSource: 'harness-default',
		});
	});

	it('refuses a tier target that cannot be used', () => {
		const resolved = resolveCueTurnSettings('claude-code', { tier: 'low' }, 'sonnet', undefined, {
			tierTargets: { low: { type: 'source' } as never },
		});
		expect(resolved.refusal?.code).toBe('tier-invalid-target');
		expect(resolved.runOn).toBeUndefined();
	});

	it('leaves the place alone for a pinned model: it names the model only', () => {
		const resolved = resolveCueTurnSettings(
			'claude-code',
			{ tier: 'low', model: 'opus' },
			'sonnet',
			undefined,
			{ tierTargets: { low: LOCAL } }
		);
		expect(resolved.model).toBe('opus');
		expect(resolved.runOn).toBeUndefined();
		expect(resolved.refusal).toBeUndefined();
	});
});

describe('sameCueTurnSettings', () => {
	it('treats absent as matching absent and blank model as absent', () => {
		expect(sameCueTurnSettings({}, {})).toBe(true);
		expect(sameCueTurnSettings({ model: '' }, {})).toBe(true);
	});

	it('distinguishes any differing axis', () => {
		expect(sameCueTurnSettings({ tier: 'high' }, { tier: 'high' })).toBe(true);
		expect(sameCueTurnSettings({ tier: 'high' }, { tier: 'low' })).toBe(false);
		expect(sameCueTurnSettings({ tier: 'high' }, { tier: 'high', effort: 'low' })).toBe(false);
	});
});

describe('formatCueTurnSettings', () => {
	it('labels what the YAML set, and nothing when it set nothing', () => {
		expect(formatCueTurnSettings({})).toBe('');
		expect(formatCueTurnSettings({ tier: 'high', effort: 'low' })).toBe('tier high, effort low');
		expect(formatCueTurnSettings({ model: 'gpt-5.5-codex' })).toBe('model gpt-5.5-codex');
	});
});

describe('a subscription on the Auto model', () => {
	it('opts its runs into routing with model: auto, and nothing else does', () => {
		expect(cueRunIsAutoRouted({ model: 'auto' })).toBe(true);
		expect(cueRunIsAutoRouted({ model: ' Auto ' })).toBe(true);
		expect(cueRunIsAutoRouted({ model: 'opus' })).toBe(false);
		expect(cueRunIsAutoRouted({ tier: 'high' })).toBe(false);
		expect(cueRunIsAutoRouted({})).toBe(false);
		expect(cueRunIsAutoRouted(undefined)).toBe(false);
	});

	it('resolves to what the run launches with when the router gives no decision', () => {
		const resolved = resolveCueTurnSettings(
			'claude-code',
			{ model: 'auto', effort: 'high' },
			'sonnet',
			'low'
		);
		// The word never becomes a model, and the agent's own model is the default.
		expect(resolved.model).toBe('sonnet');
		expect(resolved.effort).toBe('max');
		expect(resolved.notes.join(' ')).not.toContain('model="auto"');
	});

	it('never routes a run that did not opt in: an agent set to Auto runs on its default', () => {
		const resolved = resolveCueTurnSettings('claude-code', undefined, 'auto', 'low');
		expect(resolved.model).toBeUndefined();
		expect(resolved.effort).toBe('low');

		// A subscription's tier still launches where that tier launches.
		expect(resolveCueTurnSettings('claude-code', { tier: 'high' }, 'auto').model).toBe('opus');
	});

	it("keeps the subscription's effort over the router's, and leaves the tier to the router", () => {
		expect(cueAutoMarker({ model: 'auto' })).toBeNull();
		expect(cueAutoMarker(undefined)).toBeNull();
		const marker = cueAutoMarker({ model: 'auto', effort: 'high' });
		expect(marker).toEqual({ line: 0, effort: 'high', scopes: { effort: 'subscription' } });

		const turn = resolveAutoTurn({
			toolType: 'claude-code',
			route: { tier: 'low', effort: 'low', engine: 'Embedding router', calibrated: false },
			marker,
		});
		expect(turn.model).toBe('haiku');
		expect(turn.effort).toBe('max');
	});
});

describe('cueTurnLaunch', () => {
	const LOCAL = { type: 'source' as const, endpointId: 'maestro-server', model: 'qwen3.5-4b' };
	const OWN = { type: 'source' as const, endpointId: 'ep-ollama', model: 'qwen3:latest' };

	it("carries the model and effort, on the agent's own target when the turn names no place", () => {
		const turn = resolveCueTurnSettings('claude-code', { tier: 'high', effort: 'low' });
		expect(cueTurnLaunch(turn, OWN)).toEqual({
			customModel: 'opus',
			customEffort: 'low',
			runOn: OWN,
		});
	});

	it("carries the tier's place over the agent's own", () => {
		const turn = resolveCueTurnSettings('claude-code', { tier: 'low' }, undefined, undefined, {
			tierTargets: { low: LOCAL },
		});
		expect(cueTurnLaunch(turn, OWN)).toMatchObject({ customModel: 'qwen3.5-4b', runOn: LOCAL });
	});

	it('carries a refusal as the message the run fails with', () => {
		const turn = resolveCueTurnSettings('factory-droid', { tier: 'low' }, undefined, undefined, {
			tierTargets: { low: LOCAL },
		});
		expect(cueTurnLaunch(turn, undefined).launchRefusal).toMatch(/"low" tier target/);
		expect(
			'launchRefusal' in cueTurnLaunch(resolveCueTurnSettings('claude-code', undefined), undefined)
		).toBe(false);
	});
});

describe('applyCueTurnSettingsPatch', () => {
	it('setting a tier replaces a pinned model, since they are one choice', () => {
		const target: Record<string, unknown> = { name: 's', model: 'opus-4-7', effort: 'low' };
		expect(applyCueTurnSettingsPatch(target, { tier: 'high' })).toBeNull();
		expect(target).toEqual({ name: 's', tier: 'high', effort: 'low' });
	});

	it('setting an exact model replaces a tier, trimmed', () => {
		const target: Record<string, unknown> = { name: 's', tier: 'high' };
		expect(applyCueTurnSettingsPatch(target, { model: ' gpt-5.5-codex ' })).toBeNull();
		expect(target).toEqual({ name: 's', model: 'gpt-5.5-codex' });
	});

	it('null clears an axis and undefined leaves it alone', () => {
		const target: Record<string, unknown> = { name: 's', tier: 'high', effort: 'low' };
		expect(applyCueTurnSettingsPatch(target, { tier: null, model: null })).toBeNull();
		expect(target).toEqual({ name: 's', effort: 'low' });
		expect(applyCueTurnSettingsPatch(target, { effort: null })).toBeNull();
		expect(target).toEqual({ name: 's' });
	});

	it('refuses a tier and a model together, and writes nothing', () => {
		const target: Record<string, unknown> = { name: 's' };
		expect(applyCueTurnSettingsPatch(target, { tier: 'high', model: 'opus' })).toMatch(/not both/);
		expect(target).toEqual({ name: 's' });
	});

	it('refuses a level outside low | medium | high', () => {
		const target: Record<string, unknown> = { name: 's' };
		expect(applyCueTurnSettingsPatch(target, { tier: 'max' as never })).toMatch(/tier must be/);
		expect(applyCueTurnSettingsPatch(target, { effort: 'max' as never })).toMatch(/effort must be/);
		expect(applyCueTurnSettingsPatch(target, { model: '  ' })).toMatch(/model needs/);
		expect(target).toEqual({ name: 's' });
	});

	it('refuses to set a model on a command or notify subscription, but lets one be cleared', () => {
		const command: Record<string, unknown> = { name: 's', action: 'command', tier: 'high' };
		expect(applyCueTurnSettingsPatch(command, { effort: 'low' })).toMatch(/action "command"/);
		expect(applyCueTurnSettingsPatch(command, { tier: null })).toBeNull();
		expect(command).toEqual({ name: 's', action: 'command' });

		const notify: Record<string, unknown> = { name: 's', action: 'notify' };
		expect(applyCueTurnSettingsPatch(notify, { tier: 'low' })).toMatch(/action "notify"/);
	});
});

describe('hasCueTurnSettingsPatch', () => {
	it('is false for an absent or empty patch and true once any axis is named', () => {
		expect(hasCueTurnSettingsPatch(undefined)).toBe(false);
		expect(hasCueTurnSettingsPatch({})).toBe(false);
		expect(hasCueTurnSettingsPatch({ effort: null })).toBe(true);
		expect(hasCueTurnSettingsPatch({ tier: 'low' })).toBe(true);
	});
});

describe('parseCueTurnSettingsInput', () => {
	it('accepts levels in any case and trims the model', () => {
		expect(parseCueTurnSettingsInput({ tier: 'HIGH', effort: ' Low ' })).toEqual({
			ok: true,
			settings: { tier: 'high', effort: 'low' },
		});
		expect(parseCueTurnSettingsInput({ model: ' gpt-5.5-codex ' })).toEqual({
			ok: true,
			settings: { model: 'gpt-5.5-codex' },
		});
		expect(parseCueTurnSettingsInput({})).toEqual({ ok: true, settings: {} });
	});

	it('names the flag and a stable code for each refusal', () => {
		expect(parseCueTurnSettingsInput({ tier: 'hgih' })).toMatchObject({ code: 'BAD_TIER' });
		expect(parseCueTurnSettingsInput({ effort: 'max' })).toMatchObject({ code: 'BAD_EFFORT' });
		expect(parseCueTurnSettingsInput({ model: '   ' })).toMatchObject({ code: 'BAD_MODEL' });
		expect(parseCueTurnSettingsInput({ tier: 'high', model: 'opus' })).toMatchObject({
			code: 'TIER_AND_MODEL',
		});
	});
});
