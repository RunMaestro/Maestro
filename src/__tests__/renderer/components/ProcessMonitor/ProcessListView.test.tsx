import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessListView } from '../../../../renderer/components/ProcessMonitor/ProcessListView';
import type { ProcessNode } from '../../../../renderer/components/ProcessMonitor/types';
import type { Theme } from '../../../../renderer/types';

const theme: Theme = {
	id: 'test',
	name: 'test',
	mode: 'dark',
	colors: {
		bgMain: '#000',
		bgSidebar: '#111',
		bgActivity: '#222',
		textMain: '#fff',
		textDim: '#888',
		accent: '#7b2cbf',
		border: '#333',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		info: '#3b82f6',
		bgAccentHover: '#9333ea',
	},
};

const sampleTree: ProcessNode[] = [
	{
		id: 'group-root',
		type: 'group',
		label: 'UNGROUPED AGENTS',
		emoji: '📁',
		children: [
			{
				id: 'session-session-1',
				type: 'session',
				label: 'My Agent',
				sessionId: 'session-1',
				children: [
					{
						id: 'process-session-1-ai-tab-a',
						type: 'process',
						label: 'My Agent - AI Agent (claude-code)',
						pid: 12345,
						processType: 'ai',
						sessionId: 'session-1',
						processSessionId: 'session-1-ai-tab-a',
						isAlive: true,
						toolType: 'claude-code',
					},
				],
			},
		],
	},
];

const baseProps = {
	theme,
	tree: sampleTree,
	isLoading: false,
	selectedNodeId: null as string | null,
	expandedIds: new Set<string>(['group-root', 'session-session-1']),
	onSelectNode: vi.fn(),
	onToggleNode: vi.fn(),
	onOpenDetail: vi.fn(),
	onRequestKill: vi.fn(),
	onCloseModal: vi.fn(),
};

describe('ProcessListView', () => {
	afterEach(() => {
		// Restores any vi.spyOn - notably the Element.prototype.scrollIntoView spy
		// in the selection-changes test below - even if an assertion threw mid-test.
		vi.restoreAllMocks();
	});

	it('renders the loading state', () => {
		render(<ProcessListView {...baseProps} isLoading={true} tree={[]} />);
		expect(screen.getByText('Loading processes...')).toBeInTheDocument();
	});

	it('renders the empty state', () => {
		render(<ProcessListView {...baseProps} tree={[]} />);
		expect(screen.getByText('No running processes')).toBeInTheDocument();
	});

	it('renders the tree when not loading', () => {
		render(<ProcessListView {...baseProps} />);
		expect(screen.getByText('UNGROUPED AGENTS')).toBeInTheDocument();
		expect(screen.getByText('My Agent')).toBeInTheDocument();
		expect(screen.getByText(/AI Agent \(claude-code\)/)).toBeInTheDocument();
	});

	it('clicking the kill icon calls onRequestKill', () => {
		const onRequestKill = vi.fn();
		render(<ProcessListView {...baseProps} onRequestKill={onRequestKill} />);
		fireEvent.click(screen.getByTitle('Kill process'));
		expect(onRequestKill).toHaveBeenCalledWith('session-1-ai-tab-a', undefined);
	});

	it('clicking a session row triggers onSelectNode + onToggleNode', () => {
		const onSelectNode = vi.fn();
		const onToggleNode = vi.fn();
		render(
			<ProcessListView {...baseProps} onSelectNode={onSelectNode} onToggleNode={onToggleNode} />
		);
		fireEvent.click(screen.getByText('My Agent'));
		expect(onSelectNode).toHaveBeenCalledWith('session-session-1');
		expect(onToggleNode).toHaveBeenCalledWith('session-session-1');
	});

	it('double-clicking a process row opens detail', () => {
		const onOpenDetail = vi.fn();
		render(<ProcessListView {...baseProps} onOpenDetail={onOpenDetail} />);
		const processLabel = screen.getByText(/AI Agent \(claude-code\)/);
		fireEvent.doubleClick(processLabel);
		expect(onOpenDetail).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'process-session-1-ai-tab-a' })
		);
	});

	it('the jump-to-agent button calls onNavigateToSession + closes modal', () => {
		const onNavigateToSession = vi.fn();
		const onCloseModal = vi.fn();
		render(
			<ProcessListView
				{...baseProps}
				onNavigateToSession={onNavigateToSession}
				onCloseModal={onCloseModal}
			/>
		);
		// session row has "Jump to agent"; the process row may also have one when no
		// processType filter applies. Pick the first (the session-row button).
		fireEvent.click(screen.getAllByTitle('Jump to agent')[0]);
		expect(onNavigateToSession).toHaveBeenCalledWith('session-1');
		expect(onCloseModal).toHaveBeenCalledTimes(1);
	});

	it('scrollIntoView fires when the selected node id changes', () => {
		// afterEach -> vi.restoreAllMocks() guarantees prototype cleanup even if
		// assertions throw, so no manual mockRestore() is needed here.
		const scrollSpy = vi
			.spyOn(Element.prototype, 'scrollIntoView')
			.mockImplementation(() => undefined);
		const { rerender } = render(<ProcessListView {...baseProps} />);
		scrollSpy.mockClear();
		rerender(<ProcessListView {...baseProps} selectedNodeId="session-session-1" />);
		expect(scrollSpy).toHaveBeenCalledTimes(1);
	});
});
