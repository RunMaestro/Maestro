/**
 * @file useAutoRunScrollSync.test.ts
 * @description Unit tests for the useAutoRunScrollSync hook
 *
 * Tests cover:
 * - switchMode does nothing when newMode equals current mode
 * - switchMode calls setMode with the new mode
 * - toggleMode toggles from edit to preview
 * - toggleMode toggles from preview to edit
 * - switchMode calls onStateChange with the new mode state
 * - handlePreviewScroll is a function
 * - switchMode does not call setMode when mode is the same
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useAutoRunScrollSync,
	type UseAutoRunScrollSyncParams,
} from '../../../renderer/hooks/batch/useAutoRunScrollSync';

// Mock requestAnimationFrame to execute callbacks synchronously
const originalRAF = globalThis.requestAnimationFrame;
beforeEach(() => {
	globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
		cb(0);
		return 0;
	};
});
afterEach(() => {
	globalThis.requestAnimationFrame = originalRAF;
});

// ============================================================================
// Test Helpers
// ============================================================================

const createParams = (
	overrides: Partial<UseAutoRunScrollSyncParams> = {}
): UseAutoRunScrollSyncParams => ({
	mode: 'edit' as const,
	setMode: vi.fn(),
	textareaRef: { current: null },
	previewRef: { current: null },
	localContent: 'test content',
	searchOpen: false,
	searchQuery: '',
	initialCursorPosition: 0,
	initialEditScrollPos: 0,
	initialPreviewScrollPos: 0,
	onStateChange: vi.fn(),
	...overrides,
});

// ============================================================================
// Tests
// ============================================================================

describe('useAutoRunScrollSync', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('switchMode', () => {
		it('does nothing when newMode equals current mode', () => {
			const params = createParams({ mode: 'edit' });
			const { result } = renderHook(() => useAutoRunScrollSync(params));

			act(() => {
				result.current.switchMode('edit');
			});

			expect(params.setMode).not.toHaveBeenCalled();
			expect(params.onStateChange).not.toHaveBeenCalled();
		});

		it('calls setMode with the new mode', () => {
			const params = createParams({ mode: 'edit' });
			const { result } = renderHook(() => useAutoRunScrollSync(params));

			act(() => {
				result.current.switchMode('preview');
			});

			expect(params.setMode).toHaveBeenCalledWith('preview');
		});

		it('calls onStateChange with the new mode state', () => {
			const params = createParams({ mode: 'edit' });
			const { result } = renderHook(() => useAutoRunScrollSync(params));

			act(() => {
				result.current.switchMode('preview');
			});

			expect(params.onStateChange).toHaveBeenCalledWith({
				mode: 'preview',
				cursorPosition: 0,
				editScrollPos: 0,
				previewScrollPos: 0,
			});
		});

		it('does not call setMode when mode is the same (preview to preview)', () => {
			const params = createParams({ mode: 'preview' });
			const { result } = renderHook(() => useAutoRunScrollSync(params));

			act(() => {
				result.current.switchMode('preview');
			});

			expect(params.setMode).not.toHaveBeenCalled();
		});

		it('calls setMode when switching from preview to edit', () => {
			const params = createParams({ mode: 'preview' });
			const { result } = renderHook(() => useAutoRunScrollSync(params));

			act(() => {
				result.current.switchMode('edit');
			});

			expect(params.setMode).toHaveBeenCalledWith('edit');
		});

		it('does not call onStateChange when mode is the same', () => {
			const params = createParams({ mode: 'edit' });
			const { result } = renderHook(() => useAutoRunScrollSync(params));

			act(() => {
				result.current.switchMode('edit');
			});

			expect(params.onStateChange).not.toHaveBeenCalled();
		});

		it('works without onStateChange callback', () => {
			const params = createParams({ mode: 'edit', onStateChange: undefined });
			const { result } = renderHook(() => useAutoRunScrollSync(params));

			// Should not throw
			act(() => {
				result.current.switchMode('preview');
			});

			expect(params.setMode).toHaveBeenCalledWith('preview');
		});
	});

	describe('toggleMode', () => {
		it('toggles from edit to preview', () => {
			const params = createParams({ mode: 'edit' });
			const { result } = renderHook(() => useAutoRunScrollSync(params));

			act(() => {
				result.current.toggleMode();
			});

			expect(params.setMode).toHaveBeenCalledWith('preview');
		});

		it('toggles from preview to edit', () => {
			const params = createParams({ mode: 'preview' });
			const { result } = renderHook(() => useAutoRunScrollSync(params));

			act(() => {
				result.current.toggleMode();
			});

			expect(params.setMode).toHaveBeenCalledWith('edit');
		});
	});

	describe('handlePreviewScroll', () => {
		it('is a function', () => {
			const params = createParams();
			const { result } = renderHook(() => useAutoRunScrollSync(params));

			expect(typeof result.current.handlePreviewScroll).toBe('function');
		});
	});
});
