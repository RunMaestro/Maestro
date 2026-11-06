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

describe('reopened message pins', () => {
	const pin = {
		id: 'pin-1',
		logId: 'log',
		source: 'user',
		timestamp: 1,
		title: 'hello',
		excerpt: 'hello',
		pinnedAt: 2,
	};

	it.each([
		['claude-code', 'claude'],
		['codex', 'claude'],
		['opencode', 'generic'],
	] as const)('reads %s pins from the %s origins store', async (toolType, store) => {
		vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue(
			store === 'claude' ? { 'provider-session': { pinnedMessages: [pin] } } : {}
		);
		vi.mocked(window.maestro.agentSessions.getOrigins).mockResolvedValue(
			store === 'generic' ? { 'provider-session': { pinnedMessages: [pin] } } : {}
		);
		const resumed = await loadResumableSession({
			toolType,
			projectRoot: '/project',
			agentSessionId: 'provider-session',
			providedMessages: [{ id: 'log', timestamp: 1, source: 'user', text: 'hello' }],
		});
		expect(resumed?.pinnedMessages).toEqual([pin]);
	});

	it('drops malformed stored pins instead of handing them to the tab', async () => {
		vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({
			'provider-session': { pinnedMessages: [{ id: 'broken' }, 'nope'] },
		});
		const resumed = await loadResumableSession({
			toolType: 'claude-code',
			projectRoot: '/project',
			agentSessionId: 'provider-session',
			providedMessages: [{ id: 'log', timestamp: 1, source: 'user', text: 'hello' }],
		});
		expect(resumed?.pinnedMessages).toEqual([]);
	});
});
