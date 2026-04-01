import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentDrawer } from '../../../../../renderer/components/CuePipelineEditor/drawers/AgentDrawer';
import type { Theme } from '../../../../../renderer/types';

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: '#bd93f940',
		accentText: '#bd93f9',
		accentForeground: '#f8f8f2',
		border: '#44475a',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
	},
};

const mockGroups = [
	{ id: 'grp-1', name: 'Dev', emoji: '🛠️' },
	{ id: 'grp-2', name: 'Ops', emoji: '🚀' },
];

const mockSessions = [
	{ id: 'sess-1', name: 'Maestro', toolType: 'claude-code', groupId: 'grp-1' },
	{ id: 'sess-2', name: 'Codex Helper', toolType: 'codex', groupId: 'grp-2' },
	{ id: 'sess-3', name: 'Review Bot', toolType: 'claude-code', groupId: 'grp-1' },
];

describe('AgentDrawer', () => {
	it('should render all sessions when open', () => {
		render(
			<AgentDrawer isOpen={true} onClose={() => {}} sessions={mockSessions} theme={mockTheme} />
		);

		expect(screen.getByText('Maestro')).toBeInTheDocument();
		expect(screen.getByText('Codex Helper')).toBeInTheDocument();
		expect(screen.getByText('Review Bot')).toBeInTheDocument();
	});

	it('should filter sessions by name', () => {
		render(
			<AgentDrawer isOpen={true} onClose={() => {}} sessions={mockSessions} theme={mockTheme} />
		);

		const input = screen.getByPlaceholderText('Search agents...');
		fireEvent.change(input, { target: { value: 'maestro' } });

		expect(screen.getByText('Maestro')).toBeInTheDocument();
		expect(screen.queryByText('Codex Helper')).not.toBeInTheDocument();
		expect(screen.queryByText('Review Bot')).not.toBeInTheDocument();
	});

	it('should filter sessions by toolType', () => {
		render(
			<AgentDrawer isOpen={true} onClose={() => {}} sessions={mockSessions} theme={mockTheme} />
		);

		const input = screen.getByPlaceholderText('Search agents...');
		fireEvent.change(input, { target: { value: 'codex' } });

		expect(screen.getByText('Codex Helper')).toBeInTheDocument();
		expect(screen.queryByText('Maestro')).not.toBeInTheDocument();
	});

	it('should show empty state when no agents match', () => {
		render(
			<AgentDrawer isOpen={true} onClose={() => {}} sessions={mockSessions} theme={mockTheme} />
		);

		const input = screen.getByPlaceholderText('Search agents...');
		fireEvent.change(input, { target: { value: 'zzzznothing' } });

		expect(screen.getByText('No agents match')).toBeInTheDocument();
	});

	it('should show empty state when no sessions provided', () => {
		render(<AgentDrawer isOpen={true} onClose={() => {}} sessions={[]} theme={mockTheme} />);

		expect(screen.getByText('No agents available')).toBeInTheDocument();
	});

	it('should show on-canvas indicator for agents already on canvas', () => {
		const onCanvas = new Set(['sess-1']);
		render(
			<AgentDrawer
				isOpen={true}
				onClose={() => {}}
				sessions={mockSessions}
				onCanvasSessionIds={onCanvas}
				theme={mockTheme}
			/>
		);

		const indicators = screen.getAllByText('on canvas');
		expect(indicators).toHaveLength(1);
	});

	it('should group agents by user-defined groups', () => {
		render(
			<AgentDrawer
				isOpen={true}
				onClose={() => {}}
				sessions={mockSessions}
				groups={mockGroups}
				theme={mockTheme}
			/>
		);

		expect(screen.getByText('🛠️ Dev')).toBeInTheDocument();
		expect(screen.getByText('🚀 Ops')).toBeInTheDocument();
	});

	it('should alphabetize groups and agents within groups', () => {
		const groups = [
			{ id: 'grp-z', name: 'Zeta', emoji: '⚡' },
			{ id: 'grp-a', name: 'Alpha', emoji: '🅰️' },
		];
		const sessions = [
			{ id: 's1', name: 'Charlie', toolType: 'claude-code', groupId: 'grp-a' },
			{ id: 's2', name: 'Alice', toolType: 'claude-code', groupId: 'grp-a' },
			{ id: 's3', name: 'Bravo', toolType: 'codex', groupId: 'grp-z' },
			{ id: 's4', name: 'Delta', toolType: 'codex', groupId: 'grp-z' },
			{ id: 's5', name: 'Echo', toolType: 'codex' }, // ungrouped
		];

		const { container } = render(
			<AgentDrawer
				isOpen={true}
				onClose={() => {}}
				sessions={sessions}
				groups={groups}
				theme={mockTheme}
			/>
		);

		// Verify group order: Alpha before Zeta, Ungrouped last
		const groupHeaders = container.querySelectorAll('[style*="text-transform: uppercase"]');
		const headerTexts = Array.from(groupHeaders).map((el) => el.textContent);
		expect(headerTexts).toEqual(['🅰️ Alpha', '⚡ Zeta', 'Ungrouped']);

		// Verify agent order within each group by checking DOM order
		// Each draggable row: <div draggable> > <svg(Bot)> > <div(flex)> > <div(name)> + <div(toolType)>
		// The name is in the first div child with fontWeight:500
		const agentNames = Array.from(container.querySelectorAll('[draggable="true"]')).map(
			(el) => el.querySelector('[style*="font-weight: 500"]')?.textContent
		);
		expect(agentNames).toEqual(['Alice', 'Charlie', 'Bravo', 'Delta', 'Echo']);
	});

	it('should use theme colors for styling', () => {
		render(
			<AgentDrawer isOpen={true} onClose={() => {}} sessions={mockSessions} theme={mockTheme} />
		);

		const header = screen.getByText('Agents');
		expect(header).toHaveStyle({ color: mockTheme.colors.textMain });
	});

	it('should be hidden when not open', () => {
		const { container } = render(
			<AgentDrawer isOpen={false} onClose={() => {}} sessions={mockSessions} theme={mockTheme} />
		);

		const drawer = container.firstChild as HTMLElement;
		expect(drawer.style.transform).toBe('translateX(100%)');
	});

	it('should be visible when open', () => {
		const { container } = render(
			<AgentDrawer isOpen={true} onClose={() => {}} sessions={mockSessions} theme={mockTheme} />
		);

		const drawer = container.firstChild as HTMLElement;
		expect(drawer.style.transform).toBe('translateX(0)');
	});

	it('should make agent items draggable', () => {
		render(
			<AgentDrawer isOpen={true} onClose={() => {}} sessions={mockSessions} theme={mockTheme} />
		);

		const maestro = screen.getByText('Maestro').closest('[draggable]');
		expect(maestro).toHaveAttribute('draggable', 'true');
	});

	it('should auto-focus search input when drawer opens', () => {
		vi.useFakeTimers();
		render(
			<AgentDrawer isOpen={true} onClose={() => {}} sessions={mockSessions} theme={mockTheme} />
		);

		const input = screen.getByPlaceholderText('Search agents...');
		vi.advanceTimersByTime(100);
		expect(input).toHaveFocus();
		vi.useRealTimers();
	});
});
