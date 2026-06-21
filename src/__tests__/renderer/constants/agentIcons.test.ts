/**
 * Tests for agent icon constants and lookup helpers.
 */

import { describe, expect, it } from 'vitest';
import {
	AGENT_ICONS,
	DEFAULT_AGENT_ICON,
	getAgentIcon,
	getAgentIconForToolType,
} from '../../../renderer/constants/agentIcons';

describe('agentIcons', () => {
	it('should expose icons for supported agent aliases', () => {
		expect(AGENT_ICONS['claude-code']).toBe('🤖');
		expect(AGENT_ICONS.codex).toBe('◇');
		expect(AGENT_ICONS['factory-droid']).toBe('🏭');
		expect(AGENT_ICONS.terminal).toBe('💻');
	});

	it('should return a known agent icon by id', () => {
		expect(getAgentIcon('opencode')).toBe('📟');
	});

	it('should return the default icon for unknown agent ids', () => {
		expect(getAgentIcon('unknown-agent')).toBe(DEFAULT_AGENT_ICON);
	});

	it('should return an icon for ToolType values', () => {
		expect(getAgentIconForToolType('codex')).toBe('◇');
	});
});
