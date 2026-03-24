import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NodeConfigPanel } from '../../../../../renderer/components/CuePipelineEditor/panels/NodeConfigPanel';
import { THEMES } from '../../../../../renderer/constants/themes';
import type {
	PipelineNode,
	TriggerNodeData,
	AgentNodeData,
	CuePipeline,
} from '../../../../../shared/cue-pipeline-types';

vi.mock('../../../../../renderer/components/CuePipelineEditor/panels/triggers', () => ({
	TriggerConfig: ({ node }: { node: PipelineNode }) => (
		<div data-testid="trigger-config">{node.id}</div>
	),
}));

vi.mock('../../../../../renderer/components/CuePipelineEditor/panels/AgentConfigPanel', () => ({
	AgentConfigPanel: ({ node }: { node: PipelineNode }) => (
		<div data-testid="agent-config">{node.id}</div>
	),
}));

const darkTheme = THEMES['dracula'];
const lightTheme = THEMES['github-light'];

const triggerNode: PipelineNode = {
	id: 'trigger-1',
	type: 'trigger',
	position: { x: 0, y: 0 },
	data: {
		eventType: 'time.heartbeat',
		label: 'Heartbeat',
		config: { interval_minutes: 30 },
	} as TriggerNodeData,
};

const agentNode: PipelineNode = {
	id: 'agent-1',
	type: 'agent',
	position: { x: 0, y: 0 },
	data: {
		sessionId: 'sess-1',
		sessionName: 'Test Agent',
		toolType: 'claude-code',
	} as AgentNodeData,
};

const defaultPipelines: CuePipeline[] = [];

describe('NodeConfigPanel', () => {
	it('renders nothing when selectedNode is null', () => {
		const { container } = render(
			<NodeConfigPanel
				selectedNode={null}
				pipelines={defaultPipelines}
				theme={darkTheme}
				onUpdateNode={vi.fn()}
				onDeleteNode={vi.fn()}
			/>
		);
		expect(container.innerHTML).toBe('');
	});

	it('renders trigger config header with theme colors', () => {
		const { container } = render(
			<NodeConfigPanel
				selectedNode={triggerNode}
				pipelines={defaultPipelines}
				theme={lightTheme}
				onUpdateNode={vi.fn()}
				onDeleteNode={vi.fn()}
			/>
		);
		const panel = container.firstElementChild as HTMLElement;
		expect(panel).toHaveStyle({ backgroundColor: lightTheme.colors.bgMain });
	});

	it('renders agent config header text with theme textMain', () => {
		render(
			<NodeConfigPanel
				selectedNode={agentNode}
				pipelines={defaultPipelines}
				theme={darkTheme}
				onUpdateNode={vi.fn()}
				onDeleteNode={vi.fn()}
			/>
		);
		const nameEl = screen.getByText('Test Agent');
		expect(nameEl).toHaveStyle({ color: darkTheme.colors.textMain });
	});

	it('uses theme border color for panel borders', () => {
		const { container } = render(
			<NodeConfigPanel
				selectedNode={triggerNode}
				pipelines={defaultPipelines}
				theme={lightTheme}
				onUpdateNode={vi.fn()}
				onDeleteNode={vi.fn()}
			/>
		);
		const panel = container.firstElementChild as HTMLElement;
		expect(panel).toHaveStyle({ borderTop: `1px solid ${lightTheme.colors.border}` });
	});

	it('calls onDeleteNode when delete button clicked', () => {
		const onDeleteNode = vi.fn();
		render(
			<NodeConfigPanel
				selectedNode={triggerNode}
				pipelines={defaultPipelines}
				theme={darkTheme}
				onUpdateNode={vi.fn()}
				onDeleteNode={onDeleteNode}
			/>
		);
		const deleteBtn = screen.getByTitle('Delete node');
		fireEvent.click(deleteBtn);
		expect(onDeleteNode).toHaveBeenCalledWith('trigger-1');
	});
});
