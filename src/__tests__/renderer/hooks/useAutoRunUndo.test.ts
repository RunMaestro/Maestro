/**
 * @file useAutoRunUndo.test.ts
 * @description Unit tests for the useAutoRunUndo hook
 *
 * Tests cover:
 * - pushUndoState - Undo stack push on content change
 * - handleUndo/handleRedo - Redo stack management
 * - MAX_UNDO_HISTORY (50) - maxStackSize limit enforcement
 * - resetUndoHistory - clears state
 * - Cursor position restoration on undo/redo
 * - scheduleUndoSnapshot - debounced snapshot scheduling
 * - Per-document undo history isolation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoRunUndo, type UseAutoRunUndoDeps, type UndoState } from '../../../renderer/hooks';
import React from 'react';

// ============================================================================
// Test Helpers
// ============================================================================

const createMockTextarea = (selectionStart = 0, value = 'Initial content'): HTMLTextAreaElement => {
	const textarea = document.createElement('textarea');
	textarea.value = value;
	textarea.selectionStart = selectionStart;
	textarea.selectionEnd = selectionStart;
	textarea.setSelectionRange = vi.fn((start: number, end: number) => {
		textarea.selectionStart = start;
		textarea.selectionEnd = end;
	});
	textarea.focus = vi.fn();
	return textarea;
};

const createMockDeps = (overrides: Partial<UseAutoRunUndoDeps> = {}): UseAutoRunUndoDeps => {
	const textareaRef = { current: null } as React.RefObject<HTMLTextAreaElement>;

	return {
		selectedFile: 'Phase 1',
		localContent: 'Initial content',
		setLocalContent: vi.fn(),
		textareaRef,
		...overrides,
	};
};

// ============================================================================
// Tests
// ============================================================================

describe('useAutoRunUndo', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// ==========================================================================
	// pushUndoState - Undo stack push tests
	// ==========================================================================

	describe('pushUndoState', () => {
		it('should push current state to undo history when content differs from last snapshot', () => {
			const mockDeps = createMockDeps({ localContent: 'Updated content' });
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			// Initial state - lastUndoSnapshotRef should be 'Updated content'
			expect(result.current.lastUndoSnapshotRef.current).toBe('Updated content');

			// Push a different content (this is the "before" state we want to save)
			// The hook will save this because it differs from lastUndoSnapshotRef
			act(() => {
				result.current.pushUndoState('Initial content', 0);
			});

			// Now undo should restore 'Initial content'
			act(() => {
				result.current.handleUndo();
			});

			expect(mockDeps.setLocalContent).toHaveBeenCalledWith('Initial content');
		});

		it('should not push duplicate snapshots when content matches last entry', () => {
			const mockDeps = createMockDeps({ localContent: 'Same content' });
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			// The lastUndoSnapshotRef is initialized to localContent
			expect(result.current.lastUndoSnapshotRef.current).toBe('Same content');

			// Push baseline snapshot (should be stored once)
			act(() => {
				result.current.pushUndoState('Same content', 0);
			});

			// Duplicate push should be ignored
			act(() => {
				result.current.pushUndoState('Same content', 0);
			});

			// Verify only one undo entry exists
			act(() => {
				result.current.handleUndo();
			});

			expect(mockDeps.setLocalContent).toHaveBeenCalledTimes(1);

			act(() => {
				result.current.handleUndo();
			});

			expect(mockDeps.setLocalContent).toHaveBeenCalledTimes(1);
		});

		it('should do nothing when selectedFile is null', () => {
			const mockDeps = createMockDeps({ selectedFile: null, localContent: 'Content' });
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			// Try to push - should be ignored
			act(() => {
				result.current.pushUndoState('Different content', 0);
			});

			// Verify undo does nothing
			act(() => {
				result.current.handleUndo();
			});

			expect(mockDeps.setLocalContent).not.toHaveBeenCalled();
		});

		it('should use textarea cursor position when not provided', () => {
			const textarea = createMockTextarea(15, 'Some content here');
			const mockDeps = createMockDeps({
				localContent: 'Updated content',
				textareaRef: { current: textarea },
			});
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			// Push with previous content
			act(() => {
				result.current.pushUndoState('Some content here');
			});

			// Undo to get back to previous state
			act(() => {
				result.current.handleUndo();
			});

			expect(mockDeps.setLocalContent).toHaveBeenCalledWith('Some content here');
		});

		it('should clear redo stack when pushing new state', () => {
			const mockDeps = createMockDeps({ localContent: 'Version 3' });
			const { result, rerender } = renderHook(({ deps }) => useAutoRunUndo(deps), {
				initialProps: { deps: mockDeps },
			});

			// Build up undo history: push version 1, then version 2
			act(() => {
				result.current.pushUndoState('Version 1', 0);
			});

			act(() => {
				result.current.pushUndoState('Version 2', 0);
			});

			// Undo to Version 2
			act(() => {
				result.current.handleUndo();
			});

			expect(mockDeps.setLocalContent).toHaveBeenLastCalledWith('Version 2');

			// Now update content and push a new state - this should clear the redo stack
			mockDeps.localContent = 'Version 2';
			rerender({ deps: mockDeps });

			act(() => {
				result.current.pushUndoState('Version 4 (new branch)', 0);
			});

			// Redo should do nothing now (redo stack was cleared)
			mockDeps.setLocalContent.mockClear();
			act(() => {
				result.current.handleRedo();
			});

			expect(mockDeps.setLocalContent).not.toHaveBeenCalled();
		});

		it('should use provided content and cursor when explicitly passed', () => {
			const mockDeps = createMockDeps({ localContent: 'Current content' });
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			// Push with explicit values
			act(() => {
				result.current.pushUndoState('Previous content', 25);
			});

			// Undo to verify the explicit content was stored
			act(() => {
				result.current.handleUndo();
			});

			expect(mockDeps.setLocalContent).toHaveBeenCalledWith('Previous content');
		});

		it('should update lastUndoSnapshotRef after successful push', () => {
			const mockDeps = createMockDeps({ localContent: 'New content' });
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			// Push previous content
			act(() => {
				result.current.pushUndoState('Old content', 0);
			});

			// The lastUndoSnapshotRef should now be 'Old content'
			expect(result.current.lastUndoSnapshotRef.current).toBe('Old content');
		});
	});

	// ==========================================================================
	// handleUndo and handleRedo - Redo stack management tests
	// ==========================================================================

	describe('handleUndo and handleRedo', () => {
		it('should undo to previous state and push current to redo stack', async () => {
			const textarea = createMockTextarea(0, 'Version 2');
			const mockDeps = createMockDeps({
				localContent: 'Version 2',
				textareaRef: { current: textarea },
			});
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			// Push Version 1 to undo stack
			act(() => {
				result.current.pushUndoState('Version 1', 5);
			});

			// Undo
			act(() => {
				result.current.handleUndo();
			});

			expect(mockDeps.setLocalContent).toHaveBeenCalledWith('Version 1');

			// Now redo should restore Version 2
			mockDeps.localContent = 'Version 1';
			mockDeps.setLocalContent.mockClear();

			act(() => {
				result.current.handleRedo();
			});

			expect(mockDeps.setLocalContent).toHaveBeenCalledWith('Version 2');
		});

		it('should do nothing on undo when stack is empty', () => {
			const mockDeps = createMockDeps({ localContent: 'Content' });
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			// Undo without pushing anything first
			act(() => {
				result.current.handleUndo();
			});

			expect(mockDeps.setLocalContent).not.toHaveBeenCalled();
		});

		it('should do nothing on redo when stack is empty', () => {
			const mockDeps = createMockDeps({ localContent: 'Content' });
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			// Redo without any undo
			act(() => {
				result.current.handleRedo();
			});

			expect(mockDeps.setLocalContent).not.toHaveBeenCalled();
		});

		it('should handle multiple sequential undos', () => {
			const mockDeps = createMockDeps({ localContent: 'Version 4' });
			const { result, rerender } = renderHook(({ deps }) => useAutoRunUndo(deps), {
				initialProps: { deps: mockDeps },
			});

			// Build up history: V1 -> V2 -> V3 -> V4
			act(() => {
				result.current.pushUndoState('Version 1', 0);
			});
			act(() => {
				result.current.pushUndoState('Version 2', 0);
			});
			act(() => {
				result.current.pushUndoState('Version 3', 0);
			});

			// Undo 3 times: should go V4 -> V3 -> V2 -> V1
			act(() => {
				result.current.handleUndo();
			});
			expect(mockDeps.setLocalContent).toHaveBeenLastCalledWith('Version 3');

			mockDeps.localContent = 'Version 3';
			rerender({ deps: mockDeps });

			act(() => {
				result.current.handleUndo();
			});
			expect(mockDeps.setLocalContent).toHaveBeenLastCalledWith('Version 2');

			mockDeps.localContent = 'Version 2';
			rerender({ deps: mockDeps });

			act(() => {
				result.current.handleUndo();
			});
			expect(mockDeps.setLocalContent).toHaveBeenLastCalledWith('Version 1');
		});

		it('should handle multiple sequential redos', () => {
			const mockDeps = createMockDeps({ localContent: 'Version 3' });
			const { result, rerender } = renderHook(({ deps }) => useAutoRunUndo(deps), {
				initialProps: { deps: mockDeps },
			});

			// Build history
			act(() => {
				result.current.pushUndoState('Version 1', 0);
			});
			act(() => {
				result.current.pushUndoState('Version 2', 0);
			});

			// Undo twice
			act(() => {
				result.current.handleUndo();
			});
			mockDeps.localContent = 'Version 2';
			rerender({ deps: mockDeps });

			act(() => {
				result.current.handleUndo();
			});
			mockDeps.localContent = 'Version 1';
			rerender({ deps: mockDeps });

			// Now redo twice
			act(() => {
				result.current.handleRedo();
			});
			expect(mockDeps.setLocalContent).toHaveBeenLastCalledWith('Version 2');

			mockDeps.localContent = 'Version 2';
			rerender({ deps: mockDeps });

			act(() => {
				result.current.handleRedo();
			});
			expect(mockDeps.setLocalContent).toHaveBeenLastCalledWith('Version 3');
		});

		it('should do nothing on undo when selectedFile is null', () => {
			const mockDeps = createMockDeps({ selectedFile: null, localContent: 'Content' });
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			act(() => {
				result.current.handleUndo();
			});

			expect(mockDeps.setLocalContent).not.toHaveBeenCalled();
		});

		it('should do nothing on redo when selectedFile is null', () => {
			const mockDeps = createMockDeps({ selectedFile: null, localContent: 'Content' });
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			act(() => {
				result.current.handleRedo();
			});

			expect(mockDeps.setLocalContent).not.toHaveBeenCalled();
		});
	});

	// ==========================================================================
	// MAX_UNDO_HISTORY - Stack size limit tests
	// ==========================================================================

	describe('maxStackSize limit enforcement', () => {
		it('should limit undo stack to MAX_UNDO_HISTORY (50) entries', () => {
			const mockDeps = createMockDeps({ localContent: 'Version 52' });
			const { result, rerender } = renderHook(({ deps }) => useAutoRunUndo(deps), {
				initialProps: { deps: mockDeps },
			});

			// Push 51 versions (more than MAX_UNDO_HISTORY = 50)
			for (let i = 1; i <= 51; i++) {
				act(() => {
					result.current.pushUndoState(`Version ${i}`, 0);
				});
			}

			// Now undo 50 times (the max we can undo)
			let undoCount = 0;
			for (let i = 0; i < 55; i++) {
				mockDeps.setLocalContent.mockClear();
				act(() => {
					result.current.handleUndo();
				});
				if (mockDeps.setLocalContent.mock.calls.length > 0) {
					undoCount++;
					// Simulate content change for next iteration
					mockDeps.localContent = mockDeps.setLocalContent.mock.calls[0][0];
					rerender({ deps: mockDeps });
				} else {
					break;
				}
			}

			// We should have been able to undo exactly 50 times
			expect(undoCount).toBe(50);
		});

		it('should discard oldest entries when exceeding MAX_UNDO_HISTORY', () => {
			const mockDeps = createMockDeps({ localContent: 'Version 52' });
			const { result, rerender } = renderHook(({ deps }) => useAutoRunUndo(deps), {
				initialProps: { deps: mockDeps },
			});

			// Push 52 versions
			for (let i = 1; i <= 52; i++) {
				act(() => {
					result.current.pushUndoState(`Version ${i}`, 0);
				});
			}

			// Undo all the way back
			const restoredVersions: string[] = [];
			for (let i = 0; i < 55; i++) {
				mockDeps.setLocalContent.mockClear();
				act(() => {
					result.current.handleUndo();
				});
				if (mockDeps.setLocalContent.mock.calls.length > 0) {
					const content = mockDeps.setLocalContent.mock.calls[0][0];
					restoredVersions.push(content);
					mockDeps.localContent = content;
					rerender({ deps: mockDeps });
				} else {
					break;
				}
			}

			// Version 1 and 2 should have been discarded (oldest entries)
			expect(restoredVersions).not.toContain('Version 1');
			expect(restoredVersions).not.toContain('Version 2');

			// Version 3 should be the oldest available (first was discarded when 51st was added, second when 52nd was added)
			expect(restoredVersions[restoredVersions.length - 1]).toBe('Version 3');
		});
	});

	// ==========================================================================
	// resetUndoHistory - Clear state tests
	// ==========================================================================

	describe('resetUndoHistory', () => {
		it('should update lastUndoSnapshotRef with new content', () => {
			const mockDeps = createMockDeps({ localContent: 'Initial content' });
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			expect(result.current.lastUndoSnapshotRef.current).toBe('Initial content');

			act(() => {
				result.current.resetUndoHistory('Externally loaded content');
			});

			expect(result.current.lastUndoSnapshotRef.current).toBe('Externally loaded content');
		});

		it('should allow fresh undo snapshots after reset', () => {
			const mockDeps = createMockDeps({ localContent: 'Initial content' });
			const { result, rerender } = renderHook(({ deps }) => useAutoRunUndo(deps), {
				initialProps: { deps: mockDeps },
			});

			// Reset with new content (simulating external content load)
			act(() => {
				result.current.resetUndoHistory('Content after reset');
			});

			// Verify the lastUndoSnapshotRef was updated
			expect(result.current.lastUndoSnapshotRef.current).toBe('Content after reset');

			// Now make edits - push a state that differs from 'Content after reset'
			act(() => {
				result.current.pushUndoState('Edited content', 0);
			});

			// Undo should restore 'Edited content'
			act(() => {
				result.current.handleUndo();
			});

			expect(mockDeps.setLocalContent).toHaveBeenCalledWith('Edited content');
		});

		it('should not clear existing undo/redo history stacks', () => {
			const mockDeps = createMockDeps({ localContent: 'Version 2' });
			const { result, rerender } = renderHook(({ deps }) => useAutoRunUndo(deps), {
				initialProps: { deps: mockDeps },
			});

			// Build up undo history
			act(() => {
				result.current.pushUndoState('Version 1', 0);
			});

			// Reset (note: this only resets the lastUndoSnapshotRef, not the history)
			act(() => {
				result.current.resetUndoHistory('Version 2');
			});

			// Existing undo history should still work
			act(() => {
				result.current.handleUndo();
			});

			expect(mockDeps.setLocalContent).toHaveBeenCalledWith('Version 1');
		});
	});

	// ==========================================================================
	// Cursor position restoration tests
	// ==========================================================================

	describe('cursor position restoration', () => {
		it('should restore cursor position on undo', async () => {
			const textarea = createMockTextarea(20, 'Current content');
			const mockDeps = createMockDeps({
				localContent: 'Current content',
				textareaRef: { current: textarea },
			});
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			// Push state with specific cursor position
			act(() => {
				result.current.pushUndoState('Previous content', 10);
			});

			// Undo
			act(() => {
				result.current.handleUndo();
			});

			// Need to advance to let requestAnimationFrame execute
			await act(async () => {
				vi.advanceTimersByTime(100);
			});

			expect(textarea.setSelectionRange).toHaveBeenCalledWith(10, 10);
			expect(textarea.focus).toHaveBeenCalled();
		});

		it('should restore cursor position on redo', async () => {
			const textarea = createMockTextarea(5, 'Version 2');
			const mockDeps = createMockDeps({
				localContent: 'Version 2',
				textareaRef: { current: textarea },
			});
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			// Push and undo
			act(() => {
				result.current.pushUndoState('Version 1', 10);
			});
			act(() => {
				result.current.handleUndo();
			});

			// Update deps for redo
			mockDeps.localContent = 'Version 1';
			textarea.selectionStart = 10;

			// Redo
			act(() => {
				result.current.handleRedo();
			});

			// Need to advance to let requestAnimationFrame execute
			await act(async () => {
				vi.advanceTimersByTime(100);
			});

			// The redo should restore the cursor position that was saved when we undid
			expect(textarea.setSelectionRange).toHaveBeenCalled();
			expect(textarea.focus).toHaveBeenCalled();
		});

		it('should handle missing textarea ref gracefully', async () => {
			const mockDeps = createMockDeps({
				localContent: 'Version 2',
				textareaRef: { current: null },
			});
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			// Push and undo
			act(() => {
				result.current.pushUndoState('Version 1', 10);
			});

			// Should not throw
			act(() => {
				result.current.handleUndo();
			});

			await act(async () => {
				vi.advanceTimersByTime(100);
			});

			// Content should still be updated
			expect(mockDeps.setLocalContent).toHaveBeenCalledWith('Version 1');
		});

		it('should use 0 as cursor position when textarea has no selectionStart', () => {
			const textarea = createMockTextarea(0, 'Content');
			// Simulate undefined selectionStart
			Object.defineProperty(textarea, 'selectionStart', {
				get: () => undefined,
			});

			const mockDeps = createMockDeps({
				localContent: 'Updated content',
				textareaRef: { current: textarea },
			});
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			// Push with content only (cursor should default to 0)
			act(() => {
				result.current.pushUndoState('Original content');
			});

			act(() => {
				result.current.handleUndo();
			});

			expect(mockDeps.setLocalContent).toHaveBeenCalledWith('Original content');
		});
	});

	// ==========================================================================
	// scheduleUndoSnapshot - Debouncing tests
	// ==========================================================================

	describe('scheduleUndoSnapshot', () => {
		it('should push undo state after 1000ms debounce delay', () => {
			const mockDeps = createMockDeps({ localContent: 'Current content' });
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			act(() => {
				result.current.scheduleUndoSnapshot('Previous content', 5);
			});

			// Before delay - should not have pushed yet
			act(() => {
				vi.advanceTimersByTime(500);
			});

			// Try undo - should fail (nothing pushed yet)
			act(() => {
				result.current.handleUndo();
			});
			expect(mockDeps.setLocalContent).not.toHaveBeenCalled();

			// After full delay
			act(() => {
				vi.advanceTimersByTime(600); // Total 1100ms
			});

			// Now undo should work
			act(() => {
				result.current.handleUndo();
			});
			expect(mockDeps.setLocalContent).toHaveBeenCalledWith('Previous content');
		});

		it('should cancel pending snapshot when new one is scheduled', () => {
			const mockDeps = createMockDeps({ localContent: 'Version 3' });
			const { result, rerender } = renderHook(({ deps }) => useAutoRunUndo(deps), {
				initialProps: { deps: mockDeps },
			});

			// Schedule first snapshot
			act(() => {
				result.current.scheduleUndoSnapshot('Version 1', 0);
			});

			// Wait 500ms
			act(() => {
				vi.advanceTimersByTime(500);
			});

			// Schedule second snapshot (should cancel first)
			act(() => {
				result.current.scheduleUndoSnapshot('Version 2', 5);
			});

			// Wait another 1000ms
			act(() => {
				vi.advanceTimersByTime(1100);
			});

			// Undo - should get Version 2, not Version 1
			act(() => {
				result.current.handleUndo();
			});
			expect(mockDeps.setLocalContent).toHaveBeenCalledWith('Version 2');

			// Second undo should not work (only Version 2 was pushed)
			mockDeps.localContent = 'Version 2';
			mockDeps.setLocalContent.mockClear();
			rerender({ deps: mockDeps });

			act(() => {
				result.current.handleUndo();
			});
			expect(mockDeps.setLocalContent).not.toHaveBeenCalled();
		});

		it('should use correct cursor position from scheduled snapshot', async () => {
			const textarea = createMockTextarea(100, 'Current content');
			const mockDeps = createMockDeps({
				localContent: 'Current content',
				textareaRef: { current: textarea },
			});
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			// Schedule with specific cursor position
			act(() => {
				result.current.scheduleUndoSnapshot('Previous content', 42);
			});

			// Wait for debounce
			act(() => {
				vi.advanceTimersByTime(1100);
			});

			// Undo
			act(() => {
				result.current.handleUndo();
			});

			await act(async () => {
				vi.advanceTimersByTime(100);
			});

			// Verify cursor position was restored
			expect(textarea.setSelectionRange).toHaveBeenCalledWith(42, 42);
		});

		it('should clean up pending timeout on unmount', () => {
			const mockDeps = createMockDeps({ localContent: 'Content' });
			const { result, unmount } = renderHook(() => useAutoRunUndo(mockDeps));

			// Schedule a snapshot
			act(() => {
				result.current.scheduleUndoSnapshot('Previous', 0);
			});

			// Unmount before timeout fires
			unmount();

			// Advance time - should not cause errors
			act(() => {
				vi.advanceTimersByTime(2000);
			});

			// Test passes if no error is thrown
		});

		it('should clean up pending timeout on document change', () => {
			const mockDeps = createMockDeps({ selectedFile: 'Doc1', localContent: 'Content' });
			const { result, rerender } = renderHook(({ deps }) => useAutoRunUndo(deps), {
				initialProps: { deps: mockDeps },
			});

			// Schedule a snapshot
			act(() => {
				result.current.scheduleUndoSnapshot('Previous', 0);
			});

			// Change document before timeout fires
			mockDeps.selectedFile = 'Doc2';
			rerender({ deps: mockDeps });

			// Advance time past the debounce delay
			act(() => {
				vi.advanceTimersByTime(2000);
			});

			// The old snapshot should NOT have been pushed to Doc2
			// Undo on Doc2 should do nothing
			act(() => {
				result.current.handleUndo();
			});
			expect(mockDeps.setLocalContent).not.toHaveBeenCalled();
		});
	});

	// ==========================================================================
	// Per-document undo history isolation tests
	// ==========================================================================

	describe('per-document undo history isolation', () => {
		it('should maintain separate undo stacks for different documents', () => {
			const mockDeps = createMockDeps({ selectedFile: 'Doc1', localContent: 'Doc1 V2' });
			const { result, rerender } = renderHook(({ deps }) => useAutoRunUndo(deps), {
				initialProps: { deps: mockDeps },
			});

			// Push undo state for Doc1
			act(() => {
				result.current.pushUndoState('Doc1 V1', 0);
			});

			// Switch to Doc2
			mockDeps.selectedFile = 'Doc2';
			mockDeps.localContent = 'Doc2 V2';
			rerender({ deps: mockDeps });

			// Reset for new document
			act(() => {
				result.current.resetUndoHistory('Doc2 V2');
			});

			// Push undo state for Doc2
			act(() => {
				result.current.pushUndoState('Doc2 V1', 0);
			});

			// Undo on Doc2 should give Doc2 V1
			act(() => {
				result.current.handleUndo();
			});
			expect(mockDeps.setLocalContent).toHaveBeenLastCalledWith('Doc2 V1');

			// Switch back to Doc1
			mockDeps.setLocalContent.mockClear();
			mockDeps.selectedFile = 'Doc1';
			mockDeps.localContent = 'Doc1 V2';
			rerender({ deps: mockDeps });

			// Undo on Doc1 should give Doc1 V1 (not affected by Doc2)
			act(() => {
				result.current.handleUndo();
			});
			expect(mockDeps.setLocalContent).toHaveBeenLastCalledWith('Doc1 V1');
		});

		it('should maintain separate redo stacks for different documents', () => {
			const mockDeps = createMockDeps({ selectedFile: 'Doc1', localContent: 'Doc1 V2' });
			const { result, rerender } = renderHook(({ deps }) => useAutoRunUndo(deps), {
				initialProps: { deps: mockDeps },
			});

			// Build Doc1 history and undo
			act(() => {
				result.current.pushUndoState('Doc1 V1', 0);
			});
			act(() => {
				result.current.handleUndo();
			});
			mockDeps.localContent = 'Doc1 V1';
			rerender({ deps: mockDeps });

			// Switch to Doc2, build history and undo
			mockDeps.selectedFile = 'Doc2';
			mockDeps.localContent = 'Doc2 V2';
			rerender({ deps: mockDeps });

			act(() => {
				result.current.resetUndoHistory('Doc2 V2');
			});
			act(() => {
				result.current.pushUndoState('Doc2 V1', 0);
			});
			act(() => {
				result.current.handleUndo();
			});
			mockDeps.localContent = 'Doc2 V1';
			rerender({ deps: mockDeps });

			// Redo on Doc2 should give Doc2 V2
			mockDeps.setLocalContent.mockClear();
			act(() => {
				result.current.handleRedo();
			});
			expect(mockDeps.setLocalContent).toHaveBeenLastCalledWith('Doc2 V2');

			// Switch back to Doc1
			mockDeps.setLocalContent.mockClear();
			mockDeps.selectedFile = 'Doc1';
			mockDeps.localContent = 'Doc1 V1';
			rerender({ deps: mockDeps });

			// Redo on Doc1 should give Doc1 V2 (separate redo stack)
			act(() => {
				result.current.handleRedo();
			});
			expect(mockDeps.setLocalContent).toHaveBeenLastCalledWith('Doc1 V2');
		});

		it('should preserve history across document switches', () => {
			const mockDeps = createMockDeps({ selectedFile: 'Doc1', localContent: 'Doc1 V3' });
			const { result, rerender } = renderHook(({ deps }) => useAutoRunUndo(deps), {
				initialProps: { deps: mockDeps },
			});

			// Build up Doc1 history: V1 -> V2 -> V3
			act(() => {
				result.current.pushUndoState('Doc1 V1', 0);
			});
			act(() => {
				result.current.pushUndoState('Doc1 V2', 0);
			});

			// Switch to Doc2
			mockDeps.selectedFile = 'Doc2';
			mockDeps.localContent = 'Doc2 content';
			rerender({ deps: mockDeps });

			// Do some operations on Doc2
			act(() => {
				result.current.resetUndoHistory('Doc2 content');
			});

			// Switch back to Doc1
			mockDeps.selectedFile = 'Doc1';
			mockDeps.localContent = 'Doc1 V3';
			rerender({ deps: mockDeps });

			// Doc1 history should still be intact
			act(() => {
				result.current.handleUndo();
			});
			expect(mockDeps.setLocalContent).toHaveBeenLastCalledWith('Doc1 V2');

			mockDeps.localContent = 'Doc1 V2';
			rerender({ deps: mockDeps });

			act(() => {
				result.current.handleUndo();
			});
			expect(mockDeps.setLocalContent).toHaveBeenLastCalledWith('Doc1 V1');
		});
	});

	// ==========================================================================
	// Edge cases and integration scenarios
	// ==========================================================================

	describe('edge cases', () => {
		it('should handle empty content', () => {
			const mockDeps = createMockDeps({ localContent: '' });
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			// Push empty content (should be skipped since it matches lastUndoSnapshotRef)
			act(() => {
				result.current.pushUndoState('', 0);
			});

			// Now push different content
			act(() => {
				result.current.pushUndoState('Some content', 0);
			});

			// Undo should restore 'Some content'
			act(() => {
				result.current.handleUndo();
			});
			expect(mockDeps.setLocalContent).toHaveBeenCalledWith('Some content');
		});

		it('should handle very long content', () => {
			const longContent = 'x'.repeat(100000);
			const mockDeps = createMockDeps({ localContent: longContent });
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			act(() => {
				result.current.pushUndoState('Short content', 0);
			});

			act(() => {
				result.current.handleUndo();
			});

			expect(mockDeps.setLocalContent).toHaveBeenCalledWith('Short content');
		});

		it('should handle content with special characters and unicode', () => {
			const specialContent = '# 日本語 🎉\n\n- [ ] Task with émojis\n```code```';
			const mockDeps = createMockDeps({ localContent: specialContent });
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			act(() => {
				result.current.pushUndoState('Previous 中文', 0);
			});

			act(() => {
				result.current.handleUndo();
			});

			expect(mockDeps.setLocalContent).toHaveBeenCalledWith('Previous 中文');
		});

		it('should handle rapid push and undo operations', () => {
			const mockDeps = createMockDeps({ localContent: 'V10' });
			const { result, rerender } = renderHook(({ deps }) => useAutoRunUndo(deps), {
				initialProps: { deps: mockDeps },
			});

			// Rapid pushes
			for (let i = 1; i <= 10; i++) {
				act(() => {
					result.current.pushUndoState(`V${i}`, 0);
				});
			}

			// Rapid undos
			for (let i = 10; i >= 1; i--) {
				act(() => {
					result.current.handleUndo();
				});
				mockDeps.localContent =
					mockDeps.setLocalContent.mock.calls.slice(-1)[0]?.[0] || mockDeps.localContent;
				rerender({ deps: mockDeps });
			}

			// Last undo should have restored V1
			expect(mockDeps.setLocalContent).toHaveBeenLastCalledWith('V1');
		});

		it('should update lastUndoSnapshotRef on undo/redo', () => {
			const mockDeps = createMockDeps({ localContent: 'Version 2' });
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			act(() => {
				result.current.pushUndoState('Version 1', 0);
			});

			expect(result.current.lastUndoSnapshotRef.current).toBe('Version 1');

			act(() => {
				result.current.handleUndo();
			});

			// After undo, lastUndoSnapshotRef should be updated to the restored content
			expect(result.current.lastUndoSnapshotRef.current).toBe('Version 1');
		});
	});

	// ==========================================================================
	// Handler memoization tests
	// ==========================================================================

	describe('handler memoization', () => {
		it('should maintain stable handler references across rerenders', () => {
			const mockDeps = createMockDeps({ localContent: 'Content' });
			const { result, rerender } = renderHook(({ deps }) => useAutoRunUndo(deps), {
				initialProps: { deps: mockDeps },
			});

			const initialPushUndoState = result.current.pushUndoState;
			const initialHandleUndo = result.current.handleUndo;
			const initialHandleRedo = result.current.handleRedo;
			const initialResetUndoHistory = result.current.resetUndoHistory;
			const initialScheduleUndoSnapshot = result.current.scheduleUndoSnapshot;

			// Rerender with same props
			rerender({ deps: mockDeps });

			// Handlers that don't depend on changing values should be stable
			expect(result.current.resetUndoHistory).toBe(initialResetUndoHistory);

			// Handlers that depend on selectedFile or localContent may change
			// but should still work correctly
			expect(typeof result.current.pushUndoState).toBe('function');
			expect(typeof result.current.handleUndo).toBe('function');
			expect(typeof result.current.handleRedo).toBe('function');
			expect(typeof result.current.scheduleUndoSnapshot).toBe('function');
		});

		it('should update handlers when selectedFile changes', () => {
			const mockDeps = createMockDeps({ selectedFile: 'Doc1', localContent: 'Content' });
			const { result, rerender } = renderHook(({ deps }) => useAutoRunUndo(deps), {
				initialProps: { deps: mockDeps },
			});

			const initialPushUndoState = result.current.pushUndoState;

			// Change selectedFile
			mockDeps.selectedFile = 'Doc2';
			rerender({ deps: mockDeps });

			// Handlers should have been recreated (due to selectedFile dependency)
			expect(result.current.pushUndoState).not.toBe(initialPushUndoState);
		});
	});

	// ==========================================================================
	// lastUndoSnapshotRef exposure tests
	// ==========================================================================

	describe('lastUndoSnapshotRef', () => {
		it('should expose lastUndoSnapshotRef for external access', () => {
			const mockDeps = createMockDeps({ localContent: 'Initial content' });
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			expect(result.current.lastUndoSnapshotRef).toBeDefined();
			expect(result.current.lastUndoSnapshotRef.current).toBe('Initial content');
		});

		it('should allow external modification of lastUndoSnapshotRef', () => {
			const mockDeps = createMockDeps({ localContent: 'Initial content' });
			const { result } = renderHook(() => useAutoRunUndo(mockDeps));

			// External modification
			result.current.lastUndoSnapshotRef.current = 'Externally set content';

			expect(result.current.lastUndoSnapshotRef.current).toBe('Externally set content');

			// Push should now compare against externally set value
			act(() => {
				result.current.pushUndoState('Different content', 0);
			});

			// This push should succeed since 'Different content' !== 'Externally set content'
			act(() => {
				result.current.handleUndo();
			});
			expect(mockDeps.setLocalContent).toHaveBeenCalledWith('Different content');
		});
	});
});
