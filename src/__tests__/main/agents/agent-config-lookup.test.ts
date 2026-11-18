/**
 * Tests for the agent-config reads shared by startup, the Settings setter, and
 * the outside-change reload.
 */

import { describe, expect, it } from 'vitest';
import { customPathsFromAgentConfigs } from '../../../main/agents/agent-config-lookup';

describe('customPathsFromAgentConfigs', () => {
	it('collects each provider that names a custom binary', () => {
		expect(
			customPathsFromAgentConfigs({
				'claude-code': { customPath: '/opt/claude', customArgs: '--x' },
				codex: { customPath: '/opt/codex' },
			})
		).toEqual({ 'claude-code': '/opt/claude', codex: '/opt/codex' });
	});

	it('skips providers with no path, an empty path, or a value that is not a string', () => {
		expect(
			customPathsFromAgentConfigs({
				'claude-code': { customArgs: '--x' },
				codex: { customPath: '' },
				pi: { customPath: 42 },
				opencode: null,
			})
		).toEqual({});
	});
});
