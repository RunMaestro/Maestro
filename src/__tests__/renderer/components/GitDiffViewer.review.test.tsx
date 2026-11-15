/**
 * Review comments in the Git Diff viewer (issue #1475), driven through the REAL
 * diff parser and renderer: pick lines with the mouse or keyboard, write a
 * comment, collect several across files, and send them as one review.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';

// The REAL delivery service runs (outdated filtering, formatting, clearing);
// only its leaves are stubbed: the queue write, the composer, and navigation.
const mockSendDiffReview = vi.fn((_sessionId: string, _prompt: string) => true);
const mockEditInComposer = vi.fn((_sessionId: string, _prompt: string) => true);
vi.mock('../../../renderer/services/queuedPrompt', () => ({
	enqueuePromptForTab: ({ sessionId, text }: { sessionId: string; text: string }) =>
		mockSendDiffReview(sessionId, text) ? { tabId: 'tab-a' } : null,
}));
vi.mock('../../../renderer/services/quoteIntoComposer', () => ({
	resolveComposerTarget: () => ({ tabId: 'tab-a', inGroup: false }),
	insertIntoAgentComposer: (sessionId: string, prompt: string) =>
		mockEditInComposer(sessionId, prompt) ? 'tab-a' : null,
}));
vi.mock('../../../renderer/services/agentNavigation', () => ({ jumpToAgent: vi.fn() }));

let escapeHandler: (() => void) | null = null;
vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: (layer: { onEscape: () => void }) => {
			escapeHandler = layer.onEscape;
			return 'layer-1';
		},
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));
vi.mock('react-diff-view/style/index.css', () => ({}));

import { GitDiffViewer } from '../../../renderer/components/GitDiffViewer';
import { useDiffReviewStore } from '../../../renderer/stores/diffReviewStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';

const DIFF = [
	'diff --git a/src/app.ts b/src/app.ts',
	'index 1111111..2222222 100644',
	'--- a/src/app.ts',
	'+++ b/src/app.ts',
	'@@ -1,4 +1,5 @@',
	' const keep = 1;',
	'-const old = 2;',
	'+const fresh = 3;',
	'+const extra = 4;',
	' const tail = 5;',
	' const end = 6;',
	'diff --git a/src/util.ts b/src/util.ts',
	'index 3333333..4444444 100644',
	'--- a/src/util.ts',
	'+++ b/src/util.ts',
	'@@ -1,2 +1,2 @@',
	' export const a = 1;',
	'-export const b = 2;',
	'+export const b = 3;',
	'',
].join('\n');

const CWD = '/repo';

function renderViewer(props: Partial<Parameters<typeof GitDiffViewer>[0]> = {}) {
	const onClose = vi.fn();
	const utils = render(
		<GitDiffViewer
			diffText={DIFF}
			cwd={CWD}
			theme={mockTheme}
			onClose={onClose}
			sessionId="agent-1"
			enableReview
			{...props}
		/>
	);
	return { ...utils, onClose };
}

/** The line-number cell of the row whose code is `code`. */
function gutterFor(code: string): HTMLElement {
	const row = screen.getByText(code).closest('tr');
	const gutter = row?.querySelector('td.diff-gutter:not(.diff-gutter-omit)');
	if (!gutter) throw new Error(`no gutter for ${code}`);
	return gutter as HTMLElement;
}

function pickLines(from: string, to: string = from) {
	fireEvent.mouseDown(gutterFor(from), { button: 0 });
	if (to !== from) fireEvent.mouseEnter(gutterFor(to));
	fireEvent.mouseUp(window);
}

function writeComment(body: string) {
	fireEvent.change(screen.getByRole('textbox'), { target: { value: body } });
	fireEvent.click(screen.getByTestId('diff-comment-save'));
}

function key(k: string, init: KeyboardEventInit = {}) {
	act(() => {
		window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
	});
}

