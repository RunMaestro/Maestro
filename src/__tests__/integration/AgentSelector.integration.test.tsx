import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentCard, AgentSelector } from '../../renderer/components/shared/AgentSelector';
import type { AgentConfig, Theme } from '../../renderer/types';

const theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#101010',
		bgSidebar: '#202020',
		bgActivity: '#303030',
		textMain: '#f5f5f5',
		textDim: '#a0a0a0',
		accent: '#3b82f6',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#ef4444',
		warning: '#f59e0b',
		success: '#22c55e',
		info: '#38bdf8',
		textInverse: '#000000',
	},
} as Theme;

const agents: AgentConfig[] = [
	{
		id: 'codex',
		name: 'Codex',
		available: true,
		command: 'codex',
	},
	{
		id: 'opencode',
		name: 'OpenCode',
		available: true,
		command: 'opencode',
	},
	{
		id: 'claude-code',
		name: 'Claude Code',
		available: false,
		path: '/usr/local/bin/claude',
	},
];

describe('AgentSelector', () => {
	it('renders a loading spinner while agent detection is in progress', () => {
		const { container } = render(
			<AgentSelector
				theme={theme}
				agents={agents}
				selectedAgentId={null}
				onSelectAgent={vi.fn()}
				isLoading
			/>
		);

		expect(container.querySelector('.animate-spin')).toBeInTheDocument();
		expect(screen.queryByText('Codex')).not.toBeInTheDocument();
	});

	it('renders default and custom empty states after filtering', () => {
		const filterFn = vi.fn(() => false);
		const { rerender } = render(
			<AgentSelector
				theme={theme}
				agents={agents}
				selectedAgentId={null}
				onSelectAgent={vi.fn()}
				filterFn={filterFn}
			/>
		);

		expect(filterFn).toHaveBeenCalledTimes(agents.length);
		expect(
			screen.getByText(
				'No AI agents detected. Please install Claude Code or another supported agent.'
			)
		).toBeInTheDocument();

		rerender(
			<AgentSelector
				theme={theme}
				agents={[]}
				selectedAgentId={null}
				onSelectAgent={vi.fn()}
				emptyMessage={<span>No batch-capable agents</span>}
			/>
		);

		expect(screen.getByText('No batch-capable agents')).toBeInTheDocument();
	});

	it('renders selectable agents with status, beta, refresh, and expanded content behavior', () => {
		const onSelectAgent = vi.fn();
		const onRefreshAgent = vi.fn();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

		render(
			<AgentSelector
				theme={theme}
				agents={agents}
				selectedAgentId="codex"
				onSelectAgent={onSelectAgent}
				onRefreshAgent={onRefreshAgent}
				refreshingAgentId="codex"
				renderExpandedContent={(agent) => <div>Config for {agent.name}</div>}
				expandedAgentId="codex"
				showBetaBadge
			/>
		);

		const codexCard = screen.getByText('Codex').closest('button');
		const opencodeCard = screen.getByText('OpenCode').closest('button');
		const claudeCard = screen.getByText('Claude Code').closest('button');
		expect(codexCard).toHaveStyle({
			backgroundColor: '#303030',
			borderColor: '#3b82f6',
		});
		expect(codexCard).toHaveTextContent('codex');
		expect(codexCard).toHaveTextContent('Available');
		expect(opencodeCard).toHaveTextContent('Beta');
		expect(screen.getByText('Config for Codex')).toBeInTheDocument();
		expect(claudeCard).toHaveTextContent('/usr/local/bin/claude');
		expect(claudeCard).toHaveTextContent('Not Found');

		const refreshButton = within(codexCard as HTMLElement).getByTitle('Refresh detection');
		expect(refreshButton.querySelector('svg')).toHaveClass('animate-spin');
		fireEvent.click(refreshButton);

		expect(onRefreshAgent).toHaveBeenCalledWith('codex');
		expect(onSelectAgent).not.toHaveBeenCalled();
		expect(
			consoleError.mock.calls.some(([message]) => String(message).includes('validateDOMNesting'))
		).toBe(true);
		consoleError.mockRestore();

		fireEvent.click(claudeCard as HTMLElement);
		expect(onSelectAgent).toHaveBeenCalledWith('claude-code');
	});

	it('disables unsupported agents and shows coming-soon state when requested', () => {
		const onSelectAgent = vi.fn();

		render(
			<AgentSelector
				theme={theme}
				agents={agents}
				selectedAgentId={null}
				onSelectAgent={onSelectAgent}
				supportedAgentIds={['codex']}
				showComingSoon
				compact
			/>
		);

		const unsupportedCard = screen.getByText('Claude Code').closest('button') as HTMLButtonElement;
		expect(unsupportedCard).toBeDisabled();
		expect(unsupportedCard).toHaveClass('p-3');
		expect(unsupportedCard).toHaveTextContent('Coming Soon');

		fireEvent.click(unsupportedCard);

		expect(onSelectAgent).not.toHaveBeenCalledWith('claude-code');
	});
});

describe('AgentCard', () => {
	it('uses default supported card behavior without optional badges or refresh actions', () => {
		const onSelect = vi.fn();

		render(<AgentCard agent={agents[0]} theme={theme} isSelected={false} onSelect={onSelect} />);

		const card = screen.getByText('Codex').closest('button') as HTMLButtonElement;
		expect(card).toHaveClass('p-4');
		expect(card).not.toHaveClass('ring-2');
		expect(card).toHaveTextContent('Available');
		expect(screen.queryByText('Beta')).not.toBeInTheDocument();
		expect(screen.queryByTitle('Refresh detection')).not.toBeInTheDocument();

		fireEvent.click(card);

		expect(onSelect).toHaveBeenCalledTimes(1);
	});

	it('omits status content for unsupported cards when coming-soon display is disabled', () => {
		const onSelect = vi.fn();

		render(
			<AgentCard
				agent={agents.find((agent) => agent.id === 'claude-code')!}
				theme={theme}
				isSelected={false}
				onSelect={onSelect}
				isSupported={false}
			/>
		);

		const card = screen.getByText('Claude Code').closest('button') as HTMLButtonElement;
		expect(card).toBeDisabled();
		expect(card).toHaveClass('opacity-50');
		expect(screen.queryByText('Coming Soon')).not.toBeInTheDocument();
		expect(screen.queryByText('Not Found')).not.toBeInTheDocument();

		fireEvent.click(card);

		expect(onSelect).not.toHaveBeenCalled();
	});
});
