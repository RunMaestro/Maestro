/**
 * Tests for authOutageStore - one prompt per provider, and the resume that puts
 * every blocked agent back to work.
 *
 * Both behaviors here come from the same field report: an expired token took a
 * whole board down, and the recovery was (a) a wall of identical dialogs and
 * (b) hunting through agents for the messages that had to be re-sent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	reportAuthFailure,
	resolveAuthOutage,
	providerKeyForSession,
	useAuthOutageStore,
} from '../../../renderer/stores/authOutageStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import type { Session } from '../../../renderer/types';

const clearAgentError = vi.fn();
const replayAfterAuth = vi.fn();

vi.mock('../../../renderer/stores/agentStore', () => ({
	useAgentStore: {
		getState: () => ({ clearAgentError }),
	},
}));

vi.mock('../../../renderer/stores/retryStore', () => ({
	replayAfterAuth: (...args: unknown[]) => replayAfterAuth(...args),
}));

function seed(sessions: Session[]): void {
	useSessionStore.setState({ sessions } as never);
}

function agent(overrides: Partial<Session>): Session {
	return createMockSession({ toolType: 'claude-code', ...overrides });
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	useAuthOutageStore.setState({ outages: {} });
	seed([]);
});

describe('providerKeyForSession', () => {
	it('groups local agents of the same type together', () => {
		expect(providerKeyForSession(agent({ id: 'a' }))).toBe(
			providerKeyForSession(agent({ id: 'b' }))
		);
	});

	it('separates agents of different types', () => {
		expect(providerKeyForSession(agent({ id: 'a', toolType: 'codex' }))).not.toBe(
			providerKeyForSession(agent({ id: 'b' }))
		);
	});

	// An SSH remote has its own credential store: logging in locally does
	// nothing for it, so it must never share a prompt with the local install.
	it('separates the same agent on an SSH remote from the local one', () => {
		const remote = agent({
			id: 'r',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
		expect(providerKeyForSession(remote)).not.toBe(providerKeyForSession(agent({ id: 'l' })));
	});

	it('ignores a disabled SSH config', () => {
		const disabled = agent({
			id: 'd',
			sessionSshRemoteConfig: { enabled: false, remoteId: 'remote-1' },
		});
		expect(providerKeyForSession(disabled)).toBe(providerKeyForSession(agent({ id: 'l' })));
	});
});

describe('reportAuthFailure', () => {
	it('opens an outage for the first blocked agent', () => {
		seed([agent({ id: 'a' })]);

		const result = reportAuthFailure({ sessionId: 'a', message: 'expired', tabId: 't1' });

		expect(result.opened).toBe(true);
		expect(result.providerKey).toBe('claude-code');
	});

	// The behavior the user asked for: 30 agents, one provider, one notice.
	it('reports once for 30 agents sharing one provider, but rosters all 30', () => {
		const agents = Array.from({ length: 30 }, (_, i) => agent({ id: `a${i}` }));
		seed(agents);

		const opened = agents.filter(
			(a, i) => reportAuthFailure({ sessionId: a.id, message: 'expired', tabId: `t${i}` }).opened
		);

		expect(opened).toHaveLength(1);
		expect(useAuthOutageStore.getState().outages['claude-code'].blocked).toHaveLength(30);
	});

	it('opens a separate outage per provider', () => {
		seed([agent({ id: 'a' }), agent({ id: 'b', toolType: 'codex' })]);

		expect(reportAuthFailure({ sessionId: 'a', message: 'x' }).opened).toBe(true);
		expect(reportAuthFailure({ sessionId: 'b', message: 'x' }).opened).toBe(true);
	});

	it('records each failing tab of the same agent', () => {
		seed([agent({ id: 'a' })]);

		reportAuthFailure({ sessionId: 'a', message: 'x', tabId: 't1' });
		reportAuthFailure({ sessionId: 'a', message: 'x', tabId: 't2' });
		// A repeat of a tab already recorded must not duplicate it.
		reportAuthFailure({ sessionId: 'a', message: 'x', tabId: 't1' });

		expect(useAuthOutageStore.getState().outages['claude-code'].blocked).toEqual([
			{ sessionId: 'a', tabIds: ['t1', 't2'] },
		]);
	});

	it('keeps the first failure message rather than the latest', () => {
		seed([agent({ id: 'a' }), agent({ id: 'b' })]);

		reportAuthFailure({ sessionId: 'a', message: 'first' });
		reportAuthFailure({ sessionId: 'b', message: 'second' });

		expect(useAuthOutageStore.getState().outages['claude-code'].message).toBe('first');
	});

	it('marks the outage as pipeline-driven when any blocked agent was one', () => {
		seed([agent({ id: 'a' }), agent({ id: 'b' })]);

		reportAuthFailure({ sessionId: 'a', message: 'x' });
		reportAuthFailure({ sessionId: 'b', message: 'x', fromPipeline: true });

		expect(useAuthOutageStore.getState().outages['claude-code'].fromPipeline).toBe(true);
	});

	it('ignores an unknown agent', () => {
		expect(reportAuthFailure({ sessionId: 'gone', message: 'x' })).toEqual({
			opened: false,
			providerKey: null,
		});
		expect(useAuthOutageStore.getState().outages).toEqual({});
	});
});

describe('resolveAuthOutage', () => {
	it('clears the error and replays the failed turn for every blocked agent', () => {
		seed([agent({ id: 'a' }), agent({ id: 'b' })]);
		reportAuthFailure({ sessionId: 'a', message: 'x', tabId: 't1' });
		reportAuthFailure({ sessionId: 'b', message: 'x', tabId: 't2' });

		resolveAuthOutage('claude-code');
		// Resumes are staggered so 30 agents don't spawn in one tick.
		vi.runAllTimers();

		expect(clearAgentError).toHaveBeenCalledWith('a');
		expect(clearAgentError).toHaveBeenCalledWith('b');
		expect(replayAfterAuth).toHaveBeenCalledWith('a', ['t1']);
		expect(replayAfterAuth).toHaveBeenCalledWith('b', ['t2']);
		expect(useAuthOutageStore.getState().outages).toEqual({});
	});

	it('staggers the resumes instead of spawning everything at once', () => {
		const agents = Array.from({ length: 5 }, (_, i) => agent({ id: `a${i}` }));
		seed(agents);
		agents.forEach((a) => reportAuthFailure({ sessionId: a.id, message: 'x', tabId: 't' }));

		resolveAuthOutage('claude-code');

		// Only the first agent goes immediately.
		expect(replayAfterAuth).toHaveBeenCalledTimes(1);
		vi.runAllTimers();
		expect(replayAfterAuth).toHaveBeenCalledTimes(5);
	});

	// Dismissing is not the same as finishing the login: we must not restart
	// agents on credentials that may still be expired.
	it('restarts nothing when dismissed without resuming', () => {
		seed([agent({ id: 'a' })]);
		reportAuthFailure({ sessionId: 'a', message: 'x', tabId: 't1' });

		resolveAuthOutage('claude-code', false);
		vi.runAllTimers();

		expect(clearAgentError).not.toHaveBeenCalled();
		expect(replayAfterAuth).not.toHaveBeenCalled();
		// The outage is closed either way - the prompt is gone.
		expect(useAuthOutageStore.getState().outages).toEqual({});
	});

	it('skips an agent deleted while the prompt was open', () => {
		seed([agent({ id: 'a' }), agent({ id: 'b' })]);
		reportAuthFailure({ sessionId: 'a', message: 'x', tabId: 't1' });
		reportAuthFailure({ sessionId: 'b', message: 'x', tabId: 't2' });

		seed([agent({ id: 'a' })]);
		resolveAuthOutage('claude-code');
		vi.runAllTimers();

		expect(replayAfterAuth).toHaveBeenCalledWith('a', ['t1']);
		expect(replayAfterAuth).not.toHaveBeenCalledWith('b', expect.anything());
	});

	it('clears the error for a pipeline-only agent even with no turn to replay', () => {
		seed([agent({ id: 'a' })]);
		reportAuthFailure({ sessionId: 'a', message: 'x', fromPipeline: true });

		resolveAuthOutage('claude-code');
		vi.runAllTimers();

		expect(clearAgentError).toHaveBeenCalledWith('a');
		expect(replayAfterAuth).toHaveBeenCalledWith('a', []);
	});

	it('is a no-op for an outage that is already gone', () => {
		expect(() => resolveAuthOutage('claude-code')).not.toThrow();
		expect(replayAfterAuth).not.toHaveBeenCalled();
	});
});
