/**
 * Tests for claudeTokenMode.ts - the canonical collapse of the persisted
 * `(enableMaestroP, maestroPMode)` pair into the tri-state token mode, and its
 * inverse. This pair is read by every Claude Code spawn surface, so the
 * migration semantics (legacy Adaptive toggle -> 'dynamic') must stay exact.
 */

import { describe, it, expect } from 'vitest';
import {
	getClaudeTokenMode,
	toClaudeTokenModeSource,
	type ClaudeTokenMode,
} from '../../shared/claudeTokenMode';

describe('getClaudeTokenMode', () => {
	it('returns api for null/undefined source', () => {
		expect(getClaudeTokenMode(null)).toBe('api');
		expect(getClaudeTokenMode(undefined)).toBe('api');
	});

	it('returns api when the opt-in is off (or absent)', () => {
		expect(getClaudeTokenMode({})).toBe('api');
		expect(getClaudeTokenMode({ enableMaestroP: false })).toBe('api');
		// Even an explicit refinement is ignored while the opt-in is off.
		expect(getClaudeTokenMode({ enableMaestroP: false, maestroPMode: 'interactive' })).toBe('api');
	});

	it('migrates a legacy opt-in with no refinement to dynamic', () => {
		// A pre-refinement session that only had the Adaptive toggle on must read
		// as its historical behavior: dynamic auto-switching.
		expect(getClaudeTokenMode({ enableMaestroP: true })).toBe('dynamic');
	});

	it('honors an explicit refinement when the opt-in is on', () => {
		expect(getClaudeTokenMode({ enableMaestroP: true, maestroPMode: 'interactive' })).toBe(
			'interactive'
		);
		expect(getClaudeTokenMode({ enableMaestroP: true, maestroPMode: 'dynamic' })).toBe('dynamic');
	});
});

describe('toClaudeTokenModeSource', () => {
	it('encodes each mode into the persisted pair, keeping the legacy boolean in sync', () => {
		expect(toClaudeTokenModeSource('api')).toEqual({
			enableMaestroP: false,
			maestroPMode: 'dynamic',
		});
		expect(toClaudeTokenModeSource('interactive')).toEqual({
			enableMaestroP: true,
			maestroPMode: 'interactive',
		});
		expect(toClaudeTokenModeSource('dynamic')).toEqual({
			enableMaestroP: true,
			maestroPMode: 'dynamic',
		});
	});
});

describe('round-trip', () => {
	it('getClaudeTokenMode(toClaudeTokenModeSource(m)) === m for every mode', () => {
		const modes: ClaudeTokenMode[] = ['api', 'interactive', 'dynamic'];
		for (const mode of modes) {
			expect(getClaudeTokenMode(toClaudeTokenModeSource(mode))).toBe(mode);
		}
	});
});
