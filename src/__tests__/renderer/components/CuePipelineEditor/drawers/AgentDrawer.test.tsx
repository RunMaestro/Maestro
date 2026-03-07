import { describe, it, expect } from 'vitest';
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

		const indicators = screen.getAllByTitle('On canvas');
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
});
