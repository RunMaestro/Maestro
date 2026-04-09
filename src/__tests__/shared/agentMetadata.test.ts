/**
 * Tests for shared/agentMetadata.ts — Display names and classification sets
 */

import { describe, it, expect } from 'vitest';
import {
	AGENT_DISPLAY_NAMES,
	getAgentDisplayName,
	BETA_AGENTS,
	isBetaAgent,
	getReadOnlyModeLabel,
	getReadOnlyModeTooltip,
} from '../../shared/agentMetadata';
import { AGENT_IDS } from '../../shared/agentIds';
import type { AgentId } from '../../shared/agentIds';

describe('agentMetadata', () => {
	describe('AGENT_DISPLAY_NAMES', () => {
		it('should have an entry for every agent in AGENT_IDS', () => {
			for (const id of AGENT_IDS) {
				expect(AGENT_DISPLAY_NAMES[id]).toBeDefined();
				expect(typeof AGENT_DISPLAY_NAMES[id]).toBe('string');
				expect(AGENT_DISPLAY_NAMES[id].length).toBeGreaterThan(0);
			}
		});

		it('should return correct names for known agents', () => {
			expect(AGENT_DISPLAY_NAMES['claude-code']).toBe('Claude Code');
			expect(AGENT_DISPLAY_NAMES['codex']).toBe('Codex');
			expect(AGENT_DISPLAY_NAMES['opencode']).toBe('OpenCode');
			expect(AGENT_DISPLAY_NAMES['factory-droid']).toBe('Factory Droid');
			expect(AGENT_DISPLAY_NAMES['gemini-cli']).toBe('Gemini CLI');
			expect(AGENT_DISPLAY_NAMES['qwen3-coder']).toBe('Qwen3 Coder');
			expect(AGENT_DISPLAY_NAMES['aider']).toBe('Aider');
			expect(AGENT_DISPLAY_NAMES['terminal']).toBe('Terminal');
		});

		it('should not have entries for unknown agents', () => {
			// TypeScript would prevent this at compile time, but runtime check for safety
			expect((AGENT_DISPLAY_NAMES as Record<string, string>)['unknown']).toBeUndefined();
		});
	});

	describe('getAgentDisplayName', () => {
		it('should return display name for valid agent IDs', () => {
			expect(getAgentDisplayName('claude-code')).toBe('Claude Code');
			expect(getAgentDisplayName('codex')).toBe('Codex');
			expect(getAgentDisplayName('opencode')).toBe('OpenCode');
			expect(getAgentDisplayName('factory-droid')).toBe('Factory Droid');
			expect(getAgentDisplayName('terminal')).toBe('Terminal');
		});

		it('should return the raw id for unknown agents as fallback', () => {
			expect(getAgentDisplayName('unknown-agent')).toBe('unknown-agent');
			expect(getAgentDisplayName('')).toBe('');
		});

		it('should not match Object.prototype keys like toString or constructor', () => {
			expect(getAgentDisplayName('toString')).toBe('toString');
			expect(getAgentDisplayName('constructor')).toBe('constructor');
			expect(getAgentDisplayName('hasOwnProperty')).toBe('hasOwnProperty');
			expect(getAgentDisplayName('valueOf')).toBe('valueOf');
		});

		it('should work for all AGENT_IDS entries', () => {
			for (const id of AGENT_IDS) {
				const name = getAgentDisplayName(id);
				expect(name).toBe(AGENT_DISPLAY_NAMES[id]);
			}
		});
	});

	describe('BETA_AGENTS', () => {
		it('should be a ReadonlySet', () => {
			expect(BETA_AGENTS).toBeInstanceOf(Set);
		});

		it('should contain the expected beta agents', () => {
			expect(BETA_AGENTS.has('opencode')).toBe(true);
			expect(BETA_AGENTS.has('factory-droid')).toBe(true);
			expect(BETA_AGENTS.has('codex')).toBe(false);
		});

		it('should not contain non-beta agents', () => {
			expect(BETA_AGENTS.has('claude-code')).toBe(false);
			expect(BETA_AGENTS.has('terminal')).toBe(false);
			expect(BETA_AGENTS.has('gemini-cli')).toBe(false);
			expect(BETA_AGENTS.has('qwen3-coder')).toBe(false);
			expect(BETA_AGENTS.has('aider')).toBe(false);
		});

		it('should only contain valid agent IDs', () => {
			for (const id of BETA_AGENTS) {
				expect(AGENT_IDS).toContain(id);
			}
		});
	});

	describe('isBetaAgent', () => {
		it('should return true for beta agents', () => {
			expect(isBetaAgent('opencode')).toBe(true);
			expect(isBetaAgent('factory-droid')).toBe(true);
		});

		it('should return false for non-beta agents', () => {
			expect(isBetaAgent('codex')).toBe(false);
			expect(isBetaAgent('claude-code')).toBe(false);
			expect(isBetaAgent('terminal')).toBe(false);
		});

		it('should return false for unknown agents', () => {
			expect(isBetaAgent('unknown-agent')).toBe(false);
			expect(isBetaAgent('')).toBe(false);
		});

		it('should agree with BETA_AGENTS set for all known IDs', () => {
			for (const id of AGENT_IDS) {
				expect(isBetaAgent(id)).toBe(BETA_AGENTS.has(id));
			}
		});
	});

	describe('getReadOnlyModeLabel', () => {
		it('should return "Plan-Mode" for agents that use plan mode', () => {
			expect(getReadOnlyModeLabel('claude-code')).toBe('Plan-Mode');
			expect(getReadOnlyModeLabel('opencode')).toBe('Plan-Mode');
		});

		it('should return "Read-Only" for agents with true read-only enforcement', () => {
			expect(getReadOnlyModeLabel('codex')).toBe('Read-Only');
			expect(getReadOnlyModeLabel('factory-droid')).toBe('Read-Only');
		});

		it('should return "Read-Only" for unknown agents', () => {
			expect(getReadOnlyModeLabel('unknown-agent')).toBe('Read-Only');
		});
	});

	describe('getReadOnlyModeTooltip', () => {
		it('should return plan mode tooltip for plan mode agents', () => {
			expect(getReadOnlyModeTooltip('claude-code')).toContain('plan mode');
			expect(getReadOnlyModeTooltip('opencode')).toContain('plan mode');
		});

		it('should return read-only tooltip for other agents', () => {
			expect(getReadOnlyModeTooltip('codex')).toContain('Read-Only');
			expect(getReadOnlyModeTooltip('factory-droid')).toContain('Read-Only');
		});
	});
});
