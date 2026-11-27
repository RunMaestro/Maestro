/**
 * Tests for src/renderer/services/diffReview.ts and the delivery it shares
 * with the File Preview review (reviewDelivery.ts): a review either QUEUES
 * into the agent's AI tab (never spawns past a busy turn) or lands in that
 * tab's composer for editing. A failed delivery says so and returns false so
 * the view keeps the comments.
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
const mockGetDiff = vi.fn(async (..._args: unknown[]) => ({ diff: '' }));
vi.mock('../../../renderer/services/git', () => ({
	gitService: { getDiff: (...args: unknown[]) => mockGetDiff(...args) },
}));

import {
	deliverDiffReview,
	runRemoteDiffReviewCommand,
} from '../../../renderer/services/diffReview';
import {
	canReceiveReview,
	editReviewPromptInComposer,
	sendReviewPrompt,
} from '../../../renderer/services/reviewDelivery';
import { diffReviewKey, useDiffReviewStore } from '../../../renderer/stores/diffReviewStore';
import { parseGitDiff } from '../../../renderer/utils/gitDiffParser';
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

describe('canReceiveReview', () => {
	it('refuses terminal-only agents and missing ones', () => {
		expect(canReceiveReview({ toolType: 'claude-code' })).toBe(true);
		expect(canReceiveReview({ toolType: 'terminal' })).toBe(false);
		expect(canReceiveReview(undefined)).toBe(false);
		expect(canReceiveReview(null)).toBe(false);
	});
});

describe('sendReviewPrompt', () => {
	beforeEach(() => {
		vi.mocked(notifyToast).mockClear();
		vi.mocked(notifyCenterFlash).mockClear();
	});

	it("queues the review into the agent's AI tab and takes the user there", () => {
		seed();
		expect(sendReviewPrompt('agent-1', 'Fix line 2.')).toBe(true);

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
		expect(sendReviewPrompt('agent-1', 'Fix it.')).toBe(true);
		expect(target().executionQueue).toHaveLength(1);
		expect(notifyCenterFlash).toHaveBeenCalledWith(
			expect.objectContaining({ detail: 'Queued behind the current turn' })
		);
	});

	it('keeps the comments (returns false) when the agent has no AI tab', () => {
		seed({ aiTabs: [], activeTabId: '' });
		expect(sendReviewPrompt('agent-1', 'Fix it.')).toBe(false);
		expect(target().executionQueue).toHaveLength(0);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'red', title: 'Review Not Sent' })
		);
	});

	it('refuses a terminal-only agent and a missing one', () => {
		seed({ toolType: 'terminal' });
		expect(sendReviewPrompt('agent-1', 'Fix it.')).toBe(false);
		expect(sendReviewPrompt('gone', 'Fix it.')).toBe(false);
		expect(target().executionQueue).toHaveLength(0);
	});

	it('does nothing for a blank prompt', () => {
		seed();
		expect(sendReviewPrompt('agent-1', '  ')).toBe(false);
		expect(notifyToast).not.toHaveBeenCalled();
	});
});

describe('editReviewPromptInComposer', () => {
	beforeEach(() => {
		useComposerInputStore.setState({ aiValue: '', aiValueTabId: null, aiCommandMode: 'off' });
		vi.mocked(notifyToast).mockClear();
	});

	it("switches to the agent and appends the review, unquoted, to its tab's draft", () => {
		seed({ aiTabs: [createMockAITab({ id: 'tab-a', inputValue: 'my note' })] });
		useComposerInputStore.setState({ aiValue: 'other tab text', aiValueTabId: 'tab-other' });

		expect(editReviewPromptInComposer('agent-1', '## Comment 1 of 1\n\nFix it.')).toBe(true);

		expect(useSessionStore.getState().activeSessionId).toBe('agent-1');
		// Written to the tab's saved draft, which the composer loads on the
		// switch; the other tab's live text is left alone.
		expect(target().aiTabs.find((t) => t.id === 'tab-a')?.inputValue).toBe(
			'my note\n\n## Comment 1 of 1\n\nFix it.\n\n'
		);
		expect(target().activeTabId).toBe('tab-a');
		expect(useComposerInputStore.getState().aiValue).toBe('other tab text');
		// Nothing was queued: the user sends it after editing.
		expect(target().executionQueue).toHaveLength(0);
	});

	it("lands in the agent's tiled group pane instead of undoing the split", () => {
		seed({
			aiTabs: [createMockAITab({ id: 'tab-a' }), createMockAITab({ id: 'tab-b' })],
			activeTabId: 'tab-a',
			activeGroupId: 'g1',
			tabGroups: [
				{
					id: 'g1',
					layout: {
						kind: 'split',
						id: 'root',
						children: [
							{ kind: 'leaf', id: 'l1', tab: { type: 'file', id: 'file-1' } },
							{ kind: 'leaf', id: 'l2', tab: { type: 'ai', id: 'tab-b' } },
						],
					},
				},
			],
		} as unknown as Partial<Session>);

		expect(editReviewPromptInComposer('agent-1', 'Fix it.')).toBe(true);

		expect(target().activeGroupId).toBe('g1');
		expect(target().activeTabId).toBe('tab-b');
		expect(target().tabGroups?.[0].focusedPaneId).toBe('l2');
		expect(target().aiTabs.find((t) => t.id === 'tab-b')?.inputValue).toBe('Fix it.\n\n');
	});

	it('refuses a terminal-only agent', () => {
		seed({ toolType: 'terminal' });
		expect(editReviewPromptInComposer('agent-1', 'Fix it.')).toBe(false);
		expect(notifyToast).toHaveBeenCalled();
	});
});

const DIFF = [
	'diff --git a/src/app.ts b/src/app.ts',
	'--- a/src/app.ts',
	'+++ b/src/app.ts',
	'@@ -1,3 +1,3 @@',
	' const keep = 1;',
	'-const old = 2;',
	'+const fresh = 3;',
	' const tail = 4;',
	'',
].join('\n');

describe('background delivery (CLI --background)', () => {
	beforeEach(() => {
		vi.mocked(notifyCenterFlash).mockClear();
	});

	it('queues the review without switching agent, tab, or flashing', () => {
		seed({}, 'other');
		expect(sendReviewPrompt('agent-1', 'Fix.', { background: true })).toBe(true);
		expect(target().executionQueue).toHaveLength(1);
		expect(useSessionStore.getState().activeSessionId).toBe('other');
		expect(notifyCenterFlash).not.toHaveBeenCalled();
	});
});

describe('deliverDiffReview', () => {
	const files = parseGitDiff(DIFF);
	const base = {
		file: 'src/app.ts',
		path: 'src/app.ts',
		side: 'new' as const,
		startLine: 2,
		endLine: 2,
		context: '@@ -1,3 +1,3 @@',
	};

	beforeEach(() => {
		useDiffReviewStore.setState({ commentsByKey: {}, draftsByKey: {} });
		seed();
	});

	it('sends current comments, leaves outdated ones pending, and forgets only what it sent', () => {
		const store = useDiffReviewStore.getState();
		store.addComment('/repo', {
			...base,
			id: 'current',
			changeKeys: ['I2'],
			lineContents: ['const fresh = 3;'],
			body: 'Rename.',
		});
		store.addComment('/repo', {
			...base,
			id: 'stale',
			changeKeys: ['I2'],
			lineContents: ['const fresher = 3;'],
			body: 'Old thought.',
		});

		const result = deliverDiffReview({
			sessionId: 'agent-1',
			key: '/repo',
			cwd: target().cwd,
			files,
			mode: 'send',
		});

		expect(result.ok).toBe(true);
		expect(target().executionQueue[0].text).toContain('Rename.');
		expect(target().executionQueue[0].text).not.toContain('Old thought.');
		expect(useDiffReviewStore.getState().commentsByKey['/repo'].map((c) => c.id)).toEqual([
			'stale',
		]);
	});

	it("names the reviewed repo when it is not the agent's working directory", () => {
		useDiffReviewStore.getState().addComment('/repo', {
			...base,
			id: 'c',
			changeKeys: ['I2'],
			lineContents: ['const fresh = 3;'],
			body: 'Rename.',
		});
		const result = deliverDiffReview({
			sessionId: 'agent-1',
			key: '/repo',
			cwd: '/somewhere/else',
			files,
			mode: 'send',
		});
		expect(result.ok && result.prompt).toContain(
			'These changes are in `/somewhere/else`, which is not your working directory.'
		);
	});

	it('says nothing about the repo when it is the working directory', () => {
		useDiffReviewStore.getState().addComment('/repo', {
			...base,
			id: 'c',
			changeKeys: ['I2'],
			lineContents: ['const fresh = 3;'],
			body: 'Rename.',
		});
		const result = deliverDiffReview({
			sessionId: 'agent-1',
			key: '/repo',
			cwd: `${target().cwd}/`,
			files,
			mode: 'send',
		});
		expect(result.ok && result.prompt).not.toContain('not your working directory');
	});

	it('refuses, and keeps everything, when every comment is outdated', () => {
		useDiffReviewStore.getState().addComment('/repo', {
			...base,
			id: 'stale',
			changeKeys: ['I9'],
			lineContents: ['x'],
			body: 'Old.',
		});
		const result = deliverDiffReview({
			sessionId: 'agent-1',
			key: '/repo',
			cwd: target().cwd,
			files,
			mode: 'send',
		});
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining('outdated') });
		expect(target().executionQueue).toHaveLength(0);
		expect(useDiffReviewStore.getState().commentsByKey['/repo']).toHaveLength(1);
	});
});

describe('runRemoteDiffReviewCommand (maestro-cli diff-review)', () => {
	const key = () => diffReviewKey(target().cwd);

	beforeEach(() => {
		useDiffReviewStore.setState({ commentsByKey: {}, draftsByKey: {} });
		seed();
		mockGetDiff.mockResolvedValue({ diff: DIFF });
	});

	it('adds a comment the viewer will draw, against the current diff', async () => {
		const result = await runRemoteDiffReviewCommand({
			action: 'add',
			sessionId: 'agent-1',
			path: 'src/app.ts',
			startLine: 2,
			endLine: 2,
			side: 'new',
			body: 'Rename.',
		});
		expect(result).toMatchObject({
			success: true,
			comment: { location: 'src/app.ts:2', outdated: false },
		});
		expect(useDiffReviewStore.getState().commentsByKey[key()]).toEqual([
			expect.objectContaining({ changeKeys: ['I2'], lineContents: ['const fresh = 3;'] }),
		]);
		// Same cwd and SSH remote the viewer is opened with.
		expect(mockGetDiff).toHaveBeenCalledWith(target().cwd, undefined, undefined);
	});

	it('refuses lines the diff does not show', async () => {
		const result = await runRemoteDiffReviewCommand({
			action: 'add',
			sessionId: 'agent-1',
			path: 'src/app.ts',
			startLine: 40,
			side: 'new',
			body: 'x',
		});
		expect(result).toMatchObject({ success: false, error: expect.stringContaining('not shown') });
	});

	it('lists, sends through the viewer path, and reports what was left behind', async () => {
		await runRemoteDiffReviewCommand({
			action: 'add',
			sessionId: 'agent-1',
			path: 'src/app.ts',
			startLine: 2,
			side: 'new',
			body: 'Rename.',
		});
		const listed = await runRemoteDiffReviewCommand({ action: 'list', sessionId: 'agent-1' });
		expect(listed.comments).toHaveLength(1);

		const sent = await runRemoteDiffReviewCommand({
			action: 'send',
			sessionId: 'agent-1',
			background: true,
		});
		expect(sent).toMatchObject({ success: true, outdated: [] });
		expect(sent.delivered).toHaveLength(1);
		expect(sent.prompt).toContain('`src/app.ts:2`');
		expect(target().executionQueue).toHaveLength(1);
		expect(useSessionStore.getState().activeSessionId).toBe('other');
		expect(useDiffReviewStore.getState().commentsByKey).toEqual({});
	});

	it('edits in place, keeping the id and lines, and refuses an outdated comment', async () => {
		await runRemoteDiffReviewCommand({
			action: 'add',
			sessionId: 'agent-1',
			path: 'src/app.ts',
			startLine: 2,
			side: 'new',
			body: 'A',
		});
		const before = useDiffReviewStore.getState().commentsByKey[key()][0];
		const edited = await runRemoteDiffReviewCommand({
			action: 'edit',
			sessionId: 'agent-1',
			commentId: before.id,
			body: 'B',
		});
		expect(edited).toMatchObject({ success: true, comment: { id: before.id, body: 'B' } });
		expect(useDiffReviewStore.getState().commentsByKey[key()]).toEqual([{ ...before, body: 'B' }]);

		mockGetDiff.mockResolvedValue({ diff: DIFF.replace('+const fresh = 3;', '+const x = 3;') });
		const refused = await runRemoteDiffReviewCommand({
			action: 'edit',
			sessionId: 'agent-1',
			commentId: before.id,
			body: 'C',
		});
		expect(refused).toMatchObject({ success: false, error: expect.stringContaining('outdated') });
	});

	it('fails an edit whose comment is removed while the diff loads', async () => {
		await runRemoteDiffReviewCommand({
			action: 'add',
			sessionId: 'agent-1',
			path: 'src/app.ts',
			startLine: 2,
			side: 'new',
			body: 'A',
		});
		const id = useDiffReviewStore.getState().commentsByKey[key()][0].id;
		mockGetDiff.mockImplementationOnce(async () => {
			// The viewer sends or removes it while git diff runs.
			useDiffReviewStore.getState().removeComment(key(), id);
			return { diff: DIFF };
		});
		const result = await runRemoteDiffReviewCommand({
			action: 'edit',
			sessionId: 'agent-1',
			commentId: id,
			body: 'B',
		});
		expect(result).toMatchObject({ success: false, error: `No pending comment ${id}` });
		expect(useDiffReviewStore.getState().commentsByKey).toEqual({});
	});

	it('removes and clears', async () => {
		await runRemoteDiffReviewCommand({
			action: 'add',
			sessionId: 'agent-1',
			path: 'src/app.ts',
			startLine: 2,
			side: 'new',
			body: 'A',
		});
		const id = useDiffReviewStore.getState().commentsByKey[key()][0].id;
		expect(
			await runRemoteDiffReviewCommand({ action: 'remove', sessionId: 'agent-1', commentId: id })
		).toMatchObject({ success: true });
		expect(
			await runRemoteDiffReviewCommand({ action: 'remove', sessionId: 'agent-1', commentId: id })
		).toMatchObject({ success: false });
		expect(await runRemoteDiffReviewCommand({ action: 'clear', sessionId: 'agent-1' })).toEqual({
			success: true,
			cwd: target().cwd,
			cleared: 0,
		});
	});

	it('refuses a terminal agent and an unknown one', async () => {
		seed({ toolType: 'terminal' });
		expect(
			(await runRemoteDiffReviewCommand({ action: 'list', sessionId: 'agent-1' })).success
		).toBe(false);
		expect((await runRemoteDiffReviewCommand({ action: 'list', sessionId: 'gone' })).success).toBe(
			false
		);
	});
});
