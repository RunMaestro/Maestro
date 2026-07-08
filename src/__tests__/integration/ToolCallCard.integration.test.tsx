import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolCallCard, getToolName } from '../../renderer/components/ToolCallCard';
import { THEMES } from '../../shared/themes';

const theme = THEMES['dracula'];

const makeToolUse = (overrides: Record<string, unknown> = {}) => [
	{
		name: 'Bash',
		state: {
			status: 'running',
			input: {
				command: 'npm test',
				lines: ['line1', 'line2', 'line3', 'line4', 'line5', 'line6'],
			},
			output: 'done',
		},
		...overrides,
	},
];

describe('getToolName', () => {
	it('extracts names from Claude and OpenCode entries and falls back to unknown', () => {
		expect(getToolName(undefined)).toBe('unknown');
		expect(getToolName({ name: 'Read' })).toBe('Read');
		expect(getToolName({ tool: 'grep' })).toBe('grep');
		expect(getToolName({ type: 'tool_use' })).toBe('unknown');
		expect(getToolName([{ tool: 'search' }, { name: 'ignored' }])).toBe('search');
		expect(getToolName([])).toBe('unknown');
	});
});

describe('ToolCallCard', () => {
	it('renders nothing for missing or empty tool calls', () => {
		const { container, rerender } = render(
			<ToolCallCard theme={theme} toolUse={[]} timestamp="10:00 AM" />
		);

		expect(container.firstChild).toBeNull();

		rerender(<ToolCallCard theme={theme} toolUse={undefined as any} timestamp="10:00 AM" />);

		expect(container.firstChild).toBeNull();
	});

	it('expands from the collapsed summary with click and keyboard, then collapses with keyboard', () => {
		render(<ToolCallCard theme={theme} toolUse={makeToolUse()} timestamp="2026-05-15 12:05" />);

		const collapsedCard = screen.getByRole('button', { name: /tool: bash/i });
		expect(collapsedCard).toHaveStyle({ borderLeft: `3px solid ${theme.colors.warning}` });
		expect(screen.queryByText('Status: running')).not.toBeInTheDocument();

		fireEvent.keyDown(collapsedCard, { key: 'Escape' });

		expect(screen.queryByText('Status: running')).not.toBeInTheDocument();

		fireEvent.keyDown(collapsedCard, { key: 'Enter' });

		expect(screen.getByRole('button', { name: /tool: bash/i })).toBeInTheDocument();
		expect(screen.getByText('Time: 2026-05-15 12:05')).toBeInTheDocument();
		expect(screen.getByText('Status: running')).toBeInTheDocument();
		expect(screen.getByText('Input:')).toBeInTheDocument();
		expect(screen.getByText('Output:')).toBeInTheDocument();

		const expandedHeader = screen.getByRole('button', { name: /tool: bash/i });
		fireEvent.keyDown(expandedHeader, { key: 'Escape' });
		expect(screen.getByText('Status: running')).toBeInTheDocument();

		fireEvent.keyDown(expandedHeader, { key: ' ' });

		expect(screen.getByRole('button', { name: /tool: bash/i })).toBeInTheDocument();
		expect(screen.queryByText('Status: running')).not.toBeInTheDocument();
	});

	it('toggles long input content and leaves short output content uncollapsed', () => {
		render(
			<ToolCallCard
				theme={theme}
				toolUse={makeToolUse()}
				timestamp="2026-05-15 12:05"
				defaultExpanded
			/>
		);

		expect(screen.getByText('Input:')).toBeInTheDocument();
		expect(screen.getByText('Show more')).toBeInTheDocument();
		expect(screen.getByText('Output:')).toBeInTheDocument();
		expect(screen.queryByText('Show less')).not.toBeInTheDocument();
		expect(screen.queryByText(/line6/)).not.toBeInTheDocument();
		expect(screen.getByText('done')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Show more'));

		expect(screen.getByText('Show less')).toBeInTheDocument();
		expect(screen.getByText(/line6/)).toBeInTheDocument();

		fireEvent.click(screen.getByText('Input:'));

		expect(screen.getByText('Show more')).toBeInTheDocument();
		expect(screen.queryByText(/line6/)).not.toBeInTheDocument();
	});

	it.each([
		['completed', 'completed'],
		['success', 'success'],
		['running', 'running'],
		['pending', 'pending'],
		['error', 'error'],
		['failed', 'failed'],
		['mystery', 'mystery'],
		[undefined, 'completed'],
	])(
		'renders %s status without requiring input, output, or a timestamp',
		(status, expectedLabel) => {
			render(
				<ToolCallCard
					theme={theme}
					toolUse={[
						{
							tool: 'glob',
							state: { status },
						},
					]}
					defaultExpanded
				/>
			);

			expect(screen.getByText('Tool: glob')).toBeInTheDocument();
			expect(screen.getByText(`Status: ${expectedLabel}`)).toBeInTheDocument();
			expect(screen.queryByText(/^Time:/)).not.toBeInTheDocument();
			expect(screen.queryByText('Input:')).not.toBeInTheDocument();
			expect(screen.queryByText('Output:')).not.toBeInTheDocument();
		}
	);

	it('suppresses null input and output sections while keeping status visible', () => {
		render(
			<ToolCallCard
				theme={theme}
				toolUse={[
					{
						name: 'Read',
						state: {
							status: 'completed',
							input: null,
							output: null,
						},
					},
				]}
				defaultExpanded
			/>
		);

		expect(screen.getByText('Tool: Read')).toBeInTheDocument();
		expect(screen.getByText('Status: completed')).toBeInTheDocument();
		expect(screen.queryByText('Input:')).not.toBeInTheDocument();
		expect(screen.queryByText('Output:')).not.toBeInTheDocument();
	});

	it('supports mouse expansion and collapse for a tool with only string input', () => {
		render(
			<ToolCallCard
				theme={theme}
				toolUse={makeToolUse({
					tool: 'view',
					name: undefined,
					state: {
						status: 'success',
						input: 'src/main.ts',
					},
				})}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: /tool: view show more/i }));

		expect(screen.getByText('src/main.ts')).toBeInTheDocument();
		expect(screen.getByText('Status: success')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /tool: view collapse/i }));

		expect(screen.getByRole('button', { name: /tool: view show more/i })).toBeInTheDocument();
		expect(screen.queryByText('src/main.ts')).not.toBeInTheDocument();
	});
});
