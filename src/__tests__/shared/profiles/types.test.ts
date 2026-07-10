/**
 * @file types.test.ts
 * @description Tests for the pure Agent Profile contracts: spawn-override
 * resolution order (profile wins, else base agent) and profile validation.
 */

import { describe, it, expect } from 'vitest';
import {
	resolveProfileSpawnOverrides,
	validateAgentProfile,
	type AgentProfile,
	type ProfileBaseAgentValues,
} from '../../../shared/profiles/types';

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
	return {
		id: 'p1',
		name: 'Worker',
		baseAgentId: 'agent-1',
		...overrides,
	};
}

describe('resolveProfileSpawnOverrides', () => {
	it('uses the profile values when they are set', () => {
		const base: ProfileBaseAgentValues = {
			customModel: 'base-model',
			customEffort: 'low',
			customArgs: '--base',
			appendSystemPrompt: 'base role',
		};
		const merged = resolveProfileSpawnOverrides(
			profile({
				model: 'haiku',
				effort: 'high',
				customArgs: '--profile',
				appendSystemPrompt: 'reviewer role',
			}),
			base
		);
		expect(merged).toEqual({
			customModel: 'haiku',
			customEffort: 'high',
			customArgs: '--profile',
			appendSystemPrompt: 'reviewer role',
		});
	});

	it('falls back to the base agent when a profile field is undefined', () => {
		const base: ProfileBaseAgentValues = {
			customModel: 'base-model',
			customEffort: 'medium',
			customArgs: '--base',
			appendSystemPrompt: 'base role',
		};
		// Only the model is overridden on the profile.
		const merged = resolveProfileSpawnOverrides(profile({ model: 'sonnet' }), base);
		expect(merged).toEqual({
			customModel: 'sonnet',
			customEffort: 'medium',
			customArgs: '--base',
			appendSystemPrompt: 'base role',
		});
	});

	it('yields undefined for fields absent on both profile and base agent', () => {
		const merged = resolveProfileSpawnOverrides(profile(), {});
		expect(merged).toEqual({
			customModel: undefined,
			customEffort: undefined,
			customArgs: undefined,
			appendSystemPrompt: undefined,
		});
	});

	it('uses profile values with no fallback when the base agent is missing', () => {
		const merged = resolveProfileSpawnOverrides(
			profile({ model: 'haiku', effort: 'high' }),
			null
		);
		expect(merged).toEqual({
			customModel: 'haiku',
			customEffort: 'high',
			customArgs: undefined,
			appendSystemPrompt: undefined,
		});
	});
});

describe('validateAgentProfile', () => {
	it('accepts a well-formed profile', () => {
		const p = validateAgentProfile({
			id: 'p1',
			name: 'Reviewer',
			baseAgentId: 'agent-1',
			model: 'sonnet',
			effort: 'high',
			appendSystemPrompt: 'Be adversarial.',
			customArgs: '--verbose',
		});
		expect(p).not.toBeNull();
		expect(p?.id).toBe('p1');
		expect(p?.model).toBe('sonnet');
		expect(p?.appendSystemPrompt).toBe('Be adversarial.');
	});

	it('rejects entries missing required fields', () => {
		expect(validateAgentProfile(null)).toBeNull();
		expect(validateAgentProfile({})).toBeNull();
		expect(validateAgentProfile({ id: 'p1', name: 'x' })).toBeNull();
		expect(validateAgentProfile({ id: 'p1', baseAgentId: 'a' })).toBeNull();
		expect(validateAgentProfile({ id: '   ', name: 'x', baseAgentId: 'a' })).toBeNull();
	});

	it('drops blank optional fields so they fall back to the base agent', () => {
		const p = validateAgentProfile({
			id: 'p1',
			name: 'Worker',
			baseAgentId: 'agent-1',
			model: '   ',
			effort: '',
		});
		expect(p).not.toBeNull();
		expect(p?.model).toBeUndefined();
		expect(p?.effort).toBeUndefined();
	});

	it('ignores non-string optional fields', () => {
		const p = validateAgentProfile({
			id: 'p1',
			name: 'Worker',
			baseAgentId: 'agent-1',
			model: 42,
			customArgs: ['--x'],
		});
		expect(p).not.toBeNull();
		expect(p?.model).toBeUndefined();
		expect(p?.customArgs).toBeUndefined();
	});
});
