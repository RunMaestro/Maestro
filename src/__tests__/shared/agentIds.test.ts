/**
 * Tests for shared/agentIds.ts — Single Source of Truth for Agent IDs
 */

import { describe, it, expect } from 'vitest';
import { AGENT_IDS, isValidAgentId } from '../../shared/agentIds';
import type { AgentId } from '../../shared/agentIds';

describe('agentIds', () => {
	describe('AGENT_IDS', () => {
		it('should be a readonly array', () => {
			expect(Array.isArray(AGENT_IDS)).toBe(true);
			expect(AGENT_IDS.length).toBeGreaterThan(0);
		});

		it('should contain all known active agents', () => {
			expect(AGENT_IDS).toContain('claude-code');
			expect(AGENT_IDS).toContain('codex');
			expect(AGENT_IDS).toContain('opencode');
			expect(AGENT_IDS).toContain('factory-droid');
			expect(AGENT_IDS).toContain('terminal');
		});

		it('should contain placeholder agents', () => {
			expect(AGENT_IDS).toContain('gemini-cli');
			expect(AGENT_IDS).toContain('qwen3-coder');
			expect(AGENT_IDS).toContain('aider');
		});

		it('should have no duplicates', () => {
			const unique = new Set(AGENT_IDS);
			expect(unique.size).toBe(AGENT_IDS.length);
		});
	});

	describe('isValidAgentId', () => {
		it('should return true for valid agent IDs', () => {
			for (const id of AGENT_IDS) {
				expect(isValidAgentId(id)).toBe(true);
			}
		});

		it('should return false for invalid agent IDs', () => {
			expect(isValidAgentId('unknown-agent')).toBe(false);
			expect(isValidAgentId('')).toBe(false);
			expect(isValidAgentId('Claude Code')).toBe(false);
			expect(isValidAgentId('CLAUDE-CODE')).toBe(false);
		});

		it('should narrow the type to AgentId', () => {
			const id: string = 'claude-code';
			if (isValidAgentId(id)) {
				// TypeScript should accept this assignment without error
				const narrowed: AgentId = id;
				expect(narrowed).toBe('claude-code');
			}
		});
	});

	describe('AgentId type', () => {
		it('should be assignable from valid string literals', () => {
			const id: AgentId = 'claude-code';
			expect(id).toBe('claude-code');
		});
	});
});
