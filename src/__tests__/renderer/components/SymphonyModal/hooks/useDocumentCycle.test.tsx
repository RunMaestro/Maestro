/**
 * Tests for SymphonyModal/hooks/useDocumentCycle - Cmd+Shift+[/] document
 * cycling, wrap behavior, no-op guards, cleanup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDocumentCycle } from '../../../../../renderer/components/SymphonyModal/hooks/useDocumentCycle';
import type { SymphonyIssue } from '../../../../../shared/symphony-types';

function makeIssueWithDocs(count: number): SymphonyIssue {
	return {
		number: 1,
		title: 't',
		body: '',
		htmlUrl: '',
		status: 'available',
		labels: [],
		documentPaths: Array.from({ length: count }, (_, i) => ({
			name: `doc-${i}.md`,
			path: `path/doc-${i}.md`,
			isExternal: i % 2 === 0,
		})),
	} as SymphonyIssue;
}

function fireMetaShift(key: '[' | ']') {
	window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, shiftKey: true }));
}

function fireCtrlShift(key: '[' | ']') {
	window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: true }));
}

describe('useDocumentCycle', () => {
	let onPreview: ReturnType<typeof vi.fn>;
	let onIndex: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		onPreview = vi.fn();
		onIndex = vi.fn();
	});

	it('cycles forward with Cmd+Shift+] and wraps to 0 at end', () => {
		const issue = makeIssueWithDocs(3);
		renderHook(() =>
			useDocumentCycle({
				selectedIssue: issue,
				selectedDocIndex: 2,
				onPreviewDocument: onPreview,
				onIndexChange: onIndex,
			})
		);
		fireMetaShift(']');
		expect(onIndex).toHaveBeenCalledWith(0);
		expect(onPreview).toHaveBeenCalledWith('path/doc-0.md', true);
	});

	it('cycles backward with Cmd+Shift+[ and wraps to last at index 0', () => {
		const issue = makeIssueWithDocs(3);
		renderHook(() =>
			useDocumentCycle({
				selectedIssue: issue,
				selectedDocIndex: 0,
				onPreviewDocument: onPreview,
				onIndexChange: onIndex,
			})
		);
		fireMetaShift('[');
		expect(onIndex).toHaveBeenCalledWith(2);
		expect(onPreview).toHaveBeenCalledWith('path/doc-2.md', true);
	});

	it('cycles with Ctrl+Shift+] for non-mac shortcuts', () => {
		const issue = makeIssueWithDocs(3);
		renderHook(() =>
			useDocumentCycle({
				selectedIssue: issue,
				selectedDocIndex: 0,
				onPreviewDocument: onPreview,
				onIndexChange: onIndex,
			})
		);
		fireCtrlShift(']');
		expect(onIndex).toHaveBeenCalledWith(1);
		expect(onPreview).toHaveBeenCalledWith('path/doc-1.md', false);
	});

	it('clamps out-of-range selectedDocIndex before cycling', () => {
		const issue = makeIssueWithDocs(3);
		renderHook(() =>
			useDocumentCycle({
				selectedIssue: issue,
				selectedDocIndex: 99,
				onPreviewDocument: onPreview,
				onIndexChange: onIndex,
			})
		);
		fireMetaShift(']');
		expect(onIndex).toHaveBeenCalledWith(0);
		expect(onPreview).toHaveBeenCalledWith('path/doc-0.md', true);
	});

	it('is a no-op when selectedIssue is null', () => {
		renderHook(() =>
			useDocumentCycle({
				selectedIssue: null,
				selectedDocIndex: 0,
				onPreviewDocument: onPreview,
				onIndexChange: onIndex,
			})
		);
		fireMetaShift(']');
		fireMetaShift('[');
		expect(onIndex).not.toHaveBeenCalled();
		expect(onPreview).not.toHaveBeenCalled();
	});

	it('is a no-op when the issue has zero documents', () => {
		renderHook(() =>
			useDocumentCycle({
				selectedIssue: makeIssueWithDocs(0),
				selectedDocIndex: 0,
				onPreviewDocument: onPreview,
				onIndexChange: onIndex,
			})
		);
		fireMetaShift(']');
		expect(onIndex).not.toHaveBeenCalled();
	});

	it('removes the listener on unmount', () => {
		const issue = makeIssueWithDocs(2);
		const { unmount } = renderHook(() =>
			useDocumentCycle({
				selectedIssue: issue,
				selectedDocIndex: 0,
				onPreviewDocument: onPreview,
				onIndexChange: onIndex,
			})
		);
		unmount();
		fireMetaShift(']');
		expect(onIndex).not.toHaveBeenCalled();
	});

	it('forwards both path and isExternal to onPreviewDocument', () => {
		const issue = makeIssueWithDocs(2); // doc-0 external, doc-1 not
		renderHook(() =>
			useDocumentCycle({
				selectedIssue: issue,
				selectedDocIndex: 0,
				onPreviewDocument: onPreview,
				onIndexChange: onIndex,
			})
		);
		fireMetaShift(']');
		expect(onPreview).toHaveBeenCalledWith('path/doc-1.md', false);
	});
});
