import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildFilePreviewCommands } from '../../../../../renderer/components/QuickActionsModal/commands/filePreviewCommands';
import { HEADING_PALETTE_EVENT } from '../../../../../renderer/services/headingPalette';
import { createMockSession } from '../../../../helpers/mockSession';
import type { FilePreviewTab, Session } from '../../../../../renderer/types';

function fileTab(overrides: Partial<FilePreviewTab> = {}): FilePreviewTab {
	return {
		id: 'tab-1',
		path: '/test/project/doc.md',
		name: 'doc',
		extension: '.md',
		content: '# Heading 1\n## Heading 2',
		scrollTop: 0,
		searchQuery: '',
		editMode: false,
		editContent: undefined,
		createdAt: 0,
		lastModified: 0,
		...overrides,
	};
}

function sessionWith(tab?: FilePreviewTab, overrides: Partial<Session> = {}): Session {
	return createMockSession({
		filePreviewTabs: tab ? [tab] : [],
		activeFileTabId: tab?.id ?? null,
		...overrides,
	});
}

function build(session: Session | undefined, setQuickActionOpen = vi.fn()) {
	return buildFilePreviewCommands({ activeSession: session, setQuickActionOpen });
}

describe('buildFilePreviewCommands', () => {
	describe('availability', () => {
		it('offers Jump to Heading for a markdown tab with headings', () => {
			const commands = build(sessionWith(fileTab()));
			expect(commands.map((c) => c.id)).toEqual(['jumpToHeading']);
			expect(commands[0].label).toBe('Jump to Heading');
		});

		it('names the file and its heading count in the subtext', () => {
			const commands = build(sessionWith(fileTab()));
			expect(commands[0].subtext).toBe('Search the 2 headings in doc.md');
		});

		it('says "heading" singular for a one-heading file', () => {
			const commands = build(sessionWith(fileTab({ content: '# Only one' })));
			expect(commands[0].subtext).toBe('Search the 1 heading in doc.md');
		});

		it('offers nothing when no agent is selected', () => {
			expect(build(undefined)).toEqual([]);
		});

		it('offers nothing when no file tab is active', () => {
			expect(build(sessionWith(undefined))).toEqual([]);
		});

		it('offers nothing for a non-markdown file', () => {
			const tab = fileTab({ name: 'index', extension: '.ts', content: '// # not a heading' });
			expect(build(sessionWith(tab))).toEqual([]);
		});

		it('offers nothing while the markdown file is being edited', () => {
			// `#` is just a character in the editor, and the palette entry must
			// appear under the same conditions as the key it mirrors.
			expect(build(sessionWith(fileTab({ editMode: true })))).toEqual([]);
		});

		it('offers nothing for a markdown file with no headings', () => {
			expect(build(sessionWith(fileTab({ content: 'Just prose.' })))).toEqual([]);
		});

		it('ignores headings inside a fenced code block', () => {
			const tab = fileTab({ content: '```\n# not a heading\n```\n' });
			expect(build(sessionWith(tab))).toEqual([]);
		});

		it('picks the ACTIVE file tab, not merely the first open one', () => {
			const other = fileTab({ id: 'tab-2', name: 'notes', content: '# A\n# B\n# C' });
			const session = createMockSession({
				filePreviewTabs: [fileTab(), other],
				activeFileTabId: 'tab-2',
			});
			expect(build(session)[0].subtext).toBe('Search the 3 headings in notes.md');
		});
	});

	describe('action', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it('closes the command palette and asks the preview to open its list', () => {
			const setQuickActionOpen = vi.fn();
			const listener = vi.fn();
			window.addEventListener(HEADING_PALETTE_EVENT, listener);

			const commands = build(sessionWith(fileTab()), setQuickActionOpen);
			commands[0].action();

			// The palette closes first; the request is deferred so the closing modal
			// finishes restoring focus before the heading palette claims it.
			expect(setQuickActionOpen).toHaveBeenCalledWith(false);
			expect(listener).not.toHaveBeenCalled();

			vi.runAllTimers();
			expect(listener).toHaveBeenCalledTimes(1);

			window.removeEventListener(HEADING_PALETTE_EVENT, listener);
		});
	});
});
