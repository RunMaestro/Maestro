import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { CommandConfigPanel } from '../../../../../renderer/components/CuePipelineEditor/panels/CommandConfigPanel';
import { THEMES } from '../../../../../renderer/constants/themes';
import { flushAllPendingEdits } from '../../../../../renderer/hooks/cue/pendingEditsRegistry';
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
		// Picker is a ThemedSelect - closed by default; its trigger shows the placeholder
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
		// alphabetical (case-insensitive) - Alpha, Bravo, charlie, Zulu -
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

describe('CommandConfigPanel agent messages', () => {
	it('offers AI agents as message targets while allowing terminal agents to own shell commands', () => {
		const allSessions = [...sessions, { id: 'terminal-1', name: 'Terminal', toolType: 'terminal' }];
		render(
			<CommandConfigPanel
				node={makeCommandNode({ mode: 'cli', cliNewTab: true })}
				theme={theme}
				sessions={allSessions}
				onUpdateNode={vi.fn()}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: 'Owning agent' }));
		expect(screen.getByRole('option', { name: 'Terminal · terminal' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('option', { name: 'Alpha · claude-code' }));
		fireEvent.click(screen.getByRole('button', { name: 'Target agent' }));
		expect(screen.getByRole('option', { name: 'Alpha · claude-code' })).toBeInTheDocument();
		expect(screen.queryByRole('option', { name: 'Terminal · terminal' })).not.toBeInTheDocument();
	});

	it('starts a new agent message in a fresh tab owned by the selected agent', () => {
		const onUpdateNode = vi.fn();
		render(
			<CommandConfigPanel
				node={makeCommandNode({ owningSessionId: 'sess-a', owningSessionName: 'Alpha' })}
				theme={theme}
				sessions={sessions}
				onUpdateNode={onUpdateNode}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: 'Agent message' }));
		expect(onUpdateNode).toHaveBeenCalledWith('cmd-1', {
			mode: 'cli',
			cliCommand: 'send',
			cliTarget: 'sess-a',
			cliNewTab: true,
		});
	});

	it('keeps existing agent messages on their current tab until the new-tab option is selected', () => {
		const onUpdateNode = vi.fn();
		render(
			<CommandConfigPanel
				node={makeCommandNode({
					mode: 'cli',
					owningSessionId: 'sess-a',
					owningSessionName: 'Alpha',
					cliTarget: 'sess-a',
				})}
				theme={theme}
				sessions={sessions}
				onUpdateNode={onUpdateNode}
			/>
		);

		const checkbox = screen.getByRole('checkbox', { name: 'Run in a new agent tab' });
		expect(checkbox).not.toBeChecked();
		fireEvent.click(checkbox);
		expect(onUpdateNode).toHaveBeenCalledWith('cmd-1', { cliNewTab: true });
	});

	it.each([undefined, false, true])(
		'preserves an existing new-tab setting of %s when switching to shell and back',
		(cliNewTab) => {
			const onUpdateNode = vi.fn();
			const data: Partial<CommandNodeData> = {
				mode: 'cli',
				owningSessionId: 'sess-a',
				owningSessionName: 'Alpha',
				cliTarget: 'sess-b',
				cliNewTab,
			};
			const { rerender } = render(
				<CommandConfigPanel
					node={makeCommandNode(data)}
					theme={theme}
					sessions={sessions}
					onUpdateNode={onUpdateNode}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Agent message' }));
			expect(onUpdateNode).not.toHaveBeenCalled();
			fireEvent.click(screen.getByRole('button', { name: 'Shell command' }));
			expect(onUpdateNode).toHaveBeenLastCalledWith('cmd-1', {
				mode: 'shell',
				cliCommand: undefined,
			});
			rerender(
				<CommandConfigPanel
					node={makeCommandNode({ ...data, mode: 'shell' })}
					theme={theme}
					sessions={sessions}
					onUpdateNode={onUpdateNode}
				/>
			);
			fireEvent.click(screen.getByRole('button', { name: 'Agent message' }));
			expect(onUpdateNode).toHaveBeenLastCalledWith('cmd-1', {
				mode: 'cli',
				cliCommand: 'send',
				cliTarget: 'sess-b',
				cliNewTab,
			});
		}
	);

	it('leaves a terminal-owned message target empty so an AI agent can be selected', () => {
		const onUpdateNode = vi.fn();
		render(
			<CommandConfigPanel
				node={makeCommandNode({ owningSessionId: 'terminal-1', owningSessionName: 'Terminal' })}
				theme={theme}
				sessions={[...sessions, { id: 'terminal-1', name: 'Terminal', toolType: 'terminal' }]}
				onUpdateNode={onUpdateNode}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: 'Shell command' }));
		expect(onUpdateNode).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Agent message' }));
		expect(onUpdateNode).toHaveBeenCalledWith('cmd-1', {
			mode: 'cli',
			cliCommand: 'send',
			cliTarget: '',
			cliNewTab: true,
		});
	});

	it('flushes the chosen target and slash command with template arguments before saving', () => {
		const onUpdateNode = vi.fn();
		render(
			<CommandConfigPanel
				node={makeCommandNode({
					mode: 'cli',
					owningSessionId: 'sess-a',
					owningSessionName: 'Alpha',
					cliTarget: 'sess-a',
					cliNewTab: true,
				})}
				theme={theme}
				sessions={sessions}
				onUpdateNode={onUpdateNode}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: 'Target agent' }));
		fireEvent.click(screen.getByRole('option', { name: 'Bravo · codex' }));
		fireEvent.change(screen.getByRole('textbox', { name: 'Slash command or message (optional)' }), {
			target: { value: '/triage {{CUE_GH_NUMBER}}' },
		});
		act(() => flushAllPendingEdits());

		expect(onUpdateNode).toHaveBeenCalledWith('cmd-1', { cliTarget: 'sess-b' });
		expect(onUpdateNode).toHaveBeenCalledWith('cmd-1', {
			cliMessage: '/triage {{CUE_GH_NUMBER}}',
		});
		expect(screen.getByRole('checkbox', { name: 'Run in a new agent tab' })).toBeChecked();
	});
});
