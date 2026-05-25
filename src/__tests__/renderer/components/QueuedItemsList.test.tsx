import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueuedItemsList } from '../../../renderer/components/QueuedItemsList';
import type { QueuedItem, Theme } from '../../../renderer/types';

vi.mock('lucide-react', () => ({
	X: () => <svg data-testid="x-icon" />,
	ChevronDown: () => <svg data-testid="chevron-down-icon" />,
	ChevronUp: () => <svg data-testid="chevron-up-icon" />,
	GripVertical: () => <svg data-testid="grip-icon" />,
}));

const mockTheme: Theme = {
	id: 'dark',
	name: 'Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101010',
		bgSidebar: '#151515',
		bgActivity: '#202020',
		bgTerminal: '#050505',
		textMain: '#f5f5f5',
		textDim: '#999999',
		accent: '#4f8cff',
		accentForeground: '#ffffff',
		success: '#3ddc84',
		warning: '#ffc857',
		error: '#ff5c5c',
		border: '#333333',
		terminalCursor: '#4f8cff',
	},
};

const createQueuedItem = (overrides: Partial<QueuedItem> = {}): QueuedItem => ({
	id: 'queued-1',
	timestamp: 100,
	tabId: 'tab-1',
	type: 'message',
	text: 'Run the next task',
	...overrides,
});

