/**
 * Tests for useOutputSearchMatching - DOM text scan + match navigation.
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { useOutputSearchMatching } from '../../../renderer/hooks/ui/useOutputSearchMatching';

function mountContainer(html: string): HTMLDivElement {
	const el = document.createElement('div');
	el.innerHTML = html;
	document.body.appendChild(el);
	return el;
}

describe('useOutputSearchMatching', () => {
	it('counts plain-text matches in the container and advances with goToNextMatch', async () => {
		const container = mountContainer('<p>alpha beta alpha</p>');
		const { result, unmount } = renderHook(() => {
			const containerRef = useRef<HTMLElement | null>(container);
			return useOutputSearchMatching({
				containerRef,
				outputSearchOpen: true,
				outputSearchRegex: false,
				debouncedSearchQuery: 'alpha',
				contentRevision: 1,
			});
		});

		await waitFor(() => {
			expect(result.current.totalMatches).toBe(2);
		});
		expect(result.current.currentMatchIndex).toBe(0);

		act(() => {
			result.current.goToNextMatch();
		});
		expect(result.current.currentMatchIndex).toBe(1);

		act(() => {
			result.current.goToNextMatch();
		});
		expect(result.current.currentMatchIndex).toBe(0);

		unmount();
		container.remove();
	});

	it('reports zero matches and clears when the query is empty', async () => {
		const container = mountContainer('<p>hello world</p>');
		const { result, unmount } = renderHook(() => {
			const containerRef = useRef<HTMLElement | null>(container);
			return useOutputSearchMatching({
				containerRef,
				outputSearchOpen: true,
				outputSearchRegex: false,
				debouncedSearchQuery: '   ',
				contentRevision: 1,
			});
		});

		await waitFor(() => {
			expect(result.current.totalMatches).toBe(0);
		});
		expect(result.current.regexError).toBeNull();

		unmount();
		container.remove();
	});

	it('rescans when contentRevision changes after the DOM text updates', async () => {
		const container = mountContainer('<p>alpha</p>');
		const { result, rerender, unmount } = renderHook(
			({ contentRevision }: { contentRevision: number }) => {
				const containerRef = useRef<HTMLElement | null>(container);
				return useOutputSearchMatching({
					containerRef,
					outputSearchOpen: true,
					outputSearchRegex: false,
					debouncedSearchQuery: 'alpha',
					contentRevision,
				});
			},
			{ initialProps: { contentRevision: 1 } }
		);

		await waitFor(() => {
			expect(result.current.totalMatches).toBe(1);
		});

		container.innerHTML = '<p>alpha alpha</p>';
		rerender({ contentRevision: 2 });

		await waitFor(() => {
			expect(result.current.totalMatches).toBe(2);
		});

		unmount();
		container.remove();
	});

	it('sets regexError and reports zero matches for an invalid regex', async () => {
		const container = mountContainer('<p>alpha</p>');
		const { result, unmount } = renderHook(() => {
			const containerRef = useRef<HTMLElement | null>(container);
			return useOutputSearchMatching({
				containerRef,
				outputSearchOpen: true,
				outputSearchRegex: true,
				debouncedSearchQuery: '[',
				contentRevision: 1,
			});
		});

		await waitFor(() => {
			expect(result.current.regexError).toBeTruthy();
		});
		expect(result.current.totalMatches).toBe(0);

		unmount();
		container.remove();
	});

	it('selects the match inside the jumped-to row', async () => {
		const container = mountContainer(
			'<div data-log-id="a">alpha</div><div data-log-id="b">alpha</div>'
		);
		const jumpRef = { current: 'b' as string | null };
		const { result, unmount } = renderHook(() => {
			const containerRef = useRef<HTMLElement | null>(container);
			return useOutputSearchMatching({
				containerRef,
				outputSearchOpen: true,
				outputSearchRegex: false,
				debouncedSearchQuery: 'alpha',
				contentRevision: 1,
				pendingJumpMatchIdRef: jumpRef,
				jumpIdAttribute: 'data-log-id',
			});
		});

		await waitFor(() => {
			expect(result.current.currentMatchIndex).toBe(1);
		});
		expect(jumpRef.current).toBeNull();

		unmount();
		container.remove();
	});
});
