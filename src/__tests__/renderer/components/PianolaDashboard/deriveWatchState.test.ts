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

	it('offers top-level agents with an AI tab, excluding Pianola, children, and already-watched', () => {
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
		expect(watchable.map((w) => w.agentId)).toEqual(['a']);
		expect(watchable[0]).toMatchObject({ agentId: 'a', tabId: 'a1', agentName: 'A' });
	});

	it('targets the active AI tab when set, else the first AI tab', () => {
		const withActive = [
			session({
				id: 'a',
				aiTabs: [
					{ id: 'a1', name: 'x' },
					{ id: 'a2', name: 'y' },
				] as Session['aiTabs'],
				activeTabId: 'a2',
			}),
		];
		expect(deriveWatchState(withActive, [], []).watchable[0].tabId).toBe('a2');
		// activeTabId points at a non-AI (file/terminal) tab: fall back to the first AI tab.
		const nonAiActive = [
			session({
				id: 'b',
				aiTabs: [
					{ id: 'b1', name: 'x' },
					{ id: 'b2', name: 'y' },
				] as Session['aiTabs'],
				activeTabId: 'file-xyz',
			}),
		];
		expect(deriveWatchState(nonAiActive, [], []).watchable[0].tabId).toBe('b1');
	});
});