describe('GitDiffViewer review comments', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		escapeHandler = null;
		useDiffReviewStore.setState({ commentsByRepo: {}, draftsByRepo: {}, discardsByRepo: {} });
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'agent-1', name: 'Builder' })],
			activeSessionId: 'agent-1',
		});
	});

	it('comments on a dragged range of lines and pins it to path:start-end', () => {
		renderViewer();
		pickLines('const fresh = 3;', 'const extra = 4;');
		expect(screen.getByTestId('diff-comment-editor')).toHaveTextContent(
			'Comment on src/app.ts:2-3'
		);
		writeComment('Merge these two.');

		const card = screen.getByTestId('diff-comment-card');
		expect(card).toHaveTextContent('src/app.ts:2-3');
		expect(card).toHaveTextContent('Merge these two.');
		const tray = screen.getByTestId('diff-review-tray');
		expect(tray).toHaveTextContent('Review: 1 comment');
		expect(tray).toHaveTextContent('Send Review to Builder');
	});

	it('marks a comment on a removed line as the previous version', () => {
		renderViewer();
		pickLines('const old = 2;');
		writeComment('Why remove this?');
		expect(screen.getByTestId('diff-comment-card')).toHaveTextContent(
			'src/app.ts:2 (previous version)'
		);
	});

	it('keeps comments across file tabs and sends every one as one review', () => {
		const { onClose } = renderViewer();
		pickLines('const fresh = 3;');
		writeComment('Rename.');

		fireEvent.click(screen.getByRole('button', { name: /^util\.ts/ }));
		pickLines('export const b = 3;');
		writeComment('Keep it 2.');

		fireEvent.click(screen.getByRole('button', { name: /^app\.ts/ }));
		expect(screen.getByTestId('diff-comment-card')).toHaveTextContent('Rename.');
		expect(screen.getByTestId('diff-review-tray')).toHaveTextContent('Review: 2 comments');

		fireEvent.click(screen.getByTestId('diff-review-send'));
		expect(mockSendDiffReview).toHaveBeenCalledTimes(1);
		const [sessionId, prompt] = mockSendDiffReview.mock.calls[0];
		expect(sessionId).toBe('agent-1');
		expect(prompt).toContain('left 2 comments pinned to specific lines');
		expect(prompt).toContain('`src/app.ts:2`\n```diff\n@@ -1,4 +1,5 @@');
		expect(prompt).toContain('+const fresh = 3;');
		expect(prompt).toContain('`src/util.ts:2`');
		expect(prompt.indexOf('Rename.')).toBeLessThan(prompt.indexOf('Keep it 2.'));
		expect(onClose).toHaveBeenCalled();
		expect(useDiffReviewStore.getState().commentsByRepo).toEqual({});
	});

	it('keeps an unsaved draft when the user switches file tabs and back', () => {
		renderViewer();
		pickLines('const fresh = 3;');
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Half a thought' } });
		fireEvent.click(screen.getByRole('button', { name: /^util\.ts/ }));
		expect(screen.queryByTestId('diff-comment-editor')).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /^app\.ts/ }));
		expect(screen.getByRole('textbox')).toHaveValue('Half a thought');
	});

	it('Shift+click on a line number extends the open comment box into a range, text and all', () => {
		renderViewer();
		pickLines('const fresh = 3;');
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Started typing' } });
		fireEvent.mouseDown(gutterFor('const tail = 5;'), { button: 0, shiftKey: true });
		fireEvent.mouseUp(window);
		expect(screen.getByTestId('diff-comment-editor')).toHaveTextContent(
			'Comment on src/app.ts:2-4'
		);
		expect(screen.getByRole('textbox')).toHaveValue('Started typing');
	});

	it('will not throw away an unsaved edit to a saved comment', () => {
		renderViewer();
		pickLines('const fresh = 3;');
		writeComment('Rename.');
		fireEvent.click(screen.getByRole('button', { name: 'Edit comment on src/app.ts:2' }));
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Rename to fresher.' } });
		pickLines('const tail = 5;');
		// Still editing the saved comment; no new box opened over it.
		expect(screen.getByTestId('diff-comment-editor')).toHaveTextContent(
			'Edit comment on src/app.ts:2'
		);
		expect(screen.getByRole('textbox')).toHaveValue('Rename to fresher.');
	});

	it('saves a comment still being typed before Shift+Cmd+Enter sends the review', () => {
		renderViewer();
		pickLines('const fresh = 3;');
		const box = screen.getByRole('textbox');
		fireEvent.change(box, { target: { value: 'Typed but not saved.' } });
		act(() => {
			box.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, shiftKey: true, bubbles: true })
			);
		});
		expect(mockSendDiffReview).toHaveBeenCalledWith(
			'agent-1',
			expect.stringContaining('Typed but not saved.')
		);
	});

	it('keeps the review when delivery fails', () => {
		mockSendDiffReview.mockReturnValueOnce(false);
		const { onClose } = renderViewer();
		pickLines('const fresh = 3;');
		writeComment('Rename.');
		fireEvent.click(screen.getByTestId('diff-review-send'));
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByTestId('diff-review-tray')).toHaveTextContent('Review: 1 comment');
	});

	it('hands the review to the composer for editing', () => {
		renderViewer();
		pickLines('const fresh = 3;');
		writeComment('Rename.');
		fireEvent.click(screen.getByTestId('diff-review-edit-in-composer'));
		expect(mockEditInComposer).toHaveBeenCalledWith('agent-1', expect.stringContaining('Rename.'));
		expect(mockSendDiffReview).not.toHaveBeenCalled();
	});

	it('survives closing and reopening the viewer for the same repo', () => {
		const first = renderViewer();
		pickLines('const fresh = 3;');
		writeComment('Rename.');
		first.unmount();

		renderViewer();
		expect(screen.getByTestId('diff-comment-card')).toHaveTextContent('Rename.');
	});

	it('is reachable from the keyboard: arrows, Shift+arrows, C, Cmd+Enter, Shift+Cmd+Enter', () => {
		renderViewer();
		key('ArrowDown'); // lands on the first changed line: the removal
		key('ArrowDown', { shiftKey: true });
		key('ArrowDown', { shiftKey: true });
		key('c');
		const editor = screen.getByTestId('diff-comment-editor');
		expect(editor).toHaveTextContent('Comment on src/app.ts:2-3');

		const box = within(editor).getByRole('textbox');
		fireEvent.change(box, { target: { value: 'Simplify.' } });
		fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
		expect(screen.getByTestId('diff-comment-card')).toHaveTextContent('Simplify.');

		key('Enter', { metaKey: true, shiftKey: true });
		expect(mockSendDiffReview).toHaveBeenCalledWith(
			'agent-1',
			expect.stringContaining('Simplify.')
		);
	});

	it('peels Escape one layer at a time: comment box, then selection, then the viewer', () => {
		const { onClose } = renderViewer();
		pickLines('const fresh = 3;');
		act(() => escapeHandler?.());
		expect(screen.queryByTestId('diff-comment-editor')).not.toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();

		key('ArrowDown');
		act(() => escapeHandler?.());
		expect(onClose).not.toHaveBeenCalled();

		act(() => escapeHandler?.());
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('asks twice before discarding the review', () => {
		renderViewer();
		pickLines('const fresh = 3;');
		writeComment('Rename.');
		fireEvent.click(screen.getByTestId('diff-review-discard'));
		expect(screen.getByTestId('diff-review-discard')).toHaveTextContent('Discard 1 comment?');
		fireEvent.click(screen.getByTestId('diff-review-discard'));
		expect(screen.queryByTestId('diff-review-tray')).not.toBeInTheDocument();
	});

	it('offers nothing when review is off', () => {
		renderViewer({ enableReview: false });
		fireEvent.mouseDown(gutterFor('const fresh = 3;'), { button: 0 });
		fireEvent.mouseUp(window);
		key('ArrowDown');
		key('c');
		expect(screen.queryByTestId('diff-comment-editor')).not.toBeInTheDocument();
	});

	describe('after review feedback (Greptile, CodeRabbit)', () => {
		const MOVED_DIFF = DIFF.replace('+const fresh = 3;', '+const fresher = 3;');
		const RENAME_DIFF = [
			'diff --git a/src/old-name.ts b/src/new-name.ts',
			'similarity index 80%',
			'rename from src/old-name.ts',
			'rename to src/new-name.ts',
			'--- a/src/old-name.ts',
			'+++ b/src/new-name.ts',
			'@@ -7,2 +7,2 @@',
			' const keep = 7;',
			'-const gone = 8;',
			'+const kept = 8;',
			'',
		].join('\n');

		it('flags a comment whose lines changed as outdated, and never sends it', () => {
			const { rerender, onClose } = renderViewer();
			pickLines('const fresh = 3;');
			writeComment('Rename.');
			pickLines('const tail = 5;');
			writeComment('Still here.');

			rerender(
				<GitDiffViewer
					diffText={MOVED_DIFF}
					cwd={CWD}
					theme={mockTheme}
					onClose={onClose}
					sessionId="agent-1"
					enableReview
				/>
			);

			const tray = screen.getByTestId('diff-review-tray');
			expect(tray).toHaveTextContent('Review: 2 comments · 1 outdated, not sent');
			expect(screen.getByTestId('diff-review-outdated')).toHaveTextContent('src/app.ts:2');
			// Only the still-current comment is drawn on a line.
			expect(screen.getAllByTestId('diff-comment-card')).toHaveLength(1);

			fireEvent.click(screen.getByTestId('diff-review-send'));
			const prompt = mockSendDiffReview.mock.calls[0][1];
			expect(prompt).toContain('Still here.');
			expect(prompt).not.toContain('Rename.');
			// The outdated comment is left for the user to remove or redo.
			expect(Object.values(useDiffReviewStore.getState().commentsByRepo).flat()).toEqual([
				expect.objectContaining({ body: 'Rename.' }),
			]);
		});

		it('disables sending when every comment is outdated', () => {
			const { rerender, onClose } = renderViewer();
			pickLines('const fresh = 3;');
			writeComment('Rename.');
			rerender(
				<GitDiffViewer
					diffText={MOVED_DIFF}
					cwd={CWD}
					theme={mockTheme}
					onClose={onClose}
					sessionId="agent-1"
					enableReview
				/>
			);
			expect(screen.getByTestId('diff-review-send')).toBeDisabled();
			expect(screen.getByTestId('diff-review-edit-in-composer')).toBeDisabled();
			key('Enter', { metaKey: true, shiftKey: true });
			expect(mockSendDiffReview).not.toHaveBeenCalled();
		});

		it("names a renamed file's previous path for a removed line", () => {
			renderViewer({ diffText: RENAME_DIFF });
			pickLines('const gone = 8;');
			writeComment('Why drop this?');
			expect(screen.getByTestId('diff-comment-card')).toHaveTextContent(
				'src/old-name.ts:8 (previous version)'
			);
			fireEvent.click(screen.getByTestId('diff-review-send'));
			expect(mockSendDiffReview.mock.calls[0][1]).toContain('`src/old-name.ts:8`');
		});

		it('keeps the same path on two SSH hosts as two reviews', () => {
			useSessionStore.setState({
				sessions: [
					createMockSession({ id: 'agent-1', name: 'Builder', sshRemoteId: 'host-a' }),
					createMockSession({ id: 'agent-2', name: 'Other', sshRemoteId: 'host-b' }),
				],
				activeSessionId: 'agent-1',
			});
			const first = renderViewer();
			pickLines('const fresh = 3;');
			writeComment('On host A.');
			first.unmount();

			renderViewer({ sessionId: 'agent-2' });
			expect(screen.queryByTestId('diff-review-tray')).not.toBeInTheDocument();
		});

		it('keeps an edit whose comment was removed underneath it (CLI remove)', () => {
			renderViewer();
			pickLines('const fresh = 3;');
			writeComment('Rename.');
			fireEvent.click(screen.getByRole('button', { name: 'Edit comment on src/app.ts:2' }));
			act(() => {
				const { commentsByRepo, removeComment } = useDiffReviewStore.getState();
				removeComment(CWD, commentsByRepo[CWD][0].id);
			});
			fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Rename to fresher.' } });
			fireEvent.click(screen.getByTestId('diff-comment-save'));
			expect(useDiffReviewStore.getState().commentsByRepo[CWD]).toEqual([
				expect.objectContaining({ body: 'Rename to fresher.', path: 'src/app.ts' }),
			]);
		});

		it('keeps a half-written comment box across closing and reopening the viewer', () => {
			const first = renderViewer();
			pickLines('const fresh = 3;', 'const extra = 4;');
			fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Half a thought' } });
			first.unmount();

			renderViewer();
			const editor = screen.getByTestId('diff-comment-editor');
			expect(editor).toHaveTextContent('Comment on src/app.ts:2-3');
			expect(within(editor).getByRole('textbox')).toHaveValue('Half a thought');
		});

		it('a discard from the CLI closes the open box, which is then not parked', () => {
			const first = renderViewer();
			pickLines('const fresh = 3;');
			writeComment('Saved.');
			pickLines('const tail = 5;');
			fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Unsaved' } });

			act(() => useDiffReviewStore.getState().clearComments(CWD));
			expect(screen.queryByTestId('diff-comment-editor')).not.toBeInTheDocument();

			first.unmount();
			renderViewer();
			expect(screen.queryByTestId('diff-comment-editor')).not.toBeInTheDocument();
			expect(useDiffReviewStore.getState().draftsByRepo).toEqual({});
		});

		it('reopens on the file tab the unfinished comment box is on', () => {
			const first = renderViewer();
			fireEvent.click(screen.getByRole('button', { name: /^util\.ts/ }));
			pickLines('export const b = 3;');
			fireEvent.change(screen.getByRole('textbox'), { target: { value: 'On the second file' } });
			first.unmount();

			renderViewer();
			const editor = screen.getByTestId('diff-comment-editor');
			expect(editor).toHaveTextContent('Comment on src/util.ts:2');
			expect(within(editor).getByRole('textbox')).toHaveValue('On the second file');
		});

		it('keeps the text as an outdated comment when its lines changed while closed', () => {
			const first = renderViewer();
			pickLines('const fresh = 3;');
			fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Half a thought' } });
			first.unmount();

			renderViewer({ diffText: MOVED_DIFF });
			expect(screen.queryByTestId('diff-comment-editor')).not.toBeInTheDocument();
			expect(screen.getByTestId('diff-review-outdated')).toHaveTextContent('Half a thought');
		});

		it('does not park a box that Send already saved and delivered', () => {
			const first = renderViewer();
			pickLines('const fresh = 3;');
			fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ship it' } });
			key('Enter', { metaKey: true, shiftKey: true });
			first.unmount();
			renderViewer();
			expect(screen.queryByTestId('diff-comment-editor')).not.toBeInTheDocument();
			expect(useDiffReviewStore.getState().draftsByRepo).toEqual({});
		});

		it('drops an open comment box when the viewer is pointed at another repo', () => {
			const { rerender, onClose } = renderViewer();
			pickLines('const fresh = 3;');
			fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Half done' } });
			rerender(
				<GitDiffViewer
					diffText={DIFF}
					cwd="/other-repo"
					theme={mockTheme}
					onClose={onClose}
					sessionId="agent-1"
					enableReview
				/>
			);
			expect(screen.queryByTestId('diff-comment-editor')).not.toBeInTheDocument();
			expect(useDiffReviewStore.getState().commentsByRepo).toEqual({});
			// Parked under the repo it was written in, not lost and not carried over.
			expect(useDiffReviewStore.getState().draftsByRepo[CWD]?.body).toBe('Half done');
		});
	});
});
