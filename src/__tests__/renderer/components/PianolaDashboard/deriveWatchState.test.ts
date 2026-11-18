/**
 * @file deriveWatchState.test.ts
 * @description Tests for the pure watch-state derivation: mapping live sessions
 * + the supervisor snapshot into watched rows and the "watchable" picker list.
 */

import { describe, it, expect } from 'vitest';
import { deriveWatchState } from '../../../../renderer/components/PianolaDashboard/usePianolaSupervisor';
import type { Session, SessionState } from '../../../../renderer/types';
import type { PianolaSupervisedTarget } from '../../../../shared/pianola/storage';
import type { PianolaSupervisorHealth } from '../../../../main/pianola/pianola-supervisor';

function session(o: Partial<Session> & { id: string }): Session {
	return {
		cwd: '',
		name: o.id,
		state: 'idle' as SessionState,
		aiTabs: [],
		activeTabId: '',
		...o,
	} as Session;
}

function target(o: Partial<PianolaSupervisedTarget> & { id: string }): PianolaSupervisedTarget {
	return { kind: 'watch', enabled: true, createdAt: 0, ...o } as PianolaSupervisedTarget;
}

function health(o: Partial<PianolaSupervisorHealth> & { id: string }): PianolaSupervisorHealth {
	return {
		kind: 'watch',
		state: 'running',
		restarts: 0,
		recentLogs: [],
		...o,
	} as PianolaSupervisorHealth;
}

describe('deriveWatchState', () => {
	it('lists watch targets enriched with name, enabled, and live health', () => {
		const sessions = [session({ id: 'a', name: 'Backend' })];
		const targets = [target({ id: 't1', agentId: 'a', tabId: 'tab1', enabled: true })];
		const { watched } = deriveWatchState(sessions, targets, [
			health({ id: 't1', state: 'running' }),
		]);
		expect(watched).toHaveLength(1);
		expect(watched[0]).toMatchObject({
			targetId: 't1',
			agentId: 'a',
			agentName: 'Backend',
			enabled: true,
			state: 'running',
		});
	});

	it('falls back to a short id when the watched agent is no longer loaded', () => {
		const targets = [target({ id: 't1', agentId: 'abcdef123456', tabId: 'x' })];
		const { watched } = deriveWatchState([], targets, []);
		expect(watched[0].agentName).toBe('abcdef');
	});

	it('surfaces the daemon lastError on a failed target', () => {
		const targets = [target({ id: 't1', agentId: 'a', tabId: 'x' })];
		const healths = [health({ id: 't1', state: 'failed', lastError: 'boom' })];
		const { watched } = deriveWatchState([session({ id: 'a' })], targets, healths);
		expect(watched[0].state).toBe('failed');
		expect(watched[0].lastError).toBe('boom');
	});

	it('ignores non-watch (orchestrate) targets', () => {
		const targets = [target({ id: 't1', kind: 'orchestrate', planId: 'p1', agentId: undefined })];
		expect(deriveWatchState([], targets, []).watched).toHaveLength(0);
	});

	it('offers top-level agents including legacy watches and agents without a chat', () => {
		const sessions = [
			session({
				id: 'a',
				name: 'A',
				aiTabs: [{ id: 'a1', name: 'x' }] as Session['aiTabs'],
				activeTabId: 'a1',
			}),
			session({
				id: 'watched',
				name: 'W',
				aiTabs: [{ id: 'w1', name: 'x' }] as Session['aiTabs'],
				activeTabId: 'w1',
			}),
			session({
				id: 'pia',
				isPianola: true,
				aiTabs: [{ id: 'p1', name: 'x' }] as Session['aiTabs'],
				activeTabId: 'p1',
			}),
			session({
				id: 'child',
				parentSessionId: 'a',
				aiTabs: [{ id: 'c1', name: 'x' }] as Session['aiTabs'],
				activeTabId: 'c1',
			}),
			session({ id: 'notab', name: 'NoTab', aiTabs: [] }),
		];
		const targets = [target({ id: 't1', agentId: 'watched', tabId: 'w1' })];
		const { watchable } = deriveWatchState(sessions, targets, []);
		expect(watchable.map((w) => w.agentId)).toEqual(['a', 'watched', 'notab']);
		expect(watchable[0]).toEqual({ agentId: 'a', agentName: 'A' });
	});

	it('does not offer selected, excluded, or group-covered agents even when the scope is paused', () => {
		const sessions = [
			session({ id: 'a' }),
			session({ id: 'b', groupId: 'group' }),
			session({ id: 'c' }),
			session({ id: 'other' }),
		];
		const targets = [
			target({
				id: 'scope',
				kind: 'watch-scope',
				enabled: false,
				selection: {
					mode: 'agents-and-groups',
					label: 'Paused',
					agentIds: ['a'],
					groupIds: ['group'],
					excludedAgentIds: ['c'],
				},
			}),
		];
		expect(deriveWatchState(sessions, targets, []).watchable).toEqual([
			{ agentId: 'other', agentName: 'other' },
		]);
	});
});
