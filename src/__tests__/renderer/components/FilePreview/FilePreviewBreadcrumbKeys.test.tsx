import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilePreview } from '../../../../renderer/components/FilePreview';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../../helpers/mockTheme';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';

/**
 * Cmd+Left / Cmd+Right walk the file preview's breadcrumb history, and on macOS
 * the same chord is beginning-/end-of-line. The guard therefore has to be a
 * CARET check, not a file-type check.
 *
 * It used to read `isEditableText && markdownEditMode`, where `isEditableText`
 * is `!isImage && !isBinary && !isParquet` - a property of the file, decided
 * once, with nothing to do with where focus is. So typing in the find bar and
 * reaching for Cmd+Left navigated to the previous file instead of moving the
 * caret, which reads as the view randomly jumping between documents.
 */

const baseProps = {
	file: { name: 'test.md', content: '# Hello World', path: '/test/test.md' },
	onClose: vi.fn(),
	theme: mockTheme,
	markdownEditMode: false,
	setMarkdownEditMode: vi.fn(),
	shortcuts: {},
};

function renderPreview(props: Record<string, unknown> = {}) {
	return render(
		<LayerStackProvider>
			<FilePreview {...baseProps} {...props} />
		</LayerStackProvider>
	);
}

describe('FilePreview breadcrumb keys', () => {
	let onNavigateBack: ReturnType<typeof vi.fn>;
	let onNavigateForward: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		installLocalStorageMock();
		vi.clearAllMocks();
		onNavigateBack = vi.fn();
		onNavigateForward = vi.fn();
	});

	function navProps() {
		return {
			canGoBack: true,
			canGoForward: true,
			onNavigateBack,
			onNavigateForward,
		};
	}

	it('navigates back on Cmd+Left when the caret is not in a text field', () => {
		const { container } = renderPreview(navProps());
		const root = container.firstElementChild as HTMLElement;

		fireEvent.keyDown(root, { key: 'ArrowLeft', metaKey: true });

		expect(onNavigateBack).toHaveBeenCalledTimes(1);
	});

	it('navigates forward on Cmd+Right when the caret is not in a text field', () => {
		const { container } = renderPreview(navProps());
		const root = container.firstElementChild as HTMLElement;

		fireEvent.keyDown(root, { key: 'ArrowRight', metaKey: true });

		expect(onNavigateForward).toHaveBeenCalledTimes(1);
	});

	it('leaves Cmd+Left to the caret while typing in the find bar', () => {
		const { container } = renderPreview(navProps());
		const root = container.firstElementChild as HTMLElement;

		// Cmd+F opens the preview's own search field.
		fireEvent.keyDown(root, { key: 'f', metaKey: true });
		const search = screen.getByPlaceholderText(/search/i);

		fireEvent.keyDown(search, { key: 'ArrowLeft', metaKey: true, bubbles: true });

		// The chord belongs to the input - beginning-of-line, not a document jump.
		expect(onNavigateBack).not.toHaveBeenCalled();
	});

	it('leaves Cmd+Right to the caret while typing in the find bar', () => {
		const { container } = renderPreview(navProps());
		const root = container.firstElementChild as HTMLElement;

		fireEvent.keyDown(root, { key: 'f', metaKey: true });
		const search = screen.getByPlaceholderText(/search/i);

		fireEvent.keyDown(search, { key: 'ArrowRight', metaKey: true, bubbles: true });

		expect(onNavigateForward).not.toHaveBeenCalled();
	});

	it('leaves the chord alone in a textarea, whatever the file type', () => {
		const { container } = renderPreview(navProps());
		const root = container.firstElementChild as HTMLElement;

		// A textarea rendered inside the preview subtree: the old guard only
		// bailed when markdownEditMode was ALSO on, so this used to navigate.
		const textarea = document.createElement('textarea');
		root.appendChild(textarea);

		fireEvent.keyDown(textarea, { key: 'ArrowLeft', metaKey: true, bubbles: true });

		expect(onNavigateBack).not.toHaveBeenCalled();
	});
});
