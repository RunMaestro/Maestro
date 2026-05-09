import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { useProcessKeyboardNav } from '../../../../../renderer/components/ProcessMonitor/hooks/useProcessKeyboardNav';
import type { ProcessNode } from '../../../../../renderer/components/ProcessMonitor/types';

const tree: ProcessNode[] = [
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
						processSessionId: 'session-1-ai-tab-a',
						pid: 100,
					},
				],
			},
		],
	},
];

const mkEvent = (key: string): React.KeyboardEvent =>
	({
		key,
		preventDefault: vi.fn(),
	}) as unknown as React.KeyboardEvent;

const mkInput = (overrides: Partial<Parameters<typeof useProcessKeyboardNav>[0]> = {}) => ({
	tree,
	expandedIds: new Set<string>(['g', 's']),
	selectedNodeId: null as string | null,
	setSelectedNodeId: vi.fn(),
	openProcessDetail: vi.fn(),
	toggleNode: vi.fn(),
	refresh: vi.fn(),
	...overrides,
});

describe('useProcessKeyboardNav', () => {
	it('does nothing when there are no visible nodes', () => {
		const input = mkInput({ tree: [], expandedIds: new Set() });
		const { result } = renderHook(() => useProcessKeyboardNav(input));
		result.current.onKeyDown(mkEvent('ArrowDown'));
		expect(input.setSelectedNodeId).not.toHaveBeenCalled();
	});

	it('ArrowDown selects the first visible node when nothing is selected', () => {
		const input = mkInput();
		const { result } = renderHook(() => useProcessKeyboardNav(input));
		result.current.onKeyDown(mkEvent('ArrowDown'));
		expect(input.setSelectedNodeId).toHaveBeenCalledWith('g');
	});

	it('ArrowDown advances selection forward', () => {
		const input = mkInput({ selectedNodeId: 'g' });
		const { result } = renderHook(() => useProcessKeyboardNav(input));
		result.current.onKeyDown(mkEvent('ArrowDown'));
		expect(input.setSelectedNodeId).toHaveBeenCalledWith('s');
	});

	it('ArrowUp moves selection backward', () => {
		const input = mkInput({ selectedNodeId: 's' });
		const { result } = renderHook(() => useProcessKeyboardNav(input));
		result.current.onKeyDown(mkEvent('ArrowUp'));
		expect(input.setSelectedNodeId).toHaveBeenCalledWith('g');
	});

	it('ArrowRight expands a collapsed group via toggleNode', () => {
		const input = mkInput({ selectedNodeId: 'g', expandedIds: new Set() });
		const { result } = renderHook(() => useProcessKeyboardNav(input));
		result.current.onKeyDown(mkEvent('ArrowRight'));
		expect(input.toggleNode).toHaveBeenCalledWith('g');
	});

	it('ArrowRight on an expanded group moves selection to the first child', () => {
		const input = mkInput({ selectedNodeId: 'g', expandedIds: new Set(['g']) });
		const { result } = renderHook(() => useProcessKeyboardNav(input));
		result.current.onKeyDown(mkEvent('ArrowRight'));
		expect(input.setSelectedNodeId).toHaveBeenCalledWith('s');
	});

	it('ArrowLeft on an expanded node collapses via toggleNode', () => {
		const input = mkInput({ selectedNodeId: 'g', expandedIds: new Set(['g', 's']) });
		const { result } = renderHook(() => useProcessKeyboardNav(input));
		result.current.onKeyDown(mkEvent('ArrowLeft'));
		expect(input.toggleNode).toHaveBeenCalledWith('g');
	});

	it('ArrowLeft on a leaf moves selection to its parent', () => {
		const input = mkInput({ selectedNodeId: 'p' });
		const { result } = renderHook(() => useProcessKeyboardNav(input));
		result.current.onKeyDown(mkEvent('ArrowLeft'));
		expect(input.setSelectedNodeId).toHaveBeenCalledWith('s');
	});

	it('Enter on a process node opens the detail view', () => {
		const input = mkInput({ selectedNodeId: 'p' });
		const { result } = renderHook(() => useProcessKeyboardNav(input));
		result.current.onKeyDown(mkEvent('Enter'));
		expect(input.openProcessDetail).toHaveBeenCalledWith(expect.objectContaining({ id: 'p' }));
	});

	it('Enter on a group toggles expand/collapse', () => {
		const input = mkInput({ selectedNodeId: 'g' });
		const { result } = renderHook(() => useProcessKeyboardNav(input));
		result.current.onKeyDown(mkEvent('Enter'));
		expect(input.toggleNode).toHaveBeenCalledWith('g');
	});

	it('Space behaves identically to Enter', () => {
		const input = mkInput({ selectedNodeId: 'g' });
		const { result } = renderHook(() => useProcessKeyboardNav(input));
		result.current.onKeyDown(mkEvent(' '));
		expect(input.toggleNode).toHaveBeenCalledWith('g');
	});

	it('R triggers refresh', () => {
		const input = mkInput();
		const { result } = renderHook(() => useProcessKeyboardNav(input));
		result.current.onKeyDown(mkEvent('R'));
		expect(input.refresh).toHaveBeenCalledTimes(1);
		result.current.onKeyDown(mkEvent('r'));
		expect(input.refresh).toHaveBeenCalledTimes(2);
	});
});
