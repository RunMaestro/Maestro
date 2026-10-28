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

describe('reopened native transcript ownership', () => {
	it('tags records read from the explicit provider store', async () => {
		vi.mocked(window.maestro.agentSessions.read).mockResolvedValueOnce({
			messages: [
				{
					uuid: 'native-message',
					type: 'assistant',
					content: 'native reply',
					timestamp: new Date(0).toISOString(),
				},
			],
			total: 1,
			hasMore: false,
		});
		const resumed = await loadResumableSession({
			toolType: 'codex',
			projectRoot: '/project',
			agentSessionId: 'native',
		});
		expect(resumed?.messages[0]).toMatchObject({ text: 'native reply', turnProvider: 'codex' });
	});

	it('keeps supplied historical owners through a reopen', async () => {
		const messages = [
			{
				id: 'log',
				timestamp: 1,
				source: 'user' as const,
				text: 'hello',
				turnProvider: 'opencode' as const,
			},
		];
		const resumed = await loadResumableSession({
			toolType: 'codex',
			projectRoot: '/project',
			agentSessionId: 'native',
			providedMessages: messages,
		});
		expect(resumed?.messages[0].turnProvider).toBe('opencode');
	});
});
