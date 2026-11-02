/**
 * @file userJourney.test.ts
 * @description `recordJourney` stamps the time and the agent's SSH remote,
 * sends without blocking, and keeps every failure (a rejected write or a
 * missing bridge) out of the UI and in Sentry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../renderer/utils/sentry', () => ({ captureException: vi.fn() }));

import { recordJourney } from '../../../renderer/services/userJourney';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { captureException } from '../../../renderer/utils/sentry';
import { createMockSession } from '../../helpers/mockSession';

const NOW = 1_700_000_000_000;
let append: ReturnType<typeof vi.fn>;

/** Let the fire-and-forget promise chain settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(Date, 'now').mockReturnValue(NOW);
	append = vi.fn().mockResolvedValue(true);
	(window as any).maestro = { ...(window as any).maestro, journey: { append } };
	useSessionStore.setState({ sessions: [] });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('recordJourney', () => {
	it('stamps ts and agentId and sends the entry', async () => {
		useSessionStore.setState({ sessions: [createMockSession({ id: 'agent-1' })] });

		const result = recordJourney('agent-1', { kind: 'file.open', target: '/p/a.ts', tabId: 't1' });
		expect(result).toBeUndefined();
		await flush();

		expect(append).toHaveBeenCalledWith({
			kind: 'file.open',
			target: '/p/a.ts',
			tabId: 't1',
			ts: NOW,
			agentId: 'agent-1',
		});
	});

	it('stamps sshRemoteId from the session, including a not-yet-spawned SSH config', async () => {
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'spawned', sshRemoteId: 'remote-a' }),
				createMockSession({
					id: 'configured',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-b' },
				} as any),
			],
		});

		recordJourney('spawned', { kind: 'file.save', target: '/p/a.ts' });
		recordJourney('configured', { kind: 'file.delete', target: '/p/b.ts' });
		await flush();

		expect(append).toHaveBeenNthCalledWith(1, expect.objectContaining({ sshRemoteId: 'remote-a' }));
		expect(append).toHaveBeenNthCalledWith(2, expect.objectContaining({ sshRemoteId: 'remote-b' }));
	});

	it('records an unknown agent without an sshRemoteId', async () => {
		recordJourney('ghost', { kind: 'browser.open', target: 'https://example.com/' });
		await flush();

		const sent = append.mock.calls[0][0];
		expect(sent.agentId).toBe('ghost');
		expect('sshRemoteId' in sent).toBe(false);
	});

	it('reports a rejected write to Sentry and never throws', async () => {
		const error = new Error('disk full');
		append.mockRejectedValueOnce(error);

		expect(() => recordJourney('agent-1', { kind: 'file.open', target: '/p/a.ts' })).not.toThrow();
		await flush();

		expect(captureException).toHaveBeenCalledWith(error, {
			extra: { operation: 'journey:append', agentId: 'agent-1', kind: 'file.open' },
		});
	});

	it('reports a missing bridge to Sentry instead of throwing into the UI', async () => {
		(window as any).maestro = { ...(window as any).maestro, journey: undefined };

		expect(() => recordJourney('agent-1', { kind: 'file.open', target: '/p/a.ts' })).not.toThrow();
		await flush();

		expect(captureException).toHaveBeenCalledTimes(1);
	});
});
