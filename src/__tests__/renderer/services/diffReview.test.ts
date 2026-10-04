/**
 * Tests for diffReview - shipping a batch of diff annotations to the agent.
 *
 * A review is QUEUED into the agent's active AI tab, never spawned directly,
 * so it cannot interrupt a turn in progress. These tests pin the item shape
 * the queue drain relies on and the target resolution rules.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
	getPendingDiffAnnotations,
	resolveDiffReviewTarget,
	sendDiffReviewToAgent,
	setPendingDiffAnnotations,
} from '../../../renderer/services/diffReview';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession, createMockAITab } from '../../helpers';
import type { DiffAnnotation } from '../../../renderer/utils/diffAnnotations';

function seed(overrides = {}) {
	const tab = createMockAITab({ id: 'tab-1', name: 'Review me', readOnlyMode: false });
	const session = createMockSession({
		id: 'agent-1',
		name: 'Builder',
		aiTabs: [tab],
		activeTabId: 'tab-1',
		...overrides,
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: 'agent-1' });
	return session;
}

describe('resolveDiffReviewTarget', () => {
	it('prefers the agent the diff was taken for over the active one', () => {
		const a = createMockSession({ id: 'a' });
		const b = createMockSession({ id: 'b' });
		expect(resolveDiffReviewTarget([a, b], 'a', 'b')?.id).toBe('b');
		expect(resolveDiffReviewTarget([a, b], 'a', undefined)?.id).toBe('a');
	});

	it('refuses a terminal-only agent and a missing one', () => {
		const t = createMockSession({ id: 't', toolType: 'terminal' });
		expect(resolveDiffReviewTarget([t], 't')).toBeUndefined();
		expect(resolveDiffReviewTarget([], 'gone')).toBeUndefined();
	});
});

describe('sendDiffReviewToAgent', () => {
	beforeEach(() => {
		seed();
	});

	it('queues the prompt into the active AI tab', () => {
		expect(sendDiffReviewToAgent('agent-1', 'please fix')).toBe(true);
		const [item] = useSessionStore.getState().sessions[0].executionQueue;
		expect(item).toMatchObject({
			tabId: 'tab-1',
			type: 'message',
			text: 'please fix',
			tabName: 'Review me',
			readOnlyMode: false,
		});
		expect(item.turnSettings).toBeDefined();
	});

	it('appends behind work already queued', () => {
		seed({
			state: 'busy',
			executionQueue: [{ id: 'q0', timestamp: 0, tabId: 'tab-1', type: 'message', text: 'first' }],
		});
		sendDiffReviewToAgent('agent-1', 'review');
		const queue = useSessionStore.getState().sessions[0].executionQueue;
		expect(queue.map((q) => q.text)).toEqual(['first', 'review']);
	});

	it('refuses an empty prompt, a missing agent, and an agent with no AI tab', () => {
		expect(sendDiffReviewToAgent('agent-1', '  ')).toBe(false);
		expect(sendDiffReviewToAgent('nope', 'x')).toBe(false);
		seed({ aiTabs: [], activeTabId: '' });
		expect(sendDiffReviewToAgent('agent-1', 'x')).toBe(false);
		expect(useSessionStore.getState().sessions[0].executionQueue).toHaveLength(0);
	});
});

describe('pending annotations', () => {
	it('parks annotations per repo and forgets them when emptied', () => {
		const a = { id: '1', body: 'x' } as DiffAnnotation;
		setPendingDiffAnnotations('/repo', [a]);
		expect(getPendingDiffAnnotations('/repo')).toEqual([a]);
		expect(getPendingDiffAnnotations('/other')).toEqual([]);
		setPendingDiffAnnotations('/repo', []);
		expect(getPendingDiffAnnotations('/repo')).toEqual([]);
	});
});
