/**
 * The file preview header at phone width: the toolbar collapses to one "..."
 * that opens `FilePreviewActionsSheet`, and the path line and stats subbar move
 * into it.
 *
 * What these pin down is the INVARIANT the split exists for - the sheet and the
 * toolbar render one list, so a `toolbarVisibility` key the user switched off in
 * Settings must be missing from BOTH. A sheet that quietly restored a hidden
 * button would be the one way this refactor could hand the user back something
 * they went to Settings to remove.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { mockTheme } from '../../../helpers/mockTheme';
import type { FilePreviewToolbarVisibility } from '../../../../renderer/stores/settingsStore';
import { FILE_PREVIEW_TOOLBAR_BUTTON_KEYS } from '../../../../renderer/stores/settingsStore';

vi.mock('../../../../renderer/hooks/ui/useViewportBreakpoint', () => ({
	usePhoneLayout: vi.fn(() => false),
	useViewportBreakpoint: vi.fn(() => 'lg'),
}));

import { usePhoneLayout } from '../../../../renderer/hooks/ui/useViewportBreakpoint';
import { FilePreviewHeader } from '../../../../renderer/components/FilePreview/FilePreviewHeader';

const mockedUsePhoneLayout = vi.mocked(usePhoneLayout);

const allVisible = Object.fromEntries(
	FILE_PREVIEW_TOOLBAR_BUTTON_KEYS.map((key) => [key, true])
) as FilePreviewToolbarVisibility;

function renderHeader(overrides: Record<string, unknown> = {}) {
	const props = {
		file: {
			name: 'MEET-07-30.md',
			content: 'line one\nline two\n',
			path: '/Users/pedram/Pedsidian/Meetings/MEET-07-30.md',
		},
		theme: mockTheme,
		isMarkdown: true,
		isImage: false,
		isEditableText: true,
		markdownEditMode: false,
		showRemoteImages: false,
		setShowRemoteImages: vi.fn(),
		setMarkdownEditMode: vi.fn(),
		hasChanges: false,
		isSaving: false,
		fileStats: {
			size: 2048,
			modifiedAt: '2026-09-01T10:00:00Z',
			createdAt: '2026-08-01T10:00:00Z',
		},
		tokenCount: 512,
		taskCounts: null,
		showStatsBar: true,
		directoryPath: '/Users/pedram/Pedsidian/Meetings',
		showPath: true,
		shortcuts: {},
		onOpenInGraph: vi.fn(),
		copyContentToClipboard: vi.fn(async () => {}),
		copyPathToClipboard: vi.fn(),
		headerBtnClass: 'header-btn',
		headerIconClass: 'w-4 h-4',
		isHtml: false,
		htmlRenderMode: false,
		setHtmlRenderMode: vi.fn(),
		showTierChip: true,
		autoTier: 'fast' as const,
		previewTierOverride: undefined,
		onPreviewTierChange: vi.fn(),
		wordWrap: true,
		setWordWrap: vi.fn(),
		toolbarVisibility: allVisible,
		onDelete: vi.fn(),
		...overrides,
	};
	// The header takes a wide prop surface that only FilePreview assembles; the
	// cast keeps this test about the phone branch rather than about that shape.
	return render(<FilePreviewHeader {...(props as any)} />);
}

function openSheet() {
	fireEvent.click(screen.getByTestId('file-preview-actions-button'));
}

describe('FilePreviewHeader on a phone', () => {
	beforeEach(() => {
		mockedUsePhoneLayout.mockReturnValue(true);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('draws one overflow button instead of the icon cluster', () => {
		renderHeader();

		expect(screen.getByTestId('file-preview-actions-button')).toBeInTheDocument();
		// The toolbar itself holds nothing else: no delete, no reveal, no tier chip.
		expect(screen.queryByTestId('delete-file-button')).not.toBeInTheDocument();
		expect(screen.queryByTestId('reveal-in-folder-button')).not.toBeInTheDocument();
		expect(screen.queryByTestId('preview-tier-chip-button')).not.toBeInTheDocument();
	});

	it('moves the directory path and the stats out of the header and into the sheet', () => {
		renderHeader();

		expect(screen.queryByText('/Users/pedram/Pedsidian/Meetings')).not.toBeInTheDocument();
		expect(screen.queryByText('Size:')).not.toBeInTheDocument();

		openSheet();

		const info = screen.getByTestId('file-preview-actions-sheet-info');
		expect(info).toHaveTextContent('/Users/pedram/Pedsidian/Meetings');
		expect(info).toHaveTextContent('Size:');
		expect(info).toHaveTextContent('Lines:');
		expect(info).toHaveTextContent('Tokens:');
		expect(info).toHaveTextContent('Modified:');
	});

	it('keeps Save inline rather than burying it in the sheet', () => {
		renderHeader({ hasChanges: true, onSave: vi.fn() });

		expect(screen.getByText('Save')).toBeInTheDocument();
	});

	it('carries the toolbar actions into the sheet as labelled rows', () => {
		renderHeader();
		openSheet();

		expect(screen.getByText('Delete file')).toBeInTheDocument();
		expect(screen.getByText('Copy full path to clipboard')).toBeInTheDocument();
		expect(screen.getByText('View in Document Graph')).toBeInTheDocument();
	});

	it('runs the action and closes the sheet on tap', () => {
		const onDelete = vi.fn();
		renderHeader({ onDelete });
		openSheet();

		fireEvent.click(screen.getByText('Delete file'));

		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId('file-preview-actions-sheet')).not.toBeInTheDocument();
	});

	it('honours toolbarVisibility inside the sheet', () => {
		renderHeader({ toolbarVisibility: { ...allVisible, delete: false, copyPath: false } });
		openSheet();

		expect(screen.queryByText('Delete file')).not.toBeInTheDocument();
		expect(screen.queryByText('Copy full path to clipboard')).not.toBeInTheDocument();
		// A sibling the user did not hide is still there.
		expect(screen.getByText('View in Document Graph')).toBeInTheDocument();
	});

	it('carries Talk with Document into the sheet, pressed while a session runs', () => {
		const onTalkWithDocument = vi.fn();
		renderHeader({ onTalkWithDocument, isTalkingAboutDocument: true });
		openSheet();

		const row = screen.getByText('End the voice session about this document').closest('button');
		expect(row).toHaveAttribute('aria-pressed', 'true');

		fireEvent.click(row!);
		expect(onTalkWithDocument).toHaveBeenCalledTimes(1);
	});

	it('offers the preview tier as an accordion rather than an anchored popover', () => {
		const onPreviewTierChange = vi.fn();
		renderHeader({ onPreviewTierChange });
		openSheet();

		fireEvent.click(screen.getByTestId('file-preview-actions-tier'));
		fireEvent.click(screen.getByText('Giant'));

		expect(onPreviewTierChange).toHaveBeenCalledWith('giant');
	});
});

describe('FilePreviewHeader on a desktop', () => {
	beforeEach(() => {
		mockedUsePhoneLayout.mockReturnValue(false);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('still draws the full icon cluster, the path, and the stats subbar', () => {
		renderHeader();

		expect(screen.queryByTestId('file-preview-actions-button')).not.toBeInTheDocument();
		expect(screen.getByTestId('delete-file-button')).toBeInTheDocument();
		expect(screen.getByTestId('reveal-in-folder-button')).toBeInTheDocument();
		expect(screen.getByTestId('edit-text-toggle')).toBeInTheDocument();
		expect(screen.getByTestId('preview-tier-chip-button')).toBeInTheDocument();
		expect(screen.getByText('/Users/pedram/Pedsidian/Meetings')).toBeInTheDocument();
		expect(screen.getByText('Size:')).toBeInTheDocument();
	});

	// Talk with Document is a TOGGLE - the same button ends the session it
	// started - so it has to announce that state, not just take the accent color.
	it('draws Talk with Document and announces whether a session is running', () => {
		const onTalkWithDocument = vi.fn();
		renderHeader({ onTalkWithDocument });

		const idle = screen.getByTestId('talk-with-document-button');
		expect(idle).toHaveAttribute('aria-pressed', 'false');

		cleanup();
		renderHeader({ onTalkWithDocument, isTalkingAboutDocument: true });
		expect(screen.getByTestId('talk-with-document-button')).toHaveAttribute('aria-pressed', 'true');
	});

	it('drops Talk with Document when it is switched off in Settings', () => {
		renderHeader({
			onTalkWithDocument: vi.fn(),
			toolbarVisibility: { ...allVisible, talkWithDocument: false },
		});

		expect(screen.queryByTestId('talk-with-document-button')).not.toBeInTheDocument();
	});
});
