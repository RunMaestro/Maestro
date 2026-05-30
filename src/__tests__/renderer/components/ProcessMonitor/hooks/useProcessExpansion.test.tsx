import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProcessExpansion } from '../../../../../renderer/components/ProcessMonitor/hooks/useProcessExpansion';
import type { ProcessNode } from '../../../../../renderer/components/ProcessMonitor/types';

const tree3: ProcessNode[] = [
	{
		id: 'g',
		type: 'group',
		label: 'g',
		children: [
			{
				id: 's',
				type: 'session',
				label: 's',
				children: [{ id: 'p', type: 'process', label: 'p' }],
			},
		],
	},
];

const tree4: ProcessNode[] = [
	{
		id: 'g',
		type: 'group',
		label: 'g',
		children: [
			{
				id: 's',
				type: 'session',
				label: 's',
				children: [
					{
						id: 'p',
						type: 'process',
						label: 'p',
						children: [{ id: 'c', type: 'process', label: 'c' }],
					},
				],
			},
		],
	},
];

describe('useProcessExpansion', () => {
	const STORAGE_KEY = 'maestro.processMonitor.expandedLevel';

	beforeEach(() => {
		const store = new Map<string, string>();
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			writable: true,
			value: {
				getItem: vi.fn((k: string) => (store.has(k) ? store.get(k)! : null)),
				setItem: vi.fn((k: string, v: string) => store.set(k, String(v))),
				removeItem: vi.fn((k: string) => {
					store.delete(k);
				}),
				clear: vi.fn(() => store.clear()),
				key: vi.fn(() => null),
				get length() {
					return store.size;
				},
			},
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('starts with an empty expanded set while loading', () => {
		const { result } = renderHook(() => useProcessExpansion(tree3, true));
		expect(result.current.expandedIds.size).toBe(0);
	});

	it('fully expands all depths on first load when no preference is stored', () => {
		const { result } = renderHook(() => useProcessExpansion(tree3, false));
		expect(result.current.expandedIds.has('g')).toBe(true);
		expect(result.current.expandedIds.has('s')).toBe(true);
	});

	it('toggleNode flips an id in/out of the expanded set', () => {
		const { result } = renderHook(() => useProcessExpansion(tree3, false));
		act(() => result.current.toggleNode('g'));
		const after = result.current.expandedIds.has('g');
		act(() => result.current.toggleNode('g'));
		expect(after).toBe(false); // initial restore expanded then toggle collapsed
		expect(result.current.expandedIds.has('g')).toBe(true);
	});

	it('collapseStep walks deepest tier first', () => {
		const { result } = renderHook(() => useProcessExpansion(tree3, false));
		// after initial restore, both g and s are expanded
		expect(result.current.expandedIds.has('s')).toBe(true);
		act(() => result.current.collapseStep());
		expect(result.current.expandedIds.has('s')).toBe(false);
		expect(result.current.expandedIds.has('g')).toBe(true);
		act(() => result.current.collapseStep());
		expect(result.current.expandedIds.has('g')).toBe(false);
	});

	it('expandStep walks shallowest tier first', () => {
		// Force a stored level of 0 so initial restore is empty.
		window.localStorage.setItem(STORAGE_KEY, '0');
		const { result } = renderHook(() => useProcessExpansion(tree3, false));
		expect(result.current.expandedIds.size).toBe(0);
		act(() => result.current.expandStep());
		expect(result.current.expandedIds.has('g')).toBe(true);
		expect(result.current.expandedIds.has('s')).toBe(false);
		act(() => result.current.expandStep());
		expect(result.current.expandedIds.has('s')).toBe(true);
	});

	it('persists the depth chosen by the stepper to localStorage', () => {
		window.localStorage.setItem(STORAGE_KEY, '0');
		const { result } = renderHook(() => useProcessExpansion(tree3, false));
		act(() => result.current.expandStep());
		expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1');
		act(() => result.current.expandStep());
		expect(window.localStorage.getItem(STORAGE_KEY)).toBe('2');
		act(() => result.current.collapseStep());
		expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1');
	});

	it('restores the stored depth on first load', () => {
		window.localStorage.setItem(STORAGE_KEY, '1');
		const { result } = renderHook(() => useProcessExpansion(tree3, false));
		expect(result.current.expandedIds.has('g')).toBe(true);
		expect(result.current.expandedIds.has('s')).toBe(false);
	});

	it('caps the stored depth to the available tree depth', () => {
		window.localStorage.setItem(STORAGE_KEY, '99');
		const { result } = renderHook(() => useProcessExpansion(tree3, false));
		// Tree depth is 2 (g, s), so all available IDs expand.
		expect(result.current.expandedIds.has('g')).toBe(true);
		expect(result.current.expandedIds.has('s')).toBe(true);
	});

	it('handles a 4-level tree', () => {
		window.localStorage.setItem(STORAGE_KEY, '0');
		const { result } = renderHook(() => useProcessExpansion(tree4, false));
		act(() => result.current.expandStep());
		expect(result.current.expandedIds.has('g')).toBe(true);
		act(() => result.current.expandStep());
		expect(result.current.expandedIds.has('s')).toBe(true);
		act(() => result.current.expandStep());
		expect(result.current.expandedIds.has('p')).toBe(true);
	});

	it('does not re-fire the initial-restore effect after the first run', () => {
		// The restore effect calls readStoredExpandedLevel() → localStorage.getItem.
		// On the first non-loading render it reads once; subsequent renders should be
		// guarded by hasExpandedInitially and read no further.
		const getItem = window.localStorage.getItem as ReturnType<typeof vi.fn>;
		const { rerender } = renderHook(({ tree }) => useProcessExpansion(tree, false), {
			initialProps: { tree: tree3 },
		});
		const callsAfterInitial = getItem.mock.calls.length;
		// Re-render with a fresh tree reference (simulates polling-driven memo recompute).
		const refreshed = JSON.parse(JSON.stringify(tree3)) as ProcessNode[];
		rerender({ tree: refreshed });
		expect(getItem.mock.calls.length).toBe(callsAfterInitial);
	});
});
