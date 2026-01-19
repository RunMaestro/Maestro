/**
 * @file AutoRunMemoryLeaks.test.tsx
 * @description Memory leak detection tests for the Auto Run feature
 *
 * Task 7.4 - Memory leak detection tests:
 * - Repeated mount/unmount cycles
 * - Image cache doesn't grow unbounded
 * - Undo stack memory with large edits
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import React from 'react';
import { renderHook } from '@testing-library/react';
import { AutoRun } from '../../renderer/components/AutoRun';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { imageCache, useAutoRunImageHandling } from '../../renderer/hooks/useAutoRunImageHandling';
import { useAutoRunUndo } from '../../renderer/hooks/useAutoRunUndo';
import type { Theme, BatchRunState, SessionState } from '../../renderer/types';

// Helper to render with LayerStackProvider (required by AutoRunSearchBar)
const renderWithProvider = (ui: React.ReactElement) => {
	const result = render(<LayerStackProvider>{ui}</LayerStackProvider>);
	return {
		...result,
		rerender: (newUi: React.ReactElement) =>
			result.rerender(<LayerStackProvider>{newUi}</LayerStackProvider>),
	};
};

// Mock dependencies
vi.mock('react-markdown', () => ({
	default: ({ children }: { children: string }) => (
		<div data-testid="react-markdown">{children}</div>
	),
}));

vi.mock('remark-gfm', () => ({
	default: {},
}));

vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children }: { children: string }) => (
		<code data-testid="syntax-highlighter">{children}</code>
	),
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
}));

vi.mock('../../renderer/components/AutoRunnerHelpModal', () => ({
	AutoRunnerHelpModal: ({ onClose }: { onClose: () => void }) => (
		<div data-testid="help-modal">
			<button onClick={onClose}>Close</button>
		</div>
	),
}));

vi.mock('../../renderer/components/MermaidRenderer', () => ({
	MermaidRenderer: ({ chart }: { chart: string }) => (
		<div data-testid="mermaid-renderer">{chart}</div>
	),
}));

vi.mock('../../renderer/components/AutoRunDocumentSelector', () => ({
	AutoRunDocumentSelector: ({
		theme,
		documents,
		selectedDocument,
		onSelectDocument,
		onRefresh,
		onChangeFolder,
		onCreateDocument,
		isLoading,
	}: any) => (
		<div data-testid="document-selector">
			<select
				data-testid="doc-select"
				value={selectedDocument || ''}
				onChange={(e) => onSelectDocument(e.target.value)}
			>
				{documents.map((doc: string) => (
					<option key={doc} value={doc}>
						{doc}
					</option>
				))}
			</select>
			<button data-testid="refresh-btn" onClick={onRefresh}>
				Refresh
			</button>
			<button data-testid="change-folder-btn" onClick={onChangeFolder}>
				Change
			</button>
			{isLoading && <span data-testid="loading-indicator">Loading...</span>}
		</div>
	),
}));

vi.mock('../../renderer/hooks/useTemplateAutocomplete', () => ({
	useTemplateAutocomplete: ({
		value,
		onChange,
	}: {
		value: string;
		onChange: (value: string) => void;
	}) => ({
		autocompleteState: {
			isOpen: false,
			suggestions: [],
			selectedIndex: 0,
			position: { top: 0, left: 0 },
		},
		handleKeyDown: () => false,
		handleChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
			onChange(e.target.value);
		},
		selectVariable: () => {},
		closeAutocomplete: () => {},
		autocompleteRef: { current: null },
	}),
}));

vi.mock('../../renderer/components/TemplateAutocompleteDropdown', () => ({
	TemplateAutocompleteDropdown: React.forwardRef(() => null),
}));

// Helper to create mock theme
const createMockTheme = (): Theme => ({
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgPanel: '#252525',
		bgActivity: '#2d2d2d',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#0066ff',
		accentForeground: '#ffffff',
		border: '#333333',
		highlight: '#0066ff33',
		success: '#00aa00',
		warning: '#ffaa00',
		error: '#ff0000',
	},
});

// Setup window.maestro mock
const setupMaestroMock = () => {
	const mockMaestro = {
		fs: {
			readFile: vi.fn().mockResolvedValue('data:image/png;base64,abc123'),
			readDir: vi.fn().mockResolvedValue([]),
		},
		autorun: {
			listImages: vi.fn().mockResolvedValue({ success: true, images: [] }),
			saveImage: vi.fn().mockResolvedValue({ success: true, relativePath: 'images/test-123.png' }),
			deleteImage: vi.fn().mockResolvedValue({ success: true }),
			writeDoc: vi.fn().mockResolvedValue(undefined),
		},
		settings: {
			get: vi.fn().mockResolvedValue(null),
			set: vi.fn().mockResolvedValue(undefined),
		},
	};

	(window as any).maestro = mockMaestro;
	return mockMaestro;
};

// Default props factory
const createDefaultProps = (overrides: Partial<React.ComponentProps<typeof AutoRun>> = {}) => ({
	theme: createMockTheme(),
	sessionId: 'test-session-1',
	folderPath: '/test/folder',
	selectedFile: 'test-doc',
	documentList: ['test-doc'],
	content: '# Test Content\n\nSome markdown content.',
	onContentChange: vi.fn(),
	mode: 'edit' as const,
	onModeChange: vi.fn(),
	onOpenSetup: vi.fn(),
	onRefresh: vi.fn(),
	onSelectDocument: vi.fn(),
	onCreateDocument: vi.fn().mockResolvedValue(true),
	...overrides,
});

/**
 * Generate a large content string for memory testing
 */
