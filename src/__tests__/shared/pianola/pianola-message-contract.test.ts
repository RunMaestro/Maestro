/**
 * @file pianola-message-contract.test.ts
 * @description Compile-time drift guard: the WebSocket session-history message
 * shape (what `maestro-cli session show --json` returns) must remain assignable
 * to PianolaMessage, so the watcher can feed it straight into the classifier.
 * If src/main/web-server/types.ts SessionHistoryMessage drifts, this stops
 * compiling under `npm run lint`.
 */

import { describe, it, expect } from 'vitest';
import type { SessionHistoryMessage } from '../../../main/web-server/types';
import type { PianolaMessage } from '../../../shared/pianola/types';

describe('Pianola message contract', () => {
	it('accepts a SessionHistoryMessage as a PianolaMessage', () => {
		const wire: SessionHistoryMessage = {
			id: 'm1',
			role: 'assistant',
			source: 'ai',
			content: 'hi',
			timestamp: '2026-01-01T00:00:00.000Z',
		};
		// Compile-time assignability check; the runtime assertions keep vitest happy.
		const message: PianolaMessage = wire;
		expect(message.id).toBe('m1');
		expect(message.awaitingInput).toBeUndefined();
	});
});
