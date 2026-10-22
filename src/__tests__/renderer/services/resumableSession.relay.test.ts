import { describe, expect, it, vi } from 'vitest';
import { loadResumableSession } from '../../../renderer/services/resumableSession';

describe('reopened Relay origin', () => {
	it.each(['claude-code', 'codex', 'opencode'] as const)(
		'loads durable origin for %s even with provided messages',
		async (toolType) => {
			vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({
				'provider-session': { origin: 'relay' },
			});
			vi.mocked(window.maestro.agentSessions.getOrigins).mockResolvedValue({
				'provider-session': { origin: 'relay' },
			});
			const resumed = await loadResumableSession({
				toolType,
				projectRoot: '/project',
				agentSessionId: 'provider-session',
				providedMessages: [{ id: 'log', timestamp: 1, source: 'user', text: 'hello' }],
			});
			expect(resumed).toMatchObject({ origin: 'relay' });
		}
	);
});
