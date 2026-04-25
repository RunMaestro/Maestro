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
