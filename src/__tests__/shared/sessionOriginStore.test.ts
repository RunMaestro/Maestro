import { describe, it, expect } from 'vitest';
import { sessionOriginStoreFor } from '../../shared/sessionOriginStore';

describe('sessionOriginStoreFor', () => {
	it('routes Claude Code, Codex, and a missing provider to the legacy Claude store', () => {
		expect(sessionOriginStoreFor('claude-code')).toBe('claude');
		expect(sessionOriginStoreFor('codex')).toBe('claude');
		expect(sessionOriginStoreFor(undefined)).toBe('claude');
		expect(sessionOriginStoreFor(null)).toBe('claude');
		expect(sessionOriginStoreFor('')).toBe('claude');
	});

	it('routes every other provider to the generic store', () => {
		for (const toolType of ['opencode', 'factory-droid', 'copilot-cli', 'pi', 'grok']) {
			expect(sessionOriginStoreFor(toolType)).toBe('generic');
		}
	});
});
