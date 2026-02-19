import { describe, it, expect } from 'vitest';
import { getAiProcessContext } from '../processEventRouting';

describe('getAiProcessContext', () => {
	it('returns AI tab routing details', () => {
		expect(getAiProcessContext('session-123-ai-tab-main')).toEqual({
			actualSessionId: 'session-123',
			tabId: 'tab-main',
		});
	});

	it('returns legacy AI routing details without tab id', () => {
		expect(getAiProcessContext('session-123-ai')).toEqual({
			actualSessionId: 'session-123',
			tabId: undefined,
		});
	});

	it('ignores terminal tab PTY session ids', () => {
		expect(getAiProcessContext('session-123-terminal-tab-main')).toBeNull();
	});

	it('ignores plain runCommand session ids', () => {
		expect(getAiProcessContext('session-123')).toBeNull();
	});

	it('ignores batch and synopsis session ids', () => {
		expect(getAiProcessContext('session-123-batch-1704067200000')).toBeNull();
		expect(getAiProcessContext('session-123-synopsis-1704067200000')).toBeNull();
	});
});
