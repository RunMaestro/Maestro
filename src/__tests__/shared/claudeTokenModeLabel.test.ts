/**
 * Tests for shared/claudeTokenModeLabel.ts — the Claude "token source" pill
 * label/title helper. Pure function, so exhaustively cover the label matrix
 * (mode × adaptive) plus the tooltip wording per reason.
 */

import { describe, it, expect } from 'vitest';
import { getTokenSourcePill } from '../../shared/claudeTokenModeLabel';

describe('getTokenSourcePill', () => {
	describe('label', () => {
		it('labels an interactive turn "TUI Wrapper"', () => {
			expect(getTokenSourcePill({ mode: 'interactive' }).label).toBe('TUI Wrapper');
		});

		it('labels an api turn "claude -p"', () => {
			expect(getTokenSourcePill({ mode: 'api' }).label).toBe('claude -p');
		});

		it('prefixes "Dynamic " when adaptive is set', () => {
			expect(getTokenSourcePill({ mode: 'interactive', adaptive: true }).label).toBe(
				'Dynamic TUI Wrapper'
			);
			expect(getTokenSourcePill({ mode: 'api', adaptive: true }).label).toBe('Dynamic claude -p');
		});

		it('omits the "Dynamic " prefix when adaptive is false or omitted', () => {
			expect(getTokenSourcePill({ mode: 'interactive', adaptive: false }).label).toBe(
				'TUI Wrapper'
			);
			expect(getTokenSourcePill({ mode: 'api' }).label).toBe('claude -p');
		});
	});

	describe('isTui flag', () => {
		it('is true for interactive and false for api', () => {
			expect(getTokenSourcePill({ mode: 'interactive' }).isTui).toBe(true);
			expect(getTokenSourcePill({ mode: 'api' }).isTui).toBe(false);
		});
	});

	describe('title', () => {
		it('describes the maestro-p TUI capture for interactive turns', () => {
			expect(getTokenSourcePill({ mode: 'interactive' }).title).toBe(
				'Captured via maestro-p driving the Claude TUI'
			);
		});

		it('describes the claude --print capture for api turns', () => {
			expect(getTokenSourcePill({ mode: 'api' }).title).toBe('Captured via claude --print');
		});

		it('notes Dynamic Mode in the tooltip when adaptive is set', () => {
			expect(getTokenSourcePill({ mode: 'interactive', adaptive: true }).title).toBe(
				'Captured via maestro-p driving the Claude TUI (Dynamic Mode enabled)'
			);
			expect(getTokenSourcePill({ mode: 'api', adaptive: true }).title).toBe(
				'Captured via claude --print (Dynamic Mode enabled - fell back to API)'
			);
		});

		it('uses the forced-fallback wording when reason is "limit", regardless of mode', () => {
			const forced = 'Forced fallback: Max plan 5-hour or weekly quota is exhausted.';
			expect(getTokenSourcePill({ mode: 'api', reason: 'limit' }).title).toBe(forced);
			expect(getTokenSourcePill({ mode: 'interactive', reason: 'limit' }).title).toBe(forced);
		});
	});
});
