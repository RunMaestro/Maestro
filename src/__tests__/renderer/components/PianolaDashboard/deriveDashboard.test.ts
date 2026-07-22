/**
 * @file deriveDashboard.test.ts
 * @description Tests for the pure dashboard derivation: mapping live session
 * states + the Pianola decision log into the four status buckets.
 */

import { describe, it, expect } from 'vitest';
import { deriveDashboard } from '../../../../renderer/components/PianolaDashboard/usePianolaDashboardData';
import type { Session, SessionState } from '../../../../renderer/types';
import type { PianolaDecisionRecord } from '../../../../shared/pianola/storage';

function session(overrides: Partial<Session> & { id: string; state: SessionState }): Session {
	return {
		cwd: '',
		name: overrides.id,
		aiTabs: [],
		...overrides,
	} as Session;
}

let seq = 0;
function decision(
	agentId: string,
	topic: string,
	over: Partial<PianolaDecisionRecord> = {}
): PianolaDecisionRecord {
	seq += 1;
	return {
		id: `d${seq}`,
		timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
		tabId: `tab-${agentId}`,
		agentId,
		classification: {
			kind: 'question',
			risk: 'low',
			topic,
			confidence: 'high',
			evidence: { messageId: `m${seq}`, reason: 'asked', structured: false },
		},
		decision: { action: 'escalate', matchedRuleId: null, reason: 'no rule' },
		dispatched: false,
		dryRun: false,
		...over,
	};
}

describe('deriveDashboard', () => {
	it('lists waiting_input agents under needsInput, enriched with the latest topic', () => {
		const sessions = [session({ id: 'a', state: 'waiting_input' })];
		const decisions = [decision('a', 'pick a name')];
		const { needsInput } = deriveDashboard(sessions, decisions);
		expect(needsInput).toHaveLength(1);
		expect(needsInput[0].sessionId).toBe('a');
		expect(needsInput[0].description).toBe('pick a name');
	});

	it('falls back to a generic label when a waiting agent has no decision', () => {
		const { needsInput } = deriveDashboard([session({ id: 'a', state: 'waiting_input' })], []);
		expect(needsInput[0].description).toBe('Waiting for your input');
	});

	it('lists busy agents under working with their active tab name', () => {
		const sessions = [
			session({
				id: 'b',
				state: 'busy',
				activeTabId: 't1',
				aiTabs: [{ id: 't1', name: 'refactor parser' }] as Session['aiTabs'],
			}),
		];
		const { working } = deriveDashboard(sessions, []);
		expect(working).toHaveLength(1);
		expect(working[0].description).toBe('refactor parser');
	});

	it('lists idle agents with decision history under recentlyDone, newest first', () => {
		const sessions = [
			session({ id: 'c', state: 'idle' }),
			session({ id: 'd', state: 'idle' }),
			session({ id: 'e', state: 'idle' }), // no decisions -> excluded
		];
		const decisions = [decision('c', 'older task'), decision('d', 'newer task')];
		const { recentlyDone } = deriveDashboard(sessions, decisions);
		expect(recentlyDone.map((r) => r.sessionId)).toEqual(['d', 'c']);
		expect(recentlyDone.find((r) => r.sessionId === 'e')).toBeUndefined();
	});

	it('excludes the Pianola agent from every bucket', () => {
		const { needsInput, working, recentlyDone, activity } = deriveDashboard(
			[session({ id: 'pia', state: 'busy', isPianola: true })],
			[]
		);
		expect(needsInput).toHaveLength(0);
		expect(working).toHaveLength(0);
		expect(recentlyDone).toHaveLength(0);
		expect(activity).toHaveLength(0);
	});

	it('groups a busy worktree child under its parent in Working, even when the parent is idle', () => {
		const sessions = [
			session({ id: 'parent', state: 'idle', name: 'Parent' }),
			session({
				id: 'child',
				state: 'busy',
				parentSessionId: 'parent',
				name: 'Child',
				activeTabId: 't1',
				aiTabs: [{ id: 't1', name: 'fixing tests' }] as Session['aiTabs'],
			}),
		];
		// Parent has prior decision history, so absent the busy child it would land
		// in recentlyDone; surfacing it via the child must move it to Working only.
		const decisions = [decision('parent', 'earlier work')];
		const { working, recentlyDone } = deriveDashboard(sessions, decisions);

		expect(working).toHaveLength(1);
		expect(working[0].sessionId).toBe('parent');
		expect(working[0].worktreeChildren?.map((c) => c.sessionId)).toEqual(['child']);
		expect(working[0].worktreeChildren?.[0].description).toBe('fixing tests');
		// The busy child is not also a separate top-level row.
		expect(working.filter((r) => r.sessionId === 'child')).toHaveLength(0);
		// ...and the parent isn't double-listed in recentlyDone.
		expect(recentlyDone.find((r) => r.sessionId === 'parent')).toBeUndefined();
	});

	it('adds no Working row for a busy worktree child whose parent is absent', () => {
		const { working } = deriveDashboard(
			[session({ id: 'wt', state: 'busy', parentSessionId: 'ghost' })],
			[]
		);
		expect(working).toHaveLength(0);
	});

	it('feeds activity newest-first and splits handoffs out from escalations', () => {
		const sessions = [session({ id: 'a', state: 'idle' })];
		const decisions = [
			decision('a', 'plain escalate'),
			decision('a', 'profile call', {
				decision: {
					action: 'escalate',
					matchedRuleId: null,
					reason: 'handed off to Pianola for profile-based judgment',
				},
			}),
		];
		const { activity } = deriveDashboard(sessions, decisions);
		expect(activity[0].action).toBe('handoff'); // newest first
		expect(activity[1].action).toBe('escalate');
	});

	it('marks decisions for closed agents as non-jumpable', () => {
		const decisions = [decision('ghost', 'orphan')];
		const { activity } = deriveDashboard([], decisions);
		expect(activity[0].sessionId).toBeUndefined();
		expect(activity[0].agentName).toContain('ghost'.slice(0, 6));
	});
});
