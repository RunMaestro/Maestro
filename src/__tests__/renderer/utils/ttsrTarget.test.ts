/**
 * Phase 3b verification (pure half): the shape of the corrective turn TTSR
 * respawns after main aborted the offending one.
 */

import { describe, it, expect } from 'vitest';
import { createMockAITab, createMockSession } from '../../helpers';
import { resolveTtsrTarget } from '../../../renderer/utils/ttsrTarget';
import type { TtsrTriggeredPayload } from '../../../shared/ttsr-types';

function makePayload(overrides: Partial<TtsrTriggeredPayload> = {}): TtsrTriggeredPayload {
	return {
		sessionId: 'session-1-ai-tab-1',
		tabId: 'tab-1',
		agentId: 'claude-code',
		rules: [{ name: 'no-console-log', path: '.maestro/rules/no-console-log.md' }],
		injectionPrompt: '<system-interrupt rule="no-console-log">Use the logger.</system-interrupt>',
		requestId: 'request-1',
		...overrides,
	};
}

describe('resolveTtsrTarget', () => {
	it('finds the session and tab behind a process session id', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'session-1', aiTabs: [tab] });

		expect(resolveTtsrTarget([session], makePayload())).toEqual({ session, tab });
	});

	it('resolves a forced-parallel session id (the -fp- suffix)', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'session-1', aiTabs: [tab] });
		const payload = makePayload({ sessionId: 'session-1-ai-tab-1-fp-1717171717' });

		expect(resolveTtsrTarget([session], payload)?.tab).toBe(tab);
	});

	it('returns null when the tab is gone', () => {
		const session = createMockSession({ id: 'session-1', aiTabs: [] });
		expect(resolveTtsrTarget([session], makePayload())).toBeNull();
	});

	it('returns null for a non-AI process id', () => {
		const session = createMockSession({ id: 'session-1' });
		const payload = makePayload({ sessionId: 'session-1-terminal' });
		expect(resolveTtsrTarget([session], payload)).toBeNull();
	});
});
