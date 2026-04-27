import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandConfigPanel } from '../../../../../renderer/components/CuePipelineEditor/panels/CommandConfigPanel';
import { THEMES } from '../../../../../renderer/constants/themes';
import type {
	CommandNodeData,
	CuePipelineSessionInfo,
	PipelineNode,
} from '../../../../../shared/cue-pipeline-types';

const theme = THEMES['dracula'];

function makeCommandNode(data: Partial<CommandNodeData>): PipelineNode {
	return {
		id: 'cmd-1',
		type: 'command',
		position: { x: 0, y: 0 },
		data: {
			name: 'lint',
			mode: 'shell',
			shell: '',
			owningSessionId: '',
			owningSessionName: '',
			...data,
		} satisfies CommandNodeData,
	};
}

const sessions: CuePipelineSessionInfo[] = [
	{ id: 'sess-a', name: 'Alpha', toolType: 'claude-code' },
	{ id: 'sess-b', name: 'Bravo', toolType: 'codex' },
];

describe('CommandConfigPanel owning-session picker', () => {
	it('renders the picker when the command is unbound', () => {
		render(
			<CommandConfigPanel
				node={makeCommandNode({ owningSessionId: '' })}
				theme={theme}
				sessions={sessions}
				onUpdateNode={vi.fn()}
			/>
		);

		expect(screen.getByText('Choose an owning agent')).toBeInTheDocument();
		// Picker is a ThemedSelect — closed by default; its trigger shows the placeholder
		expect(screen.getByText('Select an agent…')).toBeInTheDocument();
		// Opening the menu exposes each session as an option
		fireEvent.click(screen.getByText('Select an agent…'));
		expect(screen.getByText(/Alpha · claude-code/)).toBeInTheDocument();
		expect(screen.getByText(/Bravo · codex/)).toBeInTheDocument();
	});

	it('writes owningSessionId and owningSessionName when the user picks an agent', () => {
		const onUpdateNode = vi.fn();
		render(
			<CommandConfigPanel
				node={makeCommandNode({ owningSessionId: '' })}
				theme={theme}
				sessions={sessions}
				onUpdateNode={onUpdateNode}
			/>
		);

		// Open the picker and choose Bravo
		fireEvent.click(screen.getByText('Select an agent…'));
		fireEvent.click(screen.getByText(/Bravo · codex/));

		expect(onUpdateNode).toHaveBeenCalledWith('cmd-1', {
			owningSessionId: 'sess-b',
			owningSessionName: 'Bravo',
		});
	});

	it('hides the picker once the command is bound and shows the read-only pill', () => {
		render(
			<CommandConfigPanel
				node={makeCommandNode({ owningSessionId: 'sess-a', owningSessionName: 'Alpha' })}
				theme={theme}
				sessions={sessions}
				onUpdateNode={vi.fn()}
			/>
		);

		expect(screen.queryByText('Choose an owning agent')).not.toBeInTheDocument();
		expect(screen.getByText('Alpha')).toBeInTheDocument();
		expect(screen.getByText(/project root provides cwd/i)).toBeInTheDocument();
		expect(screen.getByTitle('Unbind to pick a different session')).toBeInTheDocument();
	});

	it('alphabetizes the agent picker options regardless of input order', () => {
		const unsorted: CuePipelineSessionInfo[] = [
			{ id: 'sess-z', name: 'Zulu', toolType: 'claude-code' },
			{ id: 'sess-c', name: 'charlie', toolType: 'codex' },
			{ id: 'sess-a', name: 'Alpha', toolType: 'claude-code' },
			{ id: 'sess-b', name: 'Bravo', toolType: 'codex' },
		];

		render(
			<CommandConfigPanel
				node={makeCommandNode({ owningSessionId: '' })}
				theme={theme}
				sessions={unsorted}
				onUpdateNode={vi.fn()}
			/>
		);

		fireEvent.click(screen.getByText('Select an agent…'));

		// All four real options should render; their DOM order should be
		// alphabetical (case-insensitive) — Alpha, Bravo, charlie, Zulu —
		// not the input order (Zulu, charlie, Alpha, Bravo).
		const optionLabels = screen
			.getAllByRole('option')
			.map((el) => el.textContent ?? '')
			.filter((t) => t !== 'Select an agent…');
		expect(optionLabels).toEqual([
			'Alpha · claude-code',
			'Bravo · codex',
			'charlie · codex',
			'Zulu · claude-code',
		]);
	});

	it('renders a filter input in the agent picker and narrows by label', () => {
		const many: CuePipelineSessionInfo[] = [
			{ id: 'sess-a', name: 'Alpha', toolType: 'claude-code' },
			{ id: 'sess-b', name: 'Bravo', toolType: 'codex' },
			{ id: 'sess-c', name: 'Charlie', toolType: 'claude-code' },
		];

		render(
			<CommandConfigPanel
				node={makeCommandNode({ owningSessionId: '' })}
				theme={theme}
				sessions={many}
				onUpdateNode={vi.fn()}
			/>
		);

		fireEvent.click(screen.getByText('Select an agent…'));
		const filter = screen.getByPlaceholderText('Filter agents…');
		expect(filter).toBeInTheDocument();

		fireEvent.change(filter, { target: { value: 'char' } });
		expect(screen.getByRole('option', { name: /Charlie · claude-code/ })).toBeInTheDocument();
		expect(screen.queryByRole('option', { name: /Alpha/ })).not.toBeInTheDocument();
		expect(screen.queryByRole('option', { name: /Bravo/ })).not.toBeInTheDocument();
	});

	it('clears the owning session when the user clicks Change', () => {
		const onUpdateNode = vi.fn();
		render(
			<CommandConfigPanel
				node={makeCommandNode({ owningSessionId: 'sess-a', owningSessionName: 'Alpha' })}
				theme={theme}
				sessions={sessions}
				onUpdateNode={onUpdateNode}
			/>
		);

		fireEvent.click(screen.getByText('Change'));

		expect(onUpdateNode).toHaveBeenCalledWith('cmd-1', {
			owningSessionId: '',
			owningSessionName: '',
		});
	});
});
