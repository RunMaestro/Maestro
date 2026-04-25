import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentDrawer } from '../../../../../renderer/components/CuePipelineEditor/drawers/AgentDrawer';

import { mockTheme } from '../../../../helpers/mockTheme';
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

		// Verify group order: Alpha before Zeta, Ungrouped last. The top-level
		// "Nodes" header (standalone Command pill) is expected to appear first
		// above the agent groups.
		const groupHeaders = container.querySelectorAll('[style*="text-transform: uppercase"]');
		const headerTexts = Array.from(groupHeaders).map((el) => el.textContent);
		expect(headerTexts).toEqual(['Nodes', '🅰️ Alpha', '⚡ Zeta', 'Ungrouped']);

		// Verify agent order within each group by checking DOM order. Each agent
		// row: <div draggable> > <svg(Bot)> > <div(flex)> > <div(name)> + <div(toolType)>.
		// The name is in the first div child with fontWeight:500. Skip the
		// top-level standalone "Command" pill (also draggable, fontWeight:500) —
		// that's a node template, not an agent.
		const agentNames = Array.from(container.querySelectorAll('[draggable="true"]'))
			.map((el) => el.querySelector('[style*="font-weight: 500"]')?.textContent)
			.filter((name): name is string => !!name && name !== 'Command');
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

	describe('standalone Command pill', () => {
		it('renders a draggable Command pill in the Nodes section', () => {
			render(
				<AgentDrawer isOpen={true} onClose={() => {}} sessions={mockSessions} theme={mockTheme} />
			);

			expect(screen.getByText('Command')).toBeInTheDocument();
			expect(screen.getByText('shell or maestro-cli')).toBeInTheDocument();
			const pill = screen.getByTestId('command-pill');
			expect(pill).toHaveAttribute('draggable', 'true');
		});

		it('sets drag payload to an unbound command (no owningSessionId)', () => {
			render(
				<AgentDrawer isOpen={true} onClose={() => {}} sessions={mockSessions} theme={mockTheme} />
			);

			const pill = screen.getByTestId('command-pill');
			let dragPayload: string | null = null;
			const dataTransfer = {
				setData: (format: string, value: string) => {
					if (format === 'application/cue-pipeline') dragPayload = value;
				},
				effectAllowed: '',
			};
			fireEvent.dragStart(pill, { dataTransfer });

			expect(dragPayload).not.toBeNull();
			const parsed = JSON.parse(dragPayload!);
			expect(parsed).toEqual({ type: 'command' });
			// The drop handler takes undefined/'' owningSessionId as the "unbound"
			// signal — the user picks the owning agent in CommandConfigPanel.
			expect(parsed.owningSessionId).toBeUndefined();
		});

		it('hides the Command pill when searching (keeps results list clean)', () => {
			render(
				<AgentDrawer isOpen={true} onClose={() => {}} sessions={mockSessions} theme={mockTheme} />
			);

			const input = screen.getByPlaceholderText('Search agents...');
			fireEvent.change(input, { target: { value: 'maestro' } });

			expect(screen.queryByTestId('command-pill')).not.toBeInTheDocument();
		});

		it('does not render per-agent terminal drag handles on session rows', () => {
			// Sanity check that the legacy "Terminal icon on each row" pattern
			// is gone — agent rows should have exactly one draggable ancestor
			// (the row itself), not a nested one.
			const { container } = render(
				<AgentDrawer isOpen={true} onClose={() => {}} sessions={mockSessions} theme={mockTheme} />
			);

			const maestroRow = screen.getByText('Maestro').closest('[draggable="true"]');
			expect(maestroRow).not.toBeNull();
			const nestedDraggable = maestroRow!.querySelector('[draggable="true"]');
			expect(nestedDraggable).toBeNull();

			// And the old footer hint is gone.
			expect(container.textContent).not.toMatch(/Drag the.*on a session row/i);
		});
	});
});