describe('QueuedItemsList', () => {
	it('renders nothing when the queue is empty or filtered away', () => {
		const { container, rerender } = render(
			<QueuedItemsList executionQueue={[]} theme={mockTheme} activeTabId="tab-1" />
		);

		expect(container).toBeEmptyDOMElement();

		rerender(
			<QueuedItemsList
				executionQueue={[createQueuedItem({ tabId: 'tab-2' })]}
				theme={mockTheme}
				activeTabId="tab-1"
			/>
		);

		expect(container).toBeEmptyDOMElement();
	});

	it('filters queued items by active tab and renders command and image metadata', () => {
		render(
			<QueuedItemsList
				executionQueue={[
					createQueuedItem({
						id: 'queued-1',
						tabId: 'tab-1',
						type: 'command',
						command: '/commit',
						text: undefined,
					}),
					createQueuedItem({
						id: 'queued-2',
						tabId: 'tab-1',
						text: 'Message with screenshots',
						images: ['one.png', 'two.png'],
					}),
					createQueuedItem({ id: 'queued-3', tabId: 'tab-2', text: 'Hidden item' }),
				]}
				theme={mockTheme}
				activeTabId="tab-1"
			/>
		);

		expect(screen.getByText('QUEUED (2)')).toBeInTheDocument();
		expect(screen.getByText('/commit')).toBeInTheDocument();
		expect(screen.getByText('Message with screenshots')).toBeInTheDocument();
		expect(screen.getByText('2 images attached')).toBeInTheDocument();
		expect(screen.queryByText('Hidden item')).not.toBeInTheDocument();
	});

	it('expands and collapses long queued messages', () => {
		const longText = `${'A'.repeat(210)}\nsecond line\nthird line`;
		render(
			<QueuedItemsList executionQueue={[createQueuedItem({ text: longText })]} theme={mockTheme} />
		);

		expect(screen.getByText(`${'A'.repeat(200)}...`)).toBeInTheDocument();

		fireEvent.click(screen.getByText('Show all (3 lines)'));

		expect(screen.getByText('Show less').previousElementSibling).toHaveTextContent(longText, {
			normalizeWhitespace: false,
		});
		expect(screen.getByText('Show less')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Show less'));

		expect(screen.getByText(`${'A'.repeat(200)}...`)).toBeInTheDocument();
	});

	it('opens, cancels, confirms, and keyboard-dismisses the removal modal', () => {
		const onRemoveQueuedItem = vi.fn();
		render(
			<QueuedItemsList
				executionQueue={[createQueuedItem({ id: 'queued-remove' })]}
				theme={mockTheme}
				onRemoveQueuedItem={onRemoveQueuedItem}
			/>
		);

		fireEvent.click(screen.getByTitle('Remove from queue'));
		expect(screen.getByText('Remove Queued Message?')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Cancel'));
		expect(screen.queryByText('Remove Queued Message?')).not.toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Remove from queue'));
		fireEvent.keyDown(screen.getByText('Remove Queued Message?'), { key: 'a' });
		expect(screen.getByText('Remove Queued Message?')).toBeInTheDocument();
		fireEvent.keyDown(screen.getByText('Remove Queued Message?'), { key: 'Escape' });
		expect(screen.queryByText('Remove Queued Message?')).not.toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Remove from queue'));
		fireEvent.keyDown(screen.getByText('Remove Queued Message?'), { key: 'Enter' });
		expect(onRemoveQueuedItem).toHaveBeenCalledWith('queued-remove');
		expect(screen.queryByText('Remove Queued Message?')).not.toBeInTheDocument();
	});

	it('confirms removal from the button and closes when clicking the backdrop', () => {
		const onRemoveQueuedItem = vi.fn();
		render(
			<QueuedItemsList
				executionQueue={[createQueuedItem({ id: 'queued-remove' })]}
				theme={mockTheme}
				onRemoveQueuedItem={onRemoveQueuedItem}
			/>
		);

		fireEvent.click(screen.getByTitle('Remove from queue'));
		fireEvent.click(screen.getByText('Remove'));
		expect(onRemoveQueuedItem).toHaveBeenCalledWith('queued-remove');

		fireEvent.click(screen.getByTitle('Remove from queue'));
		const backdrop = screen.getByText('Remove Queued Message?').parentElement?.parentElement;
		expect(backdrop).toBeTruthy();
		fireEvent.click(backdrop!);
		expect(screen.queryByText('Remove Queued Message?')).not.toBeInTheDocument();
	});

	it('handles optional removal handlers and singular image labels', () => {
		render(
			<QueuedItemsList
				executionQueue={[
					createQueuedItem({ id: 'queued-image', images: ['one.png'] }),
					createQueuedItem({ id: 'queued-empty-text', text: undefined }),
					createQueuedItem({
						id: 'queued-command',
						type: 'command',
						text: undefined,
						command: undefined,
					}),
				]}
				theme={mockTheme}
			/>
		);

		expect(screen.getByText('1 image attached')).toBeInTheDocument();

		const removeButtons = screen.getAllByTitle('Remove from queue');
		expect(removeButtons).toHaveLength(3);
		fireEvent.click(removeButtons[0]);
		fireEvent.keyDown(screen.getByText('Remove Queued Message?'), { key: 'Enter' });
		expect(screen.queryByText('Remove Queued Message?')).not.toBeInTheDocument();

		fireEvent.click(removeButtons[1]);
		fireEvent.click(screen.getByText('Remove'));
		expect(screen.queryByText('Remove Queued Message?')).not.toBeInTheDocument();
	});

	it('reorders draggable items when dropped on a different queued item', () => {
		const onReorderItems = vi.fn();
		render(
			<QueuedItemsList
				executionQueue={[
					createQueuedItem({ id: 'queued-1', text: 'First queued message' }),
					createQueuedItem({ id: 'queued-2', text: 'Second queued message' }),
				]}
				theme={mockTheme}
				onReorderItems={onReorderItems}
			/>
		);

		expect(screen.getAllByTestId('grip-icon')).toHaveLength(2);

		const firstItem = screen.getByText('First queued message').closest('[draggable="true"]');
		const secondItem = screen.getByText('Second queued message').closest('[draggable="true"]');
		expect(firstItem).toBeTruthy();
		expect(secondItem).toBeTruthy();

		fireEvent.dragStart(firstItem!);
		fireEvent.dragOver(secondItem!);
		fireEvent.dragEnd(firstItem!);

		expect(onReorderItems).toHaveBeenCalledWith(0, 1);
	});

	it('does not reorder when dragging over itself or leaving the drop target', () => {
		const onReorderItems = vi.fn();
		render(
			<QueuedItemsList
				executionQueue={[
					createQueuedItem({ id: 'queued-1', text: 'First queued message' }),
					createQueuedItem({ id: 'queued-2', text: 'Second queued message' }),
				]}
				theme={mockTheme}
				onReorderItems={onReorderItems}
			/>
		);

		const firstItem = screen.getByText('First queued message').closest('[draggable="true"]');
		const secondItem = screen.getByText('Second queued message').closest('[draggable="true"]');

		fireEvent.dragStart(firstItem!);
		fireEvent.dragOver(firstItem!);
		fireEvent.dragEnd(firstItem!);
		expect(onReorderItems).not.toHaveBeenCalled();

		fireEvent.dragStart(firstItem!);
		fireEvent.dragOver(secondItem!);
		fireEvent.dragLeave(secondItem!);
		fireEvent.dragEnd(firstItem!);
		expect(onReorderItems).not.toHaveBeenCalled();
	});
});
