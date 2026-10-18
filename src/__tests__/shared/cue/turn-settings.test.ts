import { describe, it, expect } from 'vitest';
import {
	applyCueTurnSettingsPatch,
	cueTurnSettingsOf,
	formatCueTurnSettings,
	hasCueTurnSettingsPatch,
	parseCueTurnSettingsInput,
	resolveCueTurnSettings,
	sameCueTurnSettings,
} from '../../../shared/cue/turn-settings';

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
		const resolved = resolveCueTurnSettings('codex', { tier: 'high' }, 'gpt-5');
		expect(resolved.model).toBe('gpt-5');
		expect(resolved.warnings).toHaveLength(1);
		expect(resolved.warnings[0]).toMatch(/codex has no model tier mapping/);
	});

	it('warns when the provider has no effort setting', () => {
		const resolved = resolveCueTurnSettings('opencode', { effort: 'high' });
		expect(resolved.effort).toBeUndefined();
		expect(resolved.warnings[0]).toMatch(/opencode has no effort setting/);
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
