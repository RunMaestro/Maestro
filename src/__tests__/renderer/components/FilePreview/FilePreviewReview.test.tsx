import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilePreview } from '../../../../renderer/components/FilePreview';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { fileReviewKey, useFileReviewStore } from '../../../../renderer/stores/fileReviewStore';
import { anchorForFileLines } from '../../../../renderer/utils/fileReviewComments';
import { mockTheme } from '../../../helpers/mockTheme';
import { createMockSession } from '../../../helpers/mockSession';
import { createMockAITab } from '../../../helpers/mockTab';

/**
 * File Preview review comments, through the REAL markdown pipeline: a
 * right-click on a rendered block offers "Comment on Line(s)" for the source
 * lines `rehypeSourceLine` stamped on it, choosing it switches to the editor,
 * and pending comments show in the shared Review tray, which sends them to the
 * agent the file tab belongs to.
 *
 * The CodeMirror editor is stood in by a textarea (jsdom cannot lay it out);
 * its inline comment slots are covered by markdownEditorCommentSlots.test.ts.
 */
vi.mock('../../../../renderer/components/FilePreview/markdownEditor', () => ({
	MarkdownEditor: React.forwardRef<unknown, { value: string; onChange: (v: string) => void }>(
		({ value, onChange }, _ref) => (
			<textarea value={value} onChange={(e) => onChange(e.target.value)} />
		)
	),
}));
vi.mock('../../../../renderer/services/crossAgentMentions', () => ({
	planCrossAgentMentions: () => null,
	queuedMentionFields: () => ({}),
}));

const DOC = '# Plan\n\nShip the parser\nthen the CLI.\n\nDone.\n';
const PATH = '/proj/docs/plan.md';
const KEY = fileReviewKey('agent-1', PATH);

const defaultProps = {
	file: { name: 'plan.md', content: DOC, path: PATH },
	onClose: vi.fn(),
	theme: mockTheme,
	markdownEditMode: false,
	setMarkdownEditMode: vi.fn(),
	shortcuts: {},
	reviewSessionId: 'agent-1',
};

const renderPreview = (props: Record<string, unknown> = {}) =>
	render(
		<LayerStackProvider>
			<FilePreview {...defaultProps} {...(props as any)} />
		</LayerStackProvider>
	);

function seed(toolType: 'claude-code' | 'terminal' = 'claude-code') {
	const agent = createMockSession({
		id: 'agent-1',
		name: 'Builder',
		cwd: '/proj',
		toolType,
		aiTabs: [createMockAITab({ id: 'tab-a', inputValue: '' })],
		unifiedTabOrder: [{ type: 'ai', id: 'tab-a' }],
		activeTabId: 'tab-a',
		executionQueue: [],
	});
	useSessionStore.setState({ sessions: [agent], activeSessionId: 'agent-1' });
}

describe('FilePreview review comments', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useFileReviewStore.setState({ commentsByKey: {}, draftsByKey: {}, discardsByKey: {} });
		seed();
	});

	it("offers a comment on a rendered block's source lines and opens the editor on them", () => {
		const setMarkdownEditMode = vi.fn();
		renderPreview({ setMarkdownEditMode });

		fireEvent.contextMenu(screen.getByText(/Ship the parser/));
		const item = screen.getByTestId('file-preview-comment-on-line');
		expect(item.textContent).toContain('Comment on Lines 3-4');

		fireEvent.click(item);
		expect(setMarkdownEditMode).toHaveBeenCalledWith(true);
	});

	it('leaves the native menu alone without an agent to send the review to', () => {
		renderPreview({ reviewSessionId: undefined });
		fireEvent.contextMenu(screen.getByText(/Ship the parser/));
		expect(screen.queryByTestId('file-preview-comment-on-line')).toBeNull();
	});

	it('offers nothing for a terminal agent, which has no conversation to review into', () => {
		seed('terminal');
		renderPreview();
		fireEvent.contextMenu(screen.getByText(/Ship the parser/));
		expect(screen.queryByTestId('file-preview-comment-on-line')).toBeNull();
	});

	it('lists pending comments in the Review tray and sends them as one queued prompt', () => {
		const anchor = anchorForFileLines({ content: DOC, path: 'docs/plan.md', startLine: 6 })!;
		useFileReviewStore.getState().addComment(KEY, { ...anchor, id: 'c1', body: 'Say when.' });
		renderPreview();

		const tray = screen.getByTestId('review-tray');
		expect(tray.textContent).toContain('Review: 1 comment');
		expect(tray.textContent).toContain('docs/plan.md:6');

		fireEvent.click(screen.getByTestId('review-send'));
		const queue = useSessionStore.getState().sessions[0].executionQueue;
		expect(queue).toHaveLength(1);
		expect(JSON.stringify(queue[0])).toContain('Say when.');
		expect(useFileReviewStore.getState().commentsByKey[KEY]).toBeUndefined();
	});

	it('marks a comment outdated once its line reads differently, and sends nothing', () => {
		const anchor = anchorForFileLines({ content: DOC, path: 'docs/plan.md', startLine: 6 })!;
		useFileReviewStore
			.getState()
			.addComment(KEY, { ...anchor, id: 'c1', body: 'x', lineContents: ['Not done.'] });
		renderPreview();

		expect(screen.getByTestId('review-outdated')).toBeTruthy();
		expect((screen.getByTestId('review-send') as HTMLButtonElement).disabled).toBe(true);
	});
});
