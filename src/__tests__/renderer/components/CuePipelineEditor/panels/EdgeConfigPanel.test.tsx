import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EdgeConfigPanel } from '../../../../../renderer/components/CuePipelineEditor/panels/EdgeConfigPanel';
import { THEMES } from '../../../../../renderer/constants/themes';
import type {
	PipelineEdge,
	PipelineNode,
	TriggerNodeData,
	AgentNodeData,
} from '../../../../../shared/cue-pipeline-types';

const darkTheme = THEMES['dracula'];
const lightTheme = THEMES['github-light'];

const sourceNode: PipelineNode = {
	id: 'trigger-1',
	type: 'trigger',
	position: { x: 0, y: 0 },
	data: { eventType: 'time.heartbeat', label: 'Heartbeat', config: {} } as TriggerNodeData,
};

const targetNode: PipelineNode = {
	id: 'agent-1',
	type: 'agent',
	position: { x: 200, y: 0 },
	data: { sessionId: 's1', sessionName: 'Agent 1', toolType: 'claude-code' } as AgentNodeData,
};

const edge: PipelineEdge = {
	id: 'edge-1',
	source: 'trigger-1',
	target: 'agent-1',
	mode: 'pass',
};

describe('EdgeConfigPanel', () => {
	it('renders nothing when selectedEdge is null', () => {
		const { container } = render(
			<EdgeConfigPanel
				selectedEdge={null}
				sourceNode={null}
				targetNode={null}
				pipelineColor="#06b6d4"
				theme={darkTheme}
				onUpdateEdge={vi.fn()}
				onDeleteEdge={vi.fn()}
			/>
		);
		expect(container.innerHTML).toBe('');
	});

	it('renders panel with theme background', () => {
		const { container } = render(
			<EdgeConfigPanel
				selectedEdge={edge}
				sourceNode={sourceNode}
				targetNode={targetNode}
				pipelineColor="#06b6d4"
				theme={lightTheme}
				onUpdateEdge={vi.fn()}
				onDeleteEdge={vi.fn()}
			/>
		);
		const panel = container.firstElementChild as HTMLElement;
		expect(panel).toHaveStyle({ backgroundColor: lightTheme.colors.bgMain });
	});

	it('renders header text with theme colors', () => {
		render(
			<EdgeConfigPanel
				selectedEdge={edge}
				sourceNode={sourceNode}
				targetNode={targetNode}
				pipelineColor="#06b6d4"
				theme={darkTheme}
				onUpdateEdge={vi.fn()}
				onDeleteEdge={vi.fn()}
			/>
		);
		const title = screen.getByText('Connection Settings');
		expect(title).toHaveStyle({ color: darkTheme.colors.textMain });
	});

	it('calls onDeleteEdge when delete button clicked', () => {
		const onDeleteEdge = vi.fn();
		render(
			<EdgeConfigPanel
				selectedEdge={edge}
				sourceNode={sourceNode}
				targetNode={targetNode}
				pipelineColor="#06b6d4"
				theme={darkTheme}
				onUpdateEdge={vi.fn()}
				onDeleteEdge={onDeleteEdge}
			/>
		);
		const deleteBtn = screen.getByTitle('Delete connection');
		fireEvent.click(deleteBtn);
		expect(onDeleteEdge).toHaveBeenCalledWith('edge-1');
	});
});
