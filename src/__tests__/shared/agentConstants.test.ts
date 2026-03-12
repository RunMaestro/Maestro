/**
 * Tests for shared/agentConstants.ts — Context windows and shared constants
 */

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_CONTEXT_WINDOWS,
	FALLBACK_CONTEXT_WINDOW,
	COMBINED_CONTEXT_AGENTS,
} from '../../shared/agentConstants';
import { AGENT_IDS } from '../../shared/agentIds';

describe('agentConstants', () => {
	describe('FALLBACK_CONTEXT_WINDOW', () => {
		it('should be 200000', () => {
			expect(FALLBACK_CONTEXT_WINDOW).toBe(200000);
		});

		it('should be a positive number', () => {
			expect(FALLBACK_CONTEXT_WINDOW).toBeGreaterThan(0);
		});
	});

	describe('DEFAULT_CONTEXT_WINDOWS', () => {
		it('should have entries for active agents', () => {
			expect(DEFAULT_CONTEXT_WINDOWS['claude-code']).toBe(200000);
			expect(DEFAULT_CONTEXT_WINDOWS['codex']).toBe(200000);
			expect(DEFAULT_CONTEXT_WINDOWS['opencode']).toBe(128000);
			expect(DEFAULT_CONTEXT_WINDOWS['factory-droid']).toBe(200000);
		});

		it('should have terminal context window set to 0', () => {
			expect(DEFAULT_CONTEXT_WINDOWS['terminal']).toBe(0);
		});

		it('should only contain valid agent IDs', () => {
			for (const key of Object.keys(DEFAULT_CONTEXT_WINDOWS)) {
				expect(AGENT_IDS).toContain(key);
			}
		});

		it('should have positive values for non-terminal agents', () => {
			for (const [key, value] of Object.entries(DEFAULT_CONTEXT_WINDOWS)) {
				if (key !== 'terminal') {
					expect(value).toBeGreaterThan(0);
				}
			}
		});
	});

	describe('COMBINED_CONTEXT_AGENTS', () => {
		it('should be a ReadonlySet', () => {
			expect(COMBINED_CONTEXT_AGENTS).toBeInstanceOf(Set);
		});

		it('should contain codex (OpenAI uses combined context)', () => {
			expect(COMBINED_CONTEXT_AGENTS.has('codex')).toBe(true);
		});

		it('should not contain claude-code (Claude uses separate limits)', () => {
			expect(COMBINED_CONTEXT_AGENTS.has('claude-code')).toBe(false);
		});

		it('should only contain valid agent IDs', () => {
			for (const id of COMBINED_CONTEXT_AGENTS) {
				expect(AGENT_IDS).toContain(id);
			}
		});
	});
});
