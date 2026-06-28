import { act, renderHook } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentDragReorder } from '../../../../../renderer/components/DocumentsPanel/hooks/useDocumentDragReorder';
import type { BatchDocumentEntry } from '../../../../../renderer/types';

vi.mock('../../../../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => 'copy-id'),
}));

const initialDocs: BatchDocumentEntry[] = [
	{ id: '1', filename: 'alpha', resetOnCompletion: false },
	{ id: '2', filename: 'beta', resetOnCompletion: false },
	{ id: '3', filename: 'gamma', resetOnCompletion: false },
];

function dragEvent(
	options: {
		ctrlKey?: boolean;
		metaKey?: boolean;
		clientY?: number;
		top?: number;
		height?: number;
		relatedTarget?: Node | null;
		contains?: (node: Node) => boolean;
	} = {}
): React.DragEvent {
	const {
		ctrlKey = false,
		metaKey = false,
		clientY = 0,
		top = 0,
		height = 20,
		relatedTarget = null,
		contains = () => false,
	} = options;
	return {
		ctrlKey,
		metaKey,
		clientX: 10,
		clientY,
		relatedTarget,
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
		dataTransfer: {
			effectAllowed: 'move',
			dropEffect: 'move',
		},
		currentTarget: {
			getBoundingClientRect: () => ({ top, height }),
			contains,
		},
	} as unknown as React.DragEvent;
}

function setup(docs = initialDocs) {
	let currentDocs = docs;
	const setDocuments = vi.fn((next: React.SetStateAction<BatchDocumentEntry[]>) => {
		currentDocs = typeof next === 'function' ? next(currentDocs) : next;
	});
	const hook = renderHook(
		({ documents }) =>
			useDocumentDragReorder({
				documents,
				setDocuments,
			}),
		{ initialProps: { documents: currentDocs } }
	);
	return {
		...hook,
		getDocs: () => currentDocs,
		setDocuments,
		rerenderWithCurrent: () => hook.rerender({ documents: currentDocs }),
	};
}

describe('useDocumentDragReorder', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('moves a document down with adjusted insertion index', () => {
		const { result, getDocs } = setup();

		act(() => result.current.handleDragStart(dragEvent(), '1'));
		act(() => result.current.handleDragOver(dragEvent({ clientY: 30 }), '3', 2));
		act(() => result.current.handleDragEnd());

		expect(getDocs().map((doc) => doc.id)).toEqual(['2', '3', '1']);
		expect(result.current.draggedId).toBeNull();
	});

	it('does not move when dropped in the same position', () => {
		const { result, getDocs, setDocuments } = setup();

		act(() => result.current.handleDragStart(dragEvent(), '2'));
		act(() => result.current.handleDragOver(dragEvent({ clientY: 1 }), '2', 1));
		act(() => result.current.handleDragEnd());

		expect(setDocuments).not.toHaveBeenCalled();
		expect(getDocs().map((doc) => doc.id)).toEqual(['1', '2', '3']);
	});

	it('copies a document and enables reset for every same-filename row', () => {
		const docs: BatchDocumentEntry[] = [
			{ id: '1', filename: 'alpha', resetOnCompletion: false },
			{ id: '2', filename: 'alpha', resetOnCompletion: false, isDuplicate: true },
			{ id: '3', filename: 'beta', resetOnCompletion: false },
		];
		const { result, getDocs } = setup(docs);

		act(() => result.current.handleDragStart(dragEvent({ metaKey: true }), '1'));
		act(() => result.current.handleDragOver(dragEvent({ metaKey: true, clientY: 30 }), '3', 2));
		act(() => result.current.handleDragEnd());

		expect(getDocs()).toEqual([
			{ id: '1', filename: 'alpha', resetOnCompletion: true },
			{ id: '2', filename: 'alpha', resetOnCompletion: true, isDuplicate: true },
			{ id: '3', filename: 'beta', resetOnCompletion: false },
			{ id: 'copy-id', filename: 'alpha', resetOnCompletion: true, isDuplicate: true },
		]);
	});

	it('uses handleDrop once and prevents handleDragEnd double execution', () => {
		const { result, getDocs, setDocuments } = setup();
		const drop = dragEvent();

		act(() => result.current.handleDragStart(dragEvent(), '1'));
		act(() => result.current.handleDragOver(dragEvent({ clientY: 30 }), '3', 2));
		act(() => result.current.handleDrop(drop));
		act(() => result.current.handleDragEnd());

		expect(drop.preventDefault).toHaveBeenCalled();
		expect(drop.stopPropagation).toHaveBeenCalled();
		expect(setDocuments).toHaveBeenCalledTimes(1);
		expect(getDocs().map((doc) => doc.id)).toEqual(['2', '3', '1']);
	});

	it('clears a stale drop target when drag leaves before drag end', () => {
		const { result, getDocs, setDocuments } = setup();

		act(() => result.current.handleDragStart(dragEvent(), '1'));
		act(() => result.current.handleDragOver(dragEvent({ clientY: 30 }), '3', 2));
		expect(result.current.dropTargetIndex).toBe(3);

		act(() => result.current.handleDragLeave(dragEvent()));
		act(() => result.current.handleDragEnd());

		expect(setDocuments).not.toHaveBeenCalled();
		expect(getDocs().map((doc) => doc.id)).toEqual(['1', '2', '3']);
	});

	it('tracks cursor and copy-drag state', () => {
		const { result } = setup();

		act(() => result.current.handleDragStart(dragEvent({ ctrlKey: true }), '1'));
		expect(result.current.isCopyDrag).toBe(true);
		expect(result.current.cursorPosition).toEqual({ x: 10, y: 0 });

		act(() => result.current.handleDrag(dragEvent({ clientY: 15 })));
		expect(result.current.cursorPosition).toEqual({ x: 10, y: 15 });
	});
});
