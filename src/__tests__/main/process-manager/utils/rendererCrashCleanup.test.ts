import { describe, expect, it } from 'vitest';
import { isRetiredOnRendererCrash } from '../../../../main/process-manager/utils/rendererCrashCleanup';

describe('isRetiredOnRendererCrash', () => {
	it('stops what the crashed renderer owned', () => {
		expect(isRetiredOnRendererCrash({ sessionId: 'a1-terminal', isTerminal: true })).toBe(true);
		expect(
			isRetiredOnRendererCrash({ sessionId: 'a1-batch-1732700000000', isTerminal: false })
		).toBe(true);
		expect(
			isRetiredOnRendererCrash({ sessionId: 'a1-synopsis-1732700000000', isTerminal: false })
		).toBe(true);
	});

	it('keeps the turns restoration reattaches to and main-owned work', () => {
		expect(isRetiredOnRendererCrash({ sessionId: 'a1-ai-tab-1', isTerminal: false })).toBe(false);
		expect(
			isRetiredOnRendererCrash({ sessionId: 'a1-ai-tab-1-fp-1732700000000', isTerminal: false })
		).toBe(false);
		expect(
			isRetiredOnRendererCrash({ sessionId: 'group-chat-x-moderator', isTerminal: false })
		).toBe(false);
	});
});
