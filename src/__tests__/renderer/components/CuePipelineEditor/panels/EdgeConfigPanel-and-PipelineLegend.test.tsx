import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { EdgeConfigPanel } from '../../../../../renderer/components/CuePipelineEditor/panels/EdgeConfigPanel';
import { THEMES } from '../../../../../renderer/constants/themes';
import type { PipelineEdge } from '../../../../../shared/cue-pipeline-types';
import type { PipelineNode } from '../../../../../shared/cue-pipeline-types';
import type { TriggerNodeData } from '../../../../../shared/cue-pipeline-types';
import type { AgentNodeData } from '../../../../../shared/cue-pipeline-types';
import { PipelineLegend } from '../../../../../renderer/components/CuePipelineEditor/panels/PipelineLegend';
import type { CuePipeline } from '../../../../../shared/cue-pipeline-types';
__maestroMicrobenchDescribe('EdgeConfigPanel', () => {
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
});
__maestroMicrobenchDescribe('PipelineLegend', () => {
	const theme = {
		colors: {
			bgActivity: '#111',
			border: '#333',
			textMain: '#fff',
			textDim: '#aaa',
			accent: '#09f',
		},
	} as any;

	function p(id: string, name: string, color: string, nodes: unknown[] = []): CuePipeline {
		return { id, name, color, nodes: nodes as any, edges: [] };
	}

	describe('PipelineLegend', () => {
		it('renders a button per pipeline when in All-Pipelines view', () => {
			render(
				<PipelineLegend
					pipelines={[p('a', 'Alpha', '#f00'), p('b', 'Beta', '#0f0')]}
					selectedPipelineId={null}
					selectPipeline={vi.fn()}
					theme={theme}
				/>
			);
			expect(screen.getByTitle('Switch to Alpha')).toBeTruthy();
			expect(screen.getByTitle('Switch to Beta')).toBeTruthy();
		});

		it('renders nothing when selectedPipelineId is set', () => {
			const { container } = render(
				<PipelineLegend
					pipelines={[p('a', 'Alpha', '#f00')]}
					selectedPipelineId="a"
					selectPipeline={vi.fn()}
					theme={theme}
				/>
			);
			expect(container.firstChild).toBeNull();
		});

		it('renders nothing with zero pipelines', () => {
			const { container } = render(
				<PipelineLegend
					pipelines={[]}
					selectedPipelineId={null}
					selectPipeline={vi.fn()}
					theme={theme}
				/>
			);
			expect(container.firstChild).toBeNull();
		});

		it('clicking a legend button calls selectPipeline with that id', () => {
			const selectPipeline = vi.fn();
			render(
				<PipelineLegend
					pipelines={[p('a', 'Alpha', '#f00')]}
					selectedPipelineId={null}
					selectPipeline={selectPipeline}
					theme={theme}
				/>
			);
			fireEvent.click(screen.getByTitle('Switch to Alpha'));
			expect(selectPipeline).toHaveBeenCalledWith('a');
		});

		it('shows node count per pipeline', () => {
			render(
				<PipelineLegend
					pipelines={[p('a', 'Alpha', '#f00', [{}, {}, {}])]}
					selectedPipelineId={null}
					selectPipeline={vi.fn()}
					theme={theme}
				/>
			);
			expect(screen.getByText('(3)')).toBeTruthy();
		});
	});
});