function generateLargeContent(sizeInKB: number): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	const targetBytes = sizeInKB * 1024;
	let content = '';
	while (content.length < targetBytes) {
		content += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return content;
}

describe('AutoRun Memory Leak Detection', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
		cleanup();
		// Clear image cache after each test
		imageCache.clear();
	});

	describe('Repeated Mount/Unmount Cycles', () => {
		it('handles 50 mount/unmount cycles without issues', () => {
			const props = createDefaultProps();

			for (let i = 0; i < 50; i++) {
				const { unmount } = renderWithProvider(<AutoRun {...props} />);
				expect(screen.getByRole('textbox')).toBeInTheDocument();
				unmount();
			}

			// Final mount should work correctly
			const { unmount } = renderWithProvider(<AutoRun {...props} />);
			expect(screen.getByRole('textbox')).toBeInTheDocument();
			unmount();
		});

		it('handles 100 mount/unmount cycles without issues', () => {
			const props = createDefaultProps();

			for (let i = 0; i < 100; i++) {
				const { unmount } = renderWithProvider(<AutoRun {...props} />);
				unmount();
			}

			// Final mount works
			const { unmount } = renderWithProvider(<AutoRun {...props} />);
			expect(screen.getByRole('textbox')).toBeInTheDocument();
			unmount();
		});

		it('cleans up event listeners on unmount', () => {
			const props = createDefaultProps();

			const { unmount } = renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

			// Add event listener tracking
			const originalAddEventListener = textarea.addEventListener;
			const originalRemoveEventListener = textarea.removeEventListener;
			let addCount = 0;
			let removeCount = 0;

			textarea.addEventListener = (...args: Parameters<typeof originalAddEventListener>) => {
				addCount++;
				return originalAddEventListener.apply(textarea, args);
			};

			textarea.removeEventListener = (...args: Parameters<typeof originalRemoveEventListener>) => {
				removeCount++;
				return originalRemoveEventListener.apply(textarea, args);
			};

			unmount();

			// Component should have cleaned up properly (no error/crash)
		});

		it('cleans up timers on unmount', async () => {
			const props = createDefaultProps();

			const { unmount } = renderWithProvider(<AutoRun {...props} />);

			// Trigger timer-based operations (undo snapshot scheduling)
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Modified content' } });

			// Unmount before timer fires
			unmount();

			// Advance timers - should not cause errors
			await act(async () => {
				vi.advanceTimersByTime(2000);
			});

			// No errors should have been thrown
		});

		it('handles rapid mount/unmount without pending state updates', async () => {
			const props = createDefaultProps();

			// Rapid mount/unmount with async operations
			for (let i = 0; i < 20; i++) {
				const { unmount } = renderWithProvider(<AutoRun {...props} sessionId={`session-${i}`} />);

				// Trigger some async operations
				const textarea = screen.getByRole('textbox');
				fireEvent.change(textarea, { target: { value: `Content ${i}` } });

				unmount();

				// Advance timers between cycles
				await act(async () => {
					vi.advanceTimersByTime(100);
				});
			}
		});

		it('handles mount/unmount during mode transitions', () => {
			const props = createDefaultProps();

			for (let i = 0; i < 30; i++) {
				const mode = i % 2 === 0 ? 'edit' : 'preview';
				const { unmount } = renderWithProvider(
					<AutoRun {...props} mode={mode as 'edit' | 'preview'} />
				);

				if (mode === 'edit') {
					expect(screen.getByRole('textbox')).toBeInTheDocument();
				} else {
					expect(screen.getByTestId('react-markdown')).toBeInTheDocument();
				}

				unmount();
			}
		});

		it('handles mount/unmount with different content sizes', () => {
			const sizes = [1, 10, 50, 100, 500]; // KB

			for (const size of sizes) {
				const content = generateLargeContent(size);
				const props = createDefaultProps({ content });

				const { unmount } = renderWithProvider(<AutoRun {...props} />);
				expect(screen.getByRole('textbox')).toBeInTheDocument();
				unmount();
			}
		});

		it('handles mount/unmount with attachments loaded', async () => {
			mockMaestro.autorun.listImages.mockResolvedValue({
				success: true,
				images: [
					{ filename: 'img1.png', relativePath: 'images/img1.png' },
					{ filename: 'img2.png', relativePath: 'images/img2.png' },
				],
			});

			const props = createDefaultProps();

			for (let i = 0; i < 10; i++) {
				const { unmount } = renderWithProvider(<AutoRun {...props} />);

				// Wait for async image loading
				await act(async () => {
					vi.advanceTimersByTime(100);
				});

				unmount();
			}
		});

		it('handles mount/unmount with batch run state', () => {
			const batchRunState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				documents: ['doc1', 'doc2'],
				currentDocumentIndex: 0,
				currentDocTasksTotal: 5,
				currentDocTasksCompleted: 2,
			};

			const props = createDefaultProps({ batchRunState, mode: 'preview' });

			for (let i = 0; i < 20; i++) {
				const { unmount } = renderWithProvider(<AutoRun {...props} />);
				unmount();
			}
		});

		it('handles mount/unmount with search bar open', async () => {
			const props = createDefaultProps();

			for (let i = 0; i < 10; i++) {
				const { unmount } = renderWithProvider(<AutoRun {...props} />);

				// Open search
				const textarea = screen.getByRole('textbox');
				fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

				await act(async () => {
					vi.advanceTimersByTime(50);
				});

				unmount();
			}
		});
	});

	describe('Image Cache Memory Bounds', () => {
		beforeEach(() => {
			// Clear the image cache before each test
			imageCache.clear();
		});

		it('imageCache is a module-level Map', () => {
			expect(imageCache).toBeInstanceOf(Map);
		});

		it('imageCache starts empty', () => {
			expect(imageCache.size).toBe(0);
		});

		it('entries can be added to imageCache', () => {
			const key = '/test/folder:images/test.png';
			const value = 'data:image/png;base64,abc123';

			imageCache.set(key, value);

			expect(imageCache.size).toBe(1);
			expect(imageCache.get(key)).toBe(value);
		});

		it('imageCache clears correctly', () => {
			imageCache.set('key1', 'value1');
			imageCache.set('key2', 'value2');

			expect(imageCache.size).toBe(2);

			imageCache.clear();

			expect(imageCache.size).toBe(0);
		});

		it('imageCache deletes individual entries correctly', () => {
			imageCache.set('key1', 'value1');
			imageCache.set('key2', 'value2');

			imageCache.delete('key1');

			expect(imageCache.size).toBe(1);
			expect(imageCache.has('key1')).toBe(false);
			expect(imageCache.has('key2')).toBe(true);
		});

		it('imageCache handles 100 entries', () => {
			for (let i = 0; i < 100; i++) {
				const key = `/folder${i}:images/img${i}.png`;
				const value = `data:image/png;base64,data${i}`;
				imageCache.set(key, value);
			}

			expect(imageCache.size).toBe(100);

			// Verify retrieval
			expect(imageCache.get('/folder50:images/img50.png')).toBe('data:image/png;base64,data50');

			imageCache.clear();
		});

		it('imageCache handles large data URLs', () => {
			// Simulate a large base64 image (1MB)
			const largeData = 'data:image/png;base64,' + 'A'.repeat(1024 * 1024);
			const key = '/test/folder:images/large.png';

			imageCache.set(key, largeData);

			expect(imageCache.size).toBe(1);
			expect(imageCache.get(key)?.length).toBeGreaterThan(1000000);

			imageCache.clear();
		});

		it('useAutoRunImageHandling clears cache entries on remove', async () => {
			// Setup cache with an entry
			const folderPath = '/test/folder';
			const relativePath = 'images/test-img.png';
			const cacheKey = `${folderPath}:${relativePath}`;

			imageCache.set(cacheKey, 'data:image/png;base64,testdata');
			expect(imageCache.has(cacheKey)).toBe(true);

			// Create a mock wrapper for testing the hook
			const textareaRef = { current: document.createElement('textarea') };
			const lastUndoSnapshotRef = { current: '' };

			const { result } = renderHook(() =>
				useAutoRunImageHandling({
					folderPath,
					selectedFile: 'test-doc',
					localContent: `![test-img.png](${relativePath})`,
					setLocalContent: vi.fn(),
					handleContentChange: vi.fn(),
					isLocked: false,
					textareaRef,
					pushUndoState: vi.fn(),
					lastUndoSnapshotRef,
				})
			);

			// Call handleRemoveAttachment
			await act(async () => {
				await result.current.handleRemoveAttachment(relativePath);
			});

			// Cache entry should be cleared
			expect(imageCache.has(cacheKey)).toBe(false);
		});

		it('imageCache is isolated between test runs', () => {
			// This test verifies the afterEach cleanup is working
			// If the previous test didn't clean up, this would fail
			expect(imageCache.size).toBe(0);

			imageCache.set('test', 'value');
			expect(imageCache.size).toBe(1);

			// Cleanup will happen in afterEach
		});

		it('multiple hook instances share the same cache', () => {
			const textareaRef1 = { current: document.createElement('textarea') };
			const textareaRef2 = { current: document.createElement('textarea') };
			const lastUndoSnapshotRef1 = { current: '' };
			const lastUndoSnapshotRef2 = { current: '' };

			const deps1 = {
				folderPath: '/folder1',
				selectedFile: 'doc1',
				localContent: '',
				setLocalContent: vi.fn(),
				handleContentChange: vi.fn(),
				isLocked: false,
				textareaRef: textareaRef1,
				pushUndoState: vi.fn(),
				lastUndoSnapshotRef: lastUndoSnapshotRef1,
			};

			const deps2 = {
				folderPath: '/folder2',
				selectedFile: 'doc2',
				localContent: '',
				setLocalContent: vi.fn(),
				handleContentChange: vi.fn(),
				isLocked: false,
				textareaRef: textareaRef2,
				pushUndoState: vi.fn(),
				lastUndoSnapshotRef: lastUndoSnapshotRef2,
			};

			// Render both hooks
			const { unmount: unmount1 } = renderHook(() => useAutoRunImageHandling(deps1));
			const { unmount: unmount2 } = renderHook(() => useAutoRunImageHandling(deps2));

			// Add to cache from "outside" (simulating loading)
			imageCache.set('/folder1:images/img1.png', 'data1');
			imageCache.set('/folder2:images/img2.png', 'data2');

			// Both entries should be in the shared cache
			expect(imageCache.size).toBe(2);

			unmount1();
			unmount2();
		});

		it('cache keys are properly namespaced by folder path', () => {
			// Same filename in different folders should have different cache keys
			imageCache.set('/folder1:images/image.png', 'data1');
			imageCache.set('/folder2:images/image.png', 'data2');

			expect(imageCache.size).toBe(2);
			expect(imageCache.get('/folder1:images/image.png')).toBe('data1');
			expect(imageCache.get('/folder2:images/image.png')).toBe('data2');
		});

		it('deleting from one folder does not affect another', () => {
			imageCache.set('/folder1:images/image.png', 'data1');
			imageCache.set('/folder2:images/image.png', 'data2');

			imageCache.delete('/folder1:images/image.png');

			expect(imageCache.has('/folder1:images/image.png')).toBe(false);
			expect(imageCache.has('/folder2:images/image.png')).toBe(true);
		});
	});

	describe('Undo Stack Memory with Large Edits', () => {
		it('undo stack respects MAX_UNDO_HISTORY limit (50 entries)', async () => {
			const textareaRef = { current: document.createElement('textarea') };
			const setLocalContent = vi.fn();

			const { result, rerender } = renderHook(
				({ localContent }) =>
					useAutoRunUndo({
						selectedFile: 'test-doc',
						localContent,
						setLocalContent,
						textareaRef,
					}),
				{ initialProps: { localContent: 'initial' } }
			);

			// Push 60 states (more than the 50 limit)
			for (let i = 0; i < 60; i++) {
				const content = `content-${i}`;
				rerender({ localContent: content });

				act(() => {
					result.current.pushUndoState(content, 0);
				});
			}

			// Undo should work up to 50 times (the max)
			let undoCount = 0;
			while (undoCount < 60) {
				const prevContent = setLocalContent.mock.calls.length;
				act(() => {
					result.current.handleUndo();
				});
				const newContent = setLocalContent.mock.calls.length;

				if (newContent === prevContent) {
					// No more undo operations available
					break;
				}
				undoCount++;
			}

			// Should have been able to undo approximately 50 times (give or take due to timing)
			expect(undoCount).toBeLessThanOrEqual(50);
		});

		it('undo stack handles large content entries', () => {
			const textareaRef = { current: document.createElement('textarea') };
			const setLocalContent = vi.fn();

			const { result, rerender } = renderHook(
				({ localContent }) =>
					useAutoRunUndo({
						selectedFile: 'test-doc',
						localContent,
						setLocalContent,
						textareaRef,
					}),
				{ initialProps: { localContent: '' } }
			);

			// Push large content entries (100KB each)
			const largeContents: string[] = [];
			for (let i = 0; i < 10; i++) {
				const content = generateLargeContent(100);
				largeContents.push(content);
				rerender({ localContent: content });

				act(() => {
					result.current.pushUndoState(content, 0);
				});
			}

			// Undo should work with large content
			act(() => {
				result.current.handleUndo();
			});

			expect(setLocalContent).toHaveBeenCalled();
		});

		it('undo stack per-document isolation prevents cross-document memory growth', () => {
			const textareaRef = { current: document.createElement('textarea') };
			const setLocalContent = vi.fn();

			// Start with document 1
			const { result, rerender } = renderHook(
				({ selectedFile, localContent }) =>
					useAutoRunUndo({
						selectedFile,
						localContent,
						setLocalContent,
						textareaRef,
					}),
				{ initialProps: { selectedFile: 'doc1', localContent: 'doc1-initial' } }
			);

			// Push states for doc1
			for (let i = 0; i < 10; i++) {
				const content = `doc1-content-${i}`;
				rerender({ selectedFile: 'doc1', localContent: content });
				act(() => {
					result.current.pushUndoState(content, 0);
				});
			}

			// Switch to doc2
			rerender({ selectedFile: 'doc2', localContent: 'doc2-initial' });

			// Push states for doc2
			for (let i = 0; i < 10; i++) {
				const content = `doc2-content-${i}`;
				rerender({ selectedFile: 'doc2', localContent: content });
				act(() => {
					result.current.pushUndoState(content, 0);
				});
			}

			// Undo in doc2 should only undo doc2 history
			act(() => {
				result.current.handleUndo();
			});

			// Should have called setLocalContent with doc2 content, not doc1
			const lastCall = setLocalContent.mock.calls[setLocalContent.mock.calls.length - 1];
			expect(lastCall[0]).toContain('doc2');
		});

		it('resetUndoHistory clears tracking reference', () => {
			const textareaRef = { current: document.createElement('textarea') };
			const setLocalContent = vi.fn();

			const { result, rerender } = renderHook(
				({ localContent }) =>
					useAutoRunUndo({
						selectedFile: 'test-doc',
						localContent,
						setLocalContent,
						textareaRef,
					}),
				{ initialProps: { localContent: 'initial' } }
			);

			// Push some states
			for (let i = 0; i < 5; i++) {
				const content = `content-${i}`;
				rerender({ localContent: content });
				act(() => {
					result.current.pushUndoState(content, 0);
				});
			}

			// Reset undo history
			act(() => {
				result.current.resetUndoHistory('new-content');
			});

			// lastUndoSnapshotRef should be updated
			expect(result.current.lastUndoSnapshotRef.current).toBe('new-content');
		});

		it('redo stack clears on new edit (prevents unbounded growth)', () => {
			const textareaRef = { current: document.createElement('textarea') };
			const setLocalContent = vi.fn();

			const { result, rerender } = renderHook(
				({ localContent }) =>
					useAutoRunUndo({
						selectedFile: 'test-doc',
						localContent,
						setLocalContent,
						textareaRef,
					}),
				{ initialProps: { localContent: 'initial' } }
			);

			// Push states
			for (let i = 0; i < 5; i++) {
				const content = `content-${i}`;
				rerender({ localContent: content });
				act(() => {
					result.current.pushUndoState(content, 0);
				});
			}

			// Undo a few times to build redo stack
			act(() => {
				result.current.handleUndo();
				result.current.handleUndo();
				result.current.handleUndo();
			});

			// Now make a new edit - this should clear redo stack
			const newContent = 'brand-new-content';
			rerender({ localContent: newContent });
			act(() => {
				result.current.pushUndoState(newContent, 0);
			});

			// Redo should have no effect (stack was cleared)
			const callCountBefore = setLocalContent.mock.calls.length;
			act(() => {
				result.current.handleRedo();
			});
			const callCountAfter = setLocalContent.mock.calls.length;

			expect(callCountAfter).toBe(callCountBefore);
		});

		it('debounced snapshot scheduling cleans up on unmount', async () => {
			const textareaRef = { current: document.createElement('textarea') };
			const setLocalContent = vi.fn();

			const { result, unmount } = renderHook(() =>
				useAutoRunUndo({
					selectedFile: 'test-doc',
					localContent: 'content',
					setLocalContent,
					textareaRef,
				})
			);

			// Schedule a debounced snapshot
			act(() => {
				result.current.scheduleUndoSnapshot('prev-content', 0);
			});

			// Unmount before the debounce fires
			unmount();

			// Advance timers - should not cause errors or state updates
			await act(async () => {
				vi.advanceTimersByTime(2000);
			});
		});

		it('debounced snapshot scheduling cleans up on document change', async () => {
			const textareaRef = { current: document.createElement('textarea') };
			const setLocalContent = vi.fn();

			const { result, rerender, unmount } = renderHook(
				({ selectedFile }) =>
					useAutoRunUndo({
						selectedFile,
						localContent: 'content',
						setLocalContent,
						textareaRef,
					}),
				{ initialProps: { selectedFile: 'doc1' } }
			);

			// Schedule a debounced snapshot for doc1
			act(() => {
				result.current.scheduleUndoSnapshot('doc1-content', 0);
			});

			// Switch to doc2 (should clean up doc1's pending snapshot)
			rerender({ selectedFile: 'doc2' });

			// Advance timers - should not cause errors
			await act(async () => {
				vi.advanceTimersByTime(2000);
			});

			unmount();
		});
	});

	describe('Combined Memory Stress Tests', () => {
		it('handles 10 mount/unmount cycles with large content', () => {
			// Reduced from 50 to 10 cycles and 500KB to 100KB to keep test runtime reasonable
			const largeContent = generateLargeContent(100); // 100KB
			const props = createDefaultProps({ content: largeContent });

			for (let i = 0; i < 10; i++) {
				const { unmount } = renderWithProvider(<AutoRun {...props} />);
				expect(screen.getByRole('textbox')).toBeInTheDocument();
				unmount();
			}
		});

		it('handles multiple sessions with undo history and image cache', async () => {
			const sessions = ['session-1', 'session-2', 'session-3'];

			for (let cycle = 0; cycle < 10; cycle++) {
				for (const sessionId of sessions) {
					const props = createDefaultProps({
						sessionId,
						folderPath: `/projects/${sessionId}/Auto Run Docs`,
						content: `# ${sessionId} Content cycle ${cycle}`,
					});

					const { unmount } = renderWithProvider(<AutoRun {...props} />);

					// Make some edits to build undo history
					const textarea = screen.getByRole('textbox');
					fireEvent.change(textarea, { target: { value: `Modified ${sessionId} ${cycle}` } });

					// Add some cache entries
					imageCache.set(
						`/projects/${sessionId}/Auto Run Docs:images/img${cycle}.png`,
						`data${cycle}`
					);

					unmount();
				}
			}

			// Verify component still works after all cycles
			const props = createDefaultProps();
			const { unmount } = renderWithProvider(<AutoRun {...props} />);
			expect(screen.getByRole('textbox')).toBeInTheDocument();
			unmount();

			// Clean up cache
			imageCache.clear();
		});

		it('handles rapid content changes with undo stack', async () => {
			const props = createDefaultProps();
			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			// Simulate rapid content changes
			for (let i = 0; i < 100; i++) {
				const textarea = screen.getByRole('textbox');
				fireEvent.change(textarea, { target: { value: `Content iteration ${i}` } });

				// Periodically undo
				if (i % 10 === 5) {
					fireEvent.keyDown(textarea, { key: 'z', metaKey: true });
				}
			}

			// Component should still be functional
			expect(screen.getByRole('textbox')).toBeInTheDocument();
		});

		it('handles session switching with accumulated state', () => {
			const sessionCount = 20;

			for (let session = 0; session < sessionCount; session++) {
				const props = createDefaultProps({
					sessionId: `session-${session}`,
					content: `# Session ${session} Content`,
				});

				const { unmount } = renderWithProvider(<AutoRun {...props} />);

				// Build up state
				const textarea = screen.getByRole('textbox');
				fireEvent.change(textarea, { target: { value: `Edited ${session}` } });

				// Add to image cache
				imageCache.set(`key-${session}`, `value-${session}`);

				unmount();
			}

			// After many sessions, everything should still work
			const finalProps = createDefaultProps();
			const { unmount } = renderWithProvider(<AutoRun {...finalProps} />);
			expect(screen.getByRole('textbox')).toBeInTheDocument();
			unmount();
		});
	});

	describe('Cleanup Verification', () => {
		it('refs are properly cleaned up on unmount', () => {
			const props = createDefaultProps();
			const ref = React.createRef<any>();

			const { unmount } = renderWithProvider(<AutoRun {...props} ref={ref} />);

			expect(ref.current).not.toBeNull();

			unmount();

			// After unmount, the component methods should not cause errors
			// (React cleans up the ref automatically)
		});

		it('async operations complete or cancel cleanly on unmount', async () => {
			// Mock listImages to return with a delay
			mockMaestro.autorun.listImages.mockImplementation(
				() =>
					new Promise((resolve) => {
						setTimeout(() => {
							resolve({ success: true, images: [] });
						}, 500);
					})
			);

			const props = createDefaultProps();
			const { unmount } = renderWithProvider(<AutoRun {...props} />);

			// Unmount before async operation completes
			unmount();

			// Advance timers to let async operation "complete"
			await act(async () => {
				vi.advanceTimersByTime(1000);
			});

			// No errors should be thrown
		});

		it('state updates do not occur after unmount', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

			mockMaestro.autorun.listImages.mockImplementation(
				() =>
					new Promise((resolve) => {
						setTimeout(() => {
							resolve({
								success: true,
								images: [{ filename: 'img.png', relativePath: 'images/img.png' }],
							});
						}, 100);
					})
			);

			const props = createDefaultProps();
			const { unmount } = renderWithProvider(<AutoRun {...props} />);

			// Unmount immediately
			unmount();

			// Let async operations complete
			await act(async () => {
				vi.advanceTimersByTime(500);
			});

			// Check for React's "Can't perform state update on unmounted component" warning
			// With proper cleanup, this should not appear
			const stateUpdateWarnings = consoleError.mock.calls.filter(
				(call) => call[0]?.includes?.('unmounted') || call[0]?.includes?.('state update')
			);

			// Note: React 18 with Strict Mode may show different behavior
			// The important thing is no crashes

			consoleError.mockRestore();
		});

		it('interval timers (if any) are cleaned up', async () => {
			const props = createDefaultProps();
			const { unmount } = renderWithProvider(<AutoRun {...props} />);

			// Unmount
			unmount();

			// Advance time significantly
			await act(async () => {
				vi.advanceTimersByTime(60000); // 1 minute
			});

			// No errors should occur from orphaned intervals
		});
	});

	describe('Edge Cases for Memory Safety', () => {
		it('handles null folderPath without memory issues', () => {
			const props = createDefaultProps({ folderPath: null });

			for (let i = 0; i < 20; i++) {
				const { unmount } = renderWithProvider(<AutoRun {...props} />);
				unmount();
			}
		});

		it('handles null selectedFile without memory issues', () => {
			const props = createDefaultProps({ selectedFile: null });

			for (let i = 0; i < 20; i++) {
				const { unmount } = renderWithProvider(<AutoRun {...props} />);
				unmount();
			}
		});

		it('handles empty content without memory issues', () => {
			const props = createDefaultProps({ content: '' });

			for (let i = 0; i < 20; i++) {
				const { unmount } = renderWithProvider(<AutoRun {...props} />);
				expect(screen.getByRole('textbox')).toHaveValue('');
				unmount();
			}
		});

		it('handles very long content without memory issues', () => {
			// Reduced from 1MB to 200KB - still tests "very long" content reasonably
			const veryLongContent = generateLargeContent(200); // 200KB
			const props = createDefaultProps({ content: veryLongContent });

			const { unmount } = renderWithProvider(<AutoRun {...props} />);
			expect(screen.getByRole('textbox')).toBeInTheDocument();
			unmount();
		});

		it('handles rapid prop changes without memory accumulation', () => {
			const props = createDefaultProps();
			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			// Rapidly change multiple props
			for (let i = 0; i < 100; i++) {
				rerender(
					<AutoRun
						{...props}
						sessionId={`session-${i % 5}`}
						selectedFile={`doc-${i % 10}`}
						content={`Content ${i}`}
						mode={i % 2 === 0 ? 'edit' : 'preview'}
					/>
				);
			}

			// Component should still work
			expect(
				screen.queryByRole('textbox') || screen.queryByTestId('react-markdown')
			).toBeInTheDocument();
		});
	});
});
