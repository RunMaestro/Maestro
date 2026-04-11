/**
 * Tests for shared/agentMetadata.ts — Display names and classification sets
 */

import { describe, it, expect } from 'vitest';
import {
	getAgentDisplayName,
	isBetaAgent,
	getReadOnlyModeLabel,
	getReadOnlyModeTooltip,
} from '../../shared/agentMetadata';
import { AGENT_IDS } from '../../shared/agentIds';

describe('agentMetadata', () => {
	describe('getAgentDisplayName', () => {
		it('should return a non-empty display name for every agent in AGENT_IDS', () => {
			for (const id of AGENT_IDS) {
				const name = getAgentDisplayName(id);
				expect(typeof name).toBe('string');
				expect(name.length).toBeGreaterThan(0);
			}
		});

		it('should return display name for valid agent IDs', () => {
			expect(getAgentDisplayName('claude-code')).toBe('Claude Code');
			expect(getAgentDisplayName('codex')).toBe('Codex');
			expect(getAgentDisplayName('opencode')).toBe('OpenCode');
			expect(getAgentDisplayName('factory-droid')).toBe('Factory Droid');
			expect(getAgentDisplayName('gemini-cli')).toBe('Gemini CLI');
			expect(getAgentDisplayName('qwen3-coder')).toBe('Qwen3 Coder');
			expect(getAgentDisplayName('aider')).toBe('Aider');
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
	});

	describe('isBetaAgent', () => {
		it('should return true for beta agents', () => {
			expect(isBetaAgent('opencode')).toBe(true);
			expect(isBetaAgent('factory-droid')).toBe(true);
		});

		it('should return false for non-beta agents', () => {
			expect(isBetaAgent('claude-code')).toBe(false);
			expect(isBetaAgent('codex')).toBe(false);
			expect(isBetaAgent('terminal')).toBe(false);
			expect(isBetaAgent('gemini-cli')).toBe(false);
			expect(isBetaAgent('qwen3-coder')).toBe(false);
			expect(isBetaAgent('aider')).toBe(false);
		});

		it('should return false for unknown agents', () => {
			expect(isBetaAgent('unknown-agent')).toBe(false);
			expect(isBetaAgent('')).toBe(false);
		});

		it('should produce a stable boolean for every known AGENT_ID', () => {
			for (const id of AGENT_IDS) {
				expect(typeof isBetaAgent(id)).toBe('boolean');
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
