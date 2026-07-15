/**
 * Tests for SymphonyModal/hooks/useDocumentPreview - external fetch path,
 * repo-relative placeholder path, no-repo bail, loading lifecycle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDocumentPreview } from '../../../../../renderer/components/SymphonyModal/hooks/useDocumentPreview';
import { makeRepo } from '../_fixtures';

function flushPromises() {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('useDocumentPreview', () => {
	let fetchDocumentContent: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchDocumentContent = vi.fn();
	});

	it('fetches content for external http URLs and stores it on success', async () => {
		fetchDocumentContent.mockResolvedValue({ success: true, content: '# Hello' });
		const { result } = renderHook(() =>
			useDocumentPreview({ selectedRepo: makeRepo(), fetchDocumentContent })
		);
		await act(async () => {
			await result.current.previewDocument('https://gist.github.com/x', true);
		});
		expect(result.current.documentPreview).toBe('# Hello');
		expect(result.current.isLoadingDocument).toBe(false);
	});

	it('treats empty successful content as a valid preview', async () => {
		fetchDocumentContent.mockResolvedValue({ success: true, content: '' });
		const { result } = renderHook(() =>
			useDocumentPreview({ selectedRepo: makeRepo(), fetchDocumentContent })
		);
		await act(async () => {
			await result.current.previewDocument('https://gist.github.com/empty', true);
		});
		expect(result.current.documentPreview).toBe('');
		expect(result.current.isLoadingDocument).toBe(false);
	});

	it('renders an error message when the IPC returns success:false', async () => {
		fetchDocumentContent.mockResolvedValue({ success: false, error: '404' });
		const { result } = renderHook(() =>
			useDocumentPreview({ selectedRepo: makeRepo(), fetchDocumentContent })
		);
		await act(async () => {
			await result.current.previewDocument('https://gist.github.com/x', true);
		});
		expect(result.current.documentPreview).toBe('*Failed to load document: 404*');
	});

	it('renders a placeholder for repo-relative paths (no IPC call)', async () => {
		const { result } = renderHook(() =>
			useDocumentPreview({ selectedRepo: makeRepo(), fetchDocumentContent })
		);
		await act(async () => {
			await result.current.previewDocument('docs/spec.md', false);
		});
		expect(fetchDocumentContent).not.toHaveBeenCalled();
		expect(result.current.documentPreview).toMatch(/This document is located at `docs\/spec\.md`/);
	});

	it('bails early when no repo is selected', async () => {
		const { result } = renderHook(() =>
			useDocumentPreview({ selectedRepo: null, fetchDocumentContent })
		);
		await act(async () => {
			await result.current.previewDocument('docs/spec.md', false);
		});
		expect(fetchDocumentContent).not.toHaveBeenCalled();
		expect(result.current.documentPreview).toBeNull();
	});

	it('flips isLoadingDocument during the call', async () => {
		let resolver: (v: { success: boolean; content: string }) => void;
		fetchDocumentContent.mockReturnValue(
			new Promise((r) => {
				resolver = r;
			})
		);
		const { result } = renderHook(() =>
			useDocumentPreview({ selectedRepo: makeRepo(), fetchDocumentContent })
		);
		act(() => {
			result.current.previewDocument('https://gist.github.com/y', true);
		});
		expect(result.current.isLoadingDocument).toBe(true);
		await act(async () => {
			resolver!({ success: true, content: 'Done' });
			await flushPromises();
		});
		expect(result.current.isLoadingDocument).toBe(false);
		expect(result.current.documentPreview).toBe('Done');
	});

	it('ignores stale responses when a newer preview request finishes first', async () => {
		let firstResolver: (v: { success: boolean; content: string }) => void;
		let secondResolver: (v: { success: boolean; content: string }) => void;
		fetchDocumentContent
			.mockReturnValueOnce(
				new Promise((resolve) => {
					firstResolver = resolve;
				})
			)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					secondResolver = resolve;
				})
			);
		const { result } = renderHook(() =>
			useDocumentPreview({ selectedRepo: makeRepo(), fetchDocumentContent })
		);

		act(() => {
			result.current.previewDocument('https://example.com/first.md', true);
			result.current.previewDocument('https://example.com/second.md', true);
		});
		await act(async () => {
			secondResolver!({ success: true, content: 'Second' });
			await flushPromises();
		});
		expect(result.current.documentPreview).toBe('Second');
		expect(result.current.isLoadingDocument).toBe(false);

		await act(async () => {
			firstResolver!({ success: true, content: 'First' });
			await flushPromises();
		});
		expect(result.current.documentPreview).toBe('Second');
		expect(result.current.isLoadingDocument).toBe(false);
	});

	it('catches IPC throws and renders an error markdown', async () => {
		fetchDocumentContent.mockRejectedValue(new Error('IPC offline'));
		const { result } = renderHook(() =>
			useDocumentPreview({ selectedRepo: makeRepo(), fetchDocumentContent })
		);
		await act(async () => {
			await result.current.previewDocument('https://example.com/doc.md', true);
		});
		expect(result.current.documentPreview).toBe('*Failed to load document: IPC offline*');
		expect(result.current.isLoadingDocument).toBe(false);
	});

	it('keeps previewDocument stable when only the fetch callback identity changes', async () => {
		fetchDocumentContent.mockResolvedValue({ success: true, content: '# First' });
		const repo = makeRepo();
		const { result, rerender } = renderHook(
			({ fetcher }) => useDocumentPreview({ selectedRepo: repo, fetchDocumentContent: fetcher }),
			{ initialProps: { fetcher: fetchDocumentContent } }
		);
		const initialPreviewDocument = result.current.previewDocument;
		const nextFetchDocumentContent = vi
			.fn()
			.mockResolvedValue({ success: true, content: '# Next' });

		rerender({ fetcher: nextFetchDocumentContent });

		expect(result.current.previewDocument).toBe(initialPreviewDocument);
		await act(async () => {
			await result.current.previewDocument('https://example.com/doc.md', true);
		});
		expect(fetchDocumentContent).not.toHaveBeenCalled();
		expect(nextFetchDocumentContent).toHaveBeenCalledWith('https://example.com/doc.md');
		expect(result.current.documentPreview).toBe('# Next');
	});

	it('resetPreview() clears the current preview', async () => {
		fetchDocumentContent.mockResolvedValue({ success: true, content: 'X' });
		const { result } = renderHook(() =>
			useDocumentPreview({ selectedRepo: makeRepo(), fetchDocumentContent })
		);
		await act(async () => {
			await result.current.previewDocument('https://e/y', true);
		});
		expect(result.current.documentPreview).toBe('X');
		act(() => result.current.resetPreview());
		expect(result.current.documentPreview).toBeNull();
	});
});
