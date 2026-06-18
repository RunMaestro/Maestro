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

	it('remounts AgentConfigPanel when the selected node changes (prevents debounce race)', () => {
		// Regression guard for the "switching agents swaps/erases prompts"
		// bug: without `key={selectedNode.id}`, a pending debounced write from
		// agent A's panel could commit to agent B after the panel reparents.
		// The cheapest observable is that the child AgentConfigPanel mock's
		// text content changes to the new node id — which requires a real
		// DOM update per render — and that the container's child is the
		// same element when the SAME id is passed twice (no needless remount).
		const otherAgent: PipelineNode = {
			...agentNode,
			id: 'agent-2',
			data: {
				...(agentNode.data as AgentNodeData),
				sessionName: 'Other Agent',
				sessionId: 'sess-2',
			},
		};

		const { rerender, getByTestId } = render(
			<NodeConfigPanel
				selectedNode={agentNode}
				pipelines={defaultPipelines}
				theme={darkTheme}
				onUpdateNode={vi.fn()}
				onDeleteNode={vi.fn()}
			/>
		);
		const firstPanel = getByTestId('agent-config');
		expect(firstPanel.textContent).toBe('agent-1');

		// Same id → React should reuse the DOM node (no remount).
		rerender(
			<NodeConfigPanel
				selectedNode={{ ...agentNode }}
				pipelines={defaultPipelines}
				theme={darkTheme}
				onUpdateNode={vi.fn()}
				onDeleteNode={vi.fn()}
			/>
		);
		expect(getByTestId('agent-config')).toBe(firstPanel);

		// Different id → React must swap the DOM node (actual remount).
		rerender(
			<NodeConfigPanel
				selectedNode={otherAgent}
				pipelines={defaultPipelines}
				theme={darkTheme}
				onUpdateNode={vi.fn()}
				onDeleteNode={vi.fn()}
			/>
		);
		const secondPanel = getByTestId('agent-config');
		expect(secondPanel.textContent).toBe('agent-2');
		expect(secondPanel).not.toBe(firstPanel);
	});

	// Regression for 96a87a19c: when multiple agent visual nodes share a
	// `sessionId` within a pipeline, the canvas labels them "Agent (1)",
	// "Agent (2)" via pipelineGraph's per-pipeline session-index logic. The
	// config panel header used to show just "Agent", leaving the user unsure
	// which instance their edits applied to. The fix mirrors the canvas's
	// suffix in the panel header.
	describe('agent instance suffix (regression: ambiguous header for shared sessionId)', () => {
		function makeAgent(id: string, sessionId: string, sessionName: string): PipelineNode {
			return {
				id,
				type: 'agent',
				position: { x: 0, y: 0 },
				data: {
					sessionId,
					sessionName,
					toolType: 'claude-code',
				} as AgentNodeData,
			};
		}

		// Helper: the header span concatenates the sessionName text node and
		// the IIFE-returned suffix text node into one element. testing-library's
		// `getByText` normalizes whitespace and compares the *full* text content
		// of an element, so we match against the combined string.
		function getAgentHeaderSpan(): HTMLElement {
			return screen.getByText((_content, element) => {
				if (!element || element.tagName !== 'SPAN') return false;
				const txt = element.textContent ?? '';
				// Bold-weight header span — discriminate from sibling pill spans
				// (which carry toolType / status). 600-weight is set inline above.
				return /^(Test Agent|Pedsidian|Floating Agent)( \(\d+\))?$/.test(txt);
			}) as HTMLElement;
		}

		it('omits the suffix when only one node uses this sessionId in the pipeline', () => {
			const pipeline: CuePipeline = {
				id: 'p1',
				name: 'P1',
				color: '#06b6d4',
				nodes: [makeAgent('agent-1', 'sess-1', 'Test Agent')],
				edges: [],
			};

			render(
				<NodeConfigPanel
					selectedNode={pipeline.nodes[0]}
					pipelines={[pipeline]}
					theme={darkTheme}
					onUpdateNode={vi.fn()}
					onDeleteNode={vi.fn()}
				/>
			);

			// Header text is just the name — no parenthetical suffix.
			expect(getAgentHeaderSpan().textContent).toBe('Test Agent');
		});

		it('appends "(1)" / "(2)" when multiple visual nodes share the same sessionId', () => {
			// Two agent nodes pointing at the same backing session — exactly the
			// shape pipelineGraph indexes with the (N) suffix on the canvas.
			const a = makeAgent('agent-1', 'sess-1', 'Pedsidian');
			const b = makeAgent('agent-2', 'sess-1', 'Pedsidian');
			const pipeline: CuePipeline = {
				id: 'p1',
				name: 'P1',
				color: '#06b6d4',
				nodes: [a, b],
				edges: [],
			};

			const { rerender } = render(
				<NodeConfigPanel
					selectedNode={a}
					pipelines={[pipeline]}
					theme={darkTheme}
					onUpdateNode={vi.fn()}
					onDeleteNode={vi.fn()}
				/>
			);

			// First instance — header reads exactly "Pedsidian (1)".
			expect(getAgentHeaderSpan().textContent).toBe('Pedsidian (1)');

			rerender(
				<NodeConfigPanel
					selectedNode={b}
					pipelines={[pipeline]}
					theme={darkTheme}
					onUpdateNode={vi.fn()}
					onDeleteNode={vi.fn()}
				/>
			);

			expect(getAgentHeaderSpan().textContent).toBe('Pedsidian (2)');
		});

		it('isolates the suffix per pipeline (does not leak across siblings)', () => {
			// Two pipelines each with one node sharing the same sessionId.
			// Within either pipeline, only one node uses that sessionId, so
			// neither header gets a suffix. This guards the "find the OWNING
			// pipeline first" rule — without it, the implementation could
			// scan all pipelines and double-count.
			const aP1 = makeAgent('agent-1', 'sess-1', 'Pedsidian');
			const aP2 = makeAgent('agent-2', 'sess-1', 'Pedsidian');
			const p1: CuePipeline = {
				id: 'p1',
				name: 'P1',
				color: '#06b6d4',
				nodes: [aP1],
				edges: [],
			};
			const p2: CuePipeline = {
				id: 'p2',
				name: 'P2',
				color: '#a855f7',
				nodes: [aP2],
				edges: [],
			};

			render(
				<NodeConfigPanel
					selectedNode={aP1}
					pipelines={[p1, p2]}
					theme={darkTheme}
					onUpdateNode={vi.fn()}
					onDeleteNode={vi.fn()}
				/>
			);

			expect(getAgentHeaderSpan().textContent).toBe('Pedsidian');
		});

		it('omits the suffix when the selected node is not present in any pipeline', () => {
			// Defensive: the IIFE returns '' when `owningPipeline` is undefined.
			// This shape can happen if the panel renders during a transient
			// state where the node was deleted but the selectedNode prop has
			// not yet flushed.
			const orphan = makeAgent('agent-orphan', 'sess-1', 'Floating Agent');

			render(
				<NodeConfigPanel
					selectedNode={orphan}
					pipelines={[]}
					theme={darkTheme}
					onUpdateNode={vi.fn()}
					onDeleteNode={vi.fn()}
				/>
			);

			expect(getAgentHeaderSpan().textContent).toBe('Floating Agent');
		});
	});
});
