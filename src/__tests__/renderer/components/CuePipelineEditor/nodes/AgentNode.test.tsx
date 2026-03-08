import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { AgentNode } from '../../../../../renderer/components/CuePipelineEditor/nodes/AgentNode';
import { ReactFlowProvider } from 'reactflow';
import type { NodeProps } from 'reactflow';
import type { AgentNodeDataProps } from '../../../../../renderer/components/CuePipelineEditor/nodes/AgentNode';

const defaultData: AgentNodeDataProps = {
	compositeId: 'pipeline-1:agent-1',
	sessionId: 'sess-1',
	sessionName: 'Test Agent',
	toolType: 'claude-code',
	hasPrompt: false,
	hasOutgoingEdge: false,
	pipelineColor: '#06b6d4',
	pipelineCount: 1,
	pipelineColors: ['#06b6d4'],
};

function renderAgentNode(overrides: Partial<AgentNodeDataProps> = {}) {
	const data = { ...defaultData, ...overrides };
	const props = {
		id: 'test-node',
		data,
		type: 'agent',
		selected: false,
		isConnectable: true,
		xPos: 0,
		yPos: 0,
		zIndex: 0,
		dragging: false,
	} as NodeProps<AgentNodeDataProps>;

	return render(
		<ReactFlowProvider>
			<AgentNode {...props} />
		</ReactFlowProvider>
	);
}

describe('AgentNode', () => {
	it('should render session name and tool type', () => {
		const { getByText } = renderAgentNode();

		expect(getByText('Test Agent')).toBeInTheDocument();
		expect(getByText('claude-code')).toBeInTheDocument();
	});

	it('should not clip badge overflow (overflow: visible on root)', () => {
		const { container } = renderAgentNode({ pipelineCount: 3 });

		// Find the agent node root div (variable width with min-width, position: relative)
		const rootDiv = container.querySelector('div[style*="min-width: 180px"]') as HTMLElement;
		expect(rootDiv).not.toBeNull();
		expect(rootDiv.style.overflow).toBe('visible');
	});

	it('should render a drag handle with the drag-handle class', () => {
		const { container } = renderAgentNode();
		const dragHandle = container.querySelector('.drag-handle');
		expect(dragHandle).not.toBeNull();
	});

	it('should render a gear icon for configuration', () => {
		const { container } = renderAgentNode();
		// Gear icon area has title="Configure"
		const gearButton = container.querySelector('[title="Configure"]');
		expect(gearButton).not.toBeNull();
	});

	it('should show pipeline count badge when pipelineCount > 1', () => {
		const { getByText } = renderAgentNode({ pipelineCount: 3 });

		expect(getByText('3')).toBeInTheDocument();
	});

	it('should not show pipeline count badge when pipelineCount is 1', () => {
		const { queryByText } = renderAgentNode({ pipelineCount: 1 });

		// No badge number should be rendered
		const badge = queryByText('1');
		expect(badge).toBeNull();
	});

	it('should show multi-pipeline color dots when multiple colors', () => {
		const { container } = renderAgentNode({
			pipelineColors: ['#06b6d4', '#8b5cf6', '#f59e0b'],
		});

		// Find color dots (8x8 circles)
		const dots = container.querySelectorAll(
			'div[style*="border-radius: 50%"][style*="width: 8px"]'
		);
		expect(dots.length).toBe(3);
	});

	it('should not show multi-pipeline dots with single color', () => {
		const { container } = renderAgentNode({
			pipelineColors: ['#06b6d4'],
		});

		// No color strip should render
		const dots = container.querySelectorAll(
			'div[style*="border-radius: 50%"][style*="width: 8px"]'
		);
		expect(dots.length).toBe(0);
	});

	it('should show prompt icon when hasPrompt is true', () => {
		const { container } = renderAgentNode({ hasPrompt: true });

		// MessageSquare icon renders as an SVG
		const svg = container.querySelector('svg');
		expect(svg).not.toBeNull();
	});
});
