/**
 * Tests for src/renderer/services/diffReview.ts: a review left in the Git Diff
 * viewer either QUEUES into the agent's AI tab (never spawns past a busy turn)
 * or lands in that tab's composer for editing. A failed delivery says so and
 * returns false so the viewer keeps the comments.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: vi.fn(() => 'toast-id'),
}));
vi.mock('../../../renderer/stores/centerFlashStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/centerFlashStore')>()),
	notifyCenterFlash: vi.fn(),
}));
vi.mock('../../../renderer/services/crossAgentMentions', () => ({
	planCrossAgentMentions: () => null,
}));

import {
	canReceiveDiffReview,
	editDiffReviewInComposer,
	sendDiffReview,
} from '../../../renderer/services/diffReview';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useComposerInputStore } from '../../../renderer/stores/composerInputStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { notifyCenterFlash } from '../../../renderer/stores/centerFlashStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { Session } from '../../../renderer/types';

function seed(overrides: Partial<Session> = {}, activeSessionId = 'other'): void {
	const target = createMockSession({
		id: 'agent-1',
		name: 'Builder',
		aiTabs: [createMockAITab({ id: 'tab-a', name: 'Alpha', inputValue: '' })],
		unifiedTabOrder: [{ type: 'ai', id: 'tab-a' }],
		activeTabId: 'tab-a',
		executionQueue: [],
		...overrides,
	});
	const other = createMockSession({ id: 'other', name: 'Other', executionQueue: [] });
	useSessionStore.setState({ sessions: [target, other], activeSessionId });
}

const target = () => useSessionStore.getState().sessions.find((s) => s.id === 'agent-1')!;

describe('canReceiveDiffReview', () => {
	it('refuses terminal-only agents and missing ones', () => {
		expect(canReceiveDiffReview({ toolType: 'claude-code' })).toBe(true);
		expect(canReceiveDiffReview({ toolType: 'terminal' })).toBe(false);
		expect(canReceiveDiffReview(undefined)).toBe(false);
		expect(canReceiveDiffReview(null)).toBe(false);
	});
});

describe('sendDiffReview', () => {
	beforeEach(() => {
		vi.mocked(notifyToast).mockClear();
		vi.mocked(notifyCenterFlash).mockClear();
	});

	it("queues the review into the agent's AI tab and takes the user there", () => {
		seed();
		expect(sendDiffReview('agent-1', 'Fix line 2.')).toBe(true);

		const queue = target().executionQueue;
		expect(queue).toHaveLength(1);
		expect(queue[0]).toMatchObject({ type: 'message', tabId: 'tab-a', text: 'Fix line 2.' });
		expect(useSessionStore.getState().activeSessionId).toBe('agent-1');
		expect(target().activeTabId).toBe('tab-a');
		expect(notifyCenterFlash).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'Review sent to Builder', detail: undefined })
		);
	});

	it('says the review waits its turn when the agent is busy', () => {
		seed({ state: 'busy' });
		expect(sendDiffReview('agent-1', 'Fix it.')).toBe(true);
		expect(target().executionQueue).toHaveLength(1);
		expect(notifyCenterFlash).toHaveBeenCalledWith(
			expect.objectContaining({ detail: 'Queued behind the current turn' })
		);
	});

	it('keeps the comments (returns false) when the agent has no AI tab', () => {
		seed({ aiTabs: [], activeTabId: '' });
		expect(sendDiffReview('agent-1', 'Fix it.')).toBe(false);
		expect(target().executionQueue).toHaveLength(0);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'red', title: 'Review Not Sent' })
		);
	});

	it('refuses a terminal-only agent and a missing one', () => {
		seed({ toolType: 'terminal' });
		expect(sendDiffReview('agent-1', 'Fix it.')).toBe(false);
		expect(sendDiffReview('gone', 'Fix it.')).toBe(false);
		expect(target().executionQueue).toHaveLength(0);
	});

	it('does nothing for a blank prompt', () => {
		seed();
		expect(sendDiffReview('agent-1', '  ')).toBe(false);
		expect(notifyToast).not.toHaveBeenCalled();
	});
});

describe('editDiffReviewInComposer', () => {
	beforeEach(() => {
		useComposerInputStore.setState({ aiValue: '', aiValueTabId: null, aiCommandMode: 'off' });
		vi.mocked(notifyToast).mockClear();
	});

	it("switches to the agent and appends the review, unquoted, to its tab's draft", () => {
		seed({ aiTabs: [createMockAITab({ id: 'tab-a', inputValue: 'my note' })] });
		useComposerInputStore.setState({ aiValue: 'other tab text', aiValueTabId: 'tab-other' });

		expect(editDiffReviewInComposer('agent-1', '## Comment 1 of 1\n\nFix it.')).toBe(true);

		expect(useSessionStore.getState().activeSessionId).toBe('agent-1');
		const composer = useComposerInputStore.getState();
		expect(composer.aiValueTabId).toBe('tab-a');
		expect(composer.aiValue).toBe('my note\n\n## Comment 1 of 1\n\nFix it.\n\n');
		// Nothing was queued: the user sends it after editing.
		expect(target().executionQueue).toHaveLength(0);
	});

	it('refuses a terminal-only agent', () => {
		seed({ toolType: 'terminal' });
		expect(editDiffReviewInComposer('agent-1', 'Fix it.')).toBe(false);
		expect(notifyToast).toHaveBeenCalled();
	});
});
