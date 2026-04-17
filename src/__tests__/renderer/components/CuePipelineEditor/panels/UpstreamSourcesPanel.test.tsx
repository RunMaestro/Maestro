import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UpstreamSourcesPanel } from '../../../../../renderer/components/CuePipelineEditor/panels/UpstreamSourcesPanel';
import { THEMES } from '../../../../../renderer/constants/themes';
import type {
	AgentNodeData,
	CuePipeline,
	IncomingAgentEdgeInfo,
	PipelineEdge,
	PipelineNode,
} from '../../../../../shared/cue-pipeline-types';

const theme = THEMES['dracula'];

function agentNode(id: string, sessionName: string): PipelineNode {
	return {
		id,
		type: 'agent',
		position: { x: 0, y: 0 },
		data: { sessionId: `s-${id}`, sessionName, toolType: 'claude-code' } as AgentNodeData,
	};
}

function edge(
	id: string,
	source: string,
	target: string,
	overrides: Partial<PipelineEdge> = {}
): PipelineEdge {
	return { id, source, target, mode: 'pass', ...overrides };
}

function incomingEdge(
	id: string,
	sourceNodeId: string,
	sourceSessionName: string,
	overrides: Partial<IncomingAgentEdgeInfo> = {}
): IncomingAgentEdgeInfo {
	return {
		edgeId: id,
		sourceNodeId,
		sourceSessionName,
		includeUpstreamOutput: true,
		forwardOutput: false,
		...overrides,
	};
}

describe('UpstreamSourcesPanel', () => {
	it('renders nothing when there are no direct or forwarded sources', () => {
		const { container } = render(
			<UpstreamSourcesPanel theme={theme} incomingAgentEdges={[]} onUpdateEdge={vi.fn()} />
		);
		expect(container.innerHTML).toBe('');
	});

	describe('direct source controls', () => {
		it('dispatches includeUpstreamOutput updates from the Include checkbox', () => {
			const onUpdateEdge = vi.fn();
			render(
				<UpstreamSourcesPanel
					theme={theme}
					incomingAgentEdges={[incomingEdge('e1', 'a1', 'Agent A')]}
					onUpdateEdge={onUpdateEdge}
				/>
			);
			fireEvent.click(screen.getByLabelText('Include', { selector: 'input' }));
			expect(onUpdateEdge).toHaveBeenCalledWith('e1', { includeUpstreamOutput: false });
		});

		it('dispatches forwardOutput updates from the Forward checkbox', () => {
			const onUpdateEdge = vi.fn();
			render(
				<UpstreamSourcesPanel
					theme={theme}
					incomingAgentEdges={[incomingEdge('e1', 'a1', 'Agent A')]}
					onUpdateEdge={onUpdateEdge}
				/>
			);
			fireEvent.click(screen.getByLabelText('Forward', { selector: 'input' }));
			expect(onUpdateEdge).toHaveBeenCalledWith('e1', { forwardOutput: true });
		});

		it('renders the per-source CUE_OUTPUT token chip when Include is on', () => {
			render(
				<UpstreamSourcesPanel
					theme={theme}
					incomingAgentEdges={[incomingEdge('e1', 'a1', 'Agent A')]}
					onUpdateEdge={vi.fn()}
				/>
			);
			expect(screen.getByText(/CUE_OUTPUT_AGENT_A/)).toBeDefined();
		});

		it('renders CUE_FORWARDED chip when Forward is on', () => {
			render(
				<UpstreamSourcesPanel
					theme={theme}
					incomingAgentEdges={[incomingEdge('e1', 'a1', 'Agent A', { forwardOutput: true })]}
					onUpdateEdge={vi.fn()}
				/>
			);
			expect(screen.getByText(/CUE_FORWARDED_AGENT_A/)).toBeDefined();
		});
	});

	describe('forwarded sources', () => {
		function makeChainPipeline(): CuePipeline {
			// A → B → C, with A→B forwardOutput=true so A is a forwarded source
			// of C reached via B.
			return {
				id: 'p1',
				name: 'Chain',
				color: '#06b6d4',
				nodes: [agentNode('a', 'Agent A'), agentNode('b', 'Agent B'), agentNode('c', 'Agent C')],
				edges: [edge('e-ab', 'a', 'b', { forwardOutput: true }), edge('e-bc', 'b', 'c')],
			};
		}

		it('lists forwarded sources with a "via" label and CUE_FORWARDED chip', () => {
			const pipeline = makeChainPipeline();
			render(
				<UpstreamSourcesPanel
					theme={theme}
					incomingAgentEdges={[incomingEdge('e-bc', 'b', 'Agent B')]}
					onUpdateEdge={vi.fn()}
					pipeline={pipeline}
					targetNodeId="c"
				/>
			);
			expect(screen.getByText('Agent A')).toBeDefined();
			expect(screen.getByText(/via Agent B/)).toBeDefined();
			expect(screen.getByText(/CUE_FORWARDED_AGENT_A/)).toBeDefined();
		});

		it('hides forwarded section when there are no transitive sources', () => {
			const pipeline: CuePipeline = {
				id: 'p1',
				name: 'Chain',
				color: '#06b6d4',
				nodes: [agentNode('b', 'Agent B'), agentNode('c', 'Agent C')],
				edges: [edge('e-bc', 'b', 'c')],
			};
			render(
				<UpstreamSourcesPanel
					theme={theme}
					incomingAgentEdges={[incomingEdge('e-bc', 'b', 'Agent B')]}
					onUpdateEdge={vi.fn()}
					pipeline={pipeline}
					targetNodeId="c"
				/>
			);
			// No "via" labels should appear.
			expect(screen.queryByText(/^via /)).toBeNull();
		});

		it('renders when a node has only forwarded sources and no direct edges', () => {
			// D has a single direct edge but the panel should still list A (forwarded
			// via B) alongside the B row.
			const pipeline: CuePipeline = {
				id: 'p1',
				name: 'Chain',
				color: '#06b6d4',
				nodes: [agentNode('a', 'Agent A'), agentNode('b', 'Agent B'), agentNode('c', 'Agent C')],
				edges: [edge('e-ab', 'a', 'b', { forwardOutput: true }), edge('e-bc', 'b', 'c')],
			};
			render(
				<UpstreamSourcesPanel
					theme={theme}
					incomingAgentEdges={[incomingEdge('e-bc', 'b', 'Agent B')]}
					onUpdateEdge={vi.fn()}
					pipeline={pipeline}
					targetNodeId="c"
				/>
			);
			expect(screen.getByText('Agent A')).toBeDefined();
			expect(screen.getByText('Agent B')).toBeDefined();
		});
	});
});
