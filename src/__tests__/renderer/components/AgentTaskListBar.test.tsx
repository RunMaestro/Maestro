import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentTaskListBar } from '../../../renderer/components/AgentTaskListBar';
import { mockTheme } from '../../helpers/mockTheme';
import type { LogEntry } from '../../../renderer/types';

// The bar reads two booleans off the settings store; stub them rather than
// hydrating the whole store from IPC.
let showBar = true;
let autoExpand = false;
vi.mock('../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: (
		selector: (s: { showAgentTaskListBar: boolean; autoExpandAgentTaskListBar: boolean }) => unknown
	) => selector({ showAgentTaskListBar: showBar, autoExpandAgentTaskListBar: autoExpand }),
}));

function todoEntry(id: string, statuses: string[]): LogEntry {
	return {
		id,
		timestamp: 0,
		source: 'tool',
		text: 'TodoWrite',
		metadata: {
			toolState: {
				status: 'completed',
				input: {
					todos: statuses.map((status, i) => ({
						content: `task ${i}`,
						status,
						activeForm: `doing task ${i}`,
					})),
				},
			},
		},
	} as unknown as LogEntry;
}

describe('AgentTaskListBar', () => {
	beforeEach(() => {
		showBar = true;
		autoExpand = false;
		// The bar remembers its expanded state; start every case collapsed.
		globalThis.localStorage?.clear();
	});

	it('renders nothing until an agent writes a checklist', () => {
		const { container } = render(<AgentTaskListBar theme={mockTheme} logs={[]} />);
		expect(container).toBeEmptyDOMElement();
	});

	it('shows the active task and progress count, collapsed by default', () => {
		render(
			<AgentTaskListBar
				theme={mockTheme}
				logs={[todoEntry('a', ['completed', 'in_progress', 'pending'])]}
			/>
		);

		expect(screen.getByText('doing task 1 (1/3)')).toBeInTheDocument();
		// Collapsed: the individual task rows are not rendered yet.
		expect(screen.queryByText('task 2')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Expand agent task list' })).toHaveAttribute(
			'aria-expanded',
			'false'
		);
	});

	it('expands to the full list on click', () => {
		render(
			<AgentTaskListBar
				theme={mockTheme}
				logs={[todoEntry('a', ['completed', 'in_progress', 'pending'])]}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: 'Expand agent task list' }));

		expect(screen.getByText('task 0')).toBeInTheDocument();
		expect(screen.getByText('doing task 1')).toBeInTheDocument();
		expect(screen.getByText('task 2')).toBeInTheDocument();
	});

	it('tracks the newest checklist as the agent rewrites it', () => {
		const { rerender } = render(
			<AgentTaskListBar theme={mockTheme} logs={[todoEntry('a', ['in_progress', 'pending'])]} />
		);
		expect(screen.getByText('doing task 0 (0/2)')).toBeInTheDocument();

		rerender(
			<AgentTaskListBar
				theme={mockTheme}
				logs={[
					todoEntry('a', ['in_progress', 'pending']),
					todoEntry('b', ['completed', 'in_progress']),
				]}
			/>
		);
		expect(screen.getByText('doing task 1 (1/2)')).toBeInTheDocument();
	});

	it('dismisses the current list, and comes back when the agent writes a new one', () => {
		const first = todoEntry('a', ['in_progress', 'pending']);
		const { rerender } = render(<AgentTaskListBar theme={mockTheme} logs={[first]} />);

		fireEvent.click(screen.getByRole('button', { name: 'Hide this task list' }));
		expect(screen.queryByTestId('agent-task-list-bar')).not.toBeInTheDocument();

		// A re-render alone must not resurrect the dismissed list...
		rerender(<AgentTaskListBar theme={mockTheme} logs={[first]} />);
		expect(screen.queryByTestId('agent-task-list-bar')).not.toBeInTheDocument();

		// ...but the next checklist update does.
		rerender(
			<AgentTaskListBar
				theme={mockTheme}
				logs={[first, todoEntry('b', ['completed', 'completed'])]}
			/>
		);
		expect(screen.getByTestId('agent-task-list-bar')).toBeInTheDocument();
	});

	it('stays hidden when the setting is off', () => {
		showBar = false;
		const { container } = render(
			<AgentTaskListBar theme={mockTheme} logs={[todoEntry('a', ['in_progress'])]} />
		);
		expect(container).toBeEmptyDOMElement();
	});

	it('ignores a checklist written inside a subagent', () => {
		const nested = todoEntry('b', ['pending', 'pending']);
		nested.metadata = { ...nested.metadata, parentToolUseId: 'task_1' };

		render(
			<AgentTaskListBar
				theme={mockTheme}
				logs={[todoEntry('a', ['in_progress', 'pending']), nested]}
			/>
		);

		// The parent's plan, not the delegated worker's private one.
		expect(screen.getByText('doing task 0 (0/2)')).toBeInTheDocument();
	});

	describe('with auto-expand on', () => {
		beforeEach(() => {
			autoExpand = true;
		});

		it('opens a new checklist to its full list', () => {
			render(
				<AgentTaskListBar
					theme={mockTheme}
					logs={[todoEntry('a', ['completed', 'in_progress', 'pending'])]}
				/>
			);

			expect(screen.getByText('task 2')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Collapse agent task list' })).toHaveAttribute(
				'aria-expanded',
				'true'
			);
		});

		it('re-expands when the agent writes the next checklist, after a manual collapse', () => {
			const first = todoEntry('a', ['in_progress', 'pending']);
			const { rerender } = render(<AgentTaskListBar theme={mockTheme} logs={[first]} />);

			fireEvent.click(screen.getByRole('button', { name: 'Collapse agent task list' }));
			expect(screen.queryByText('task 1')).not.toBeInTheDocument();

			// The collapse applies to THAT checklist only.
			rerender(
				<AgentTaskListBar
					theme={mockTheme}
					logs={[first, todoEntry('b', ['completed', 'in_progress'])]}
				/>
			);
			expect(screen.getByText('task 0')).toBeInTheDocument();
		});

		it('does not carry the sticky collapsed preference over', () => {
			// A user who collapsed the bar with auto-expand OFF still gets the
			// full list once they turn auto-expand ON.
			globalThis.localStorage?.setItem('agentTaskList.bar.expanded', 'false');

			render(<AgentTaskListBar theme={mockTheme} logs={[todoEntry('a', ['in_progress'])]} />);

			expect(screen.getByText('doing task 0')).toBeInTheDocument();
		});
	});
});
