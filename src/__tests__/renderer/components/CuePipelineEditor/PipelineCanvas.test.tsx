import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { mockTheme } from '../../../helpers/mockTheme';
import {
	PipelineCanvas,
	PipelineCanvasProps,
} from '../../../../renderer/components/CuePipelineEditor/PipelineCanvas';

vi.mock('reactflow', () => {
	const MockReactFlow = (props: any) => <div data-testid="react-flow">{props.children}</div>;
	return {
		default: MockReactFlow,
		Background: () => <div data-testid="rf-background" />,
		Controls: () => <div data-testid="rf-controls" />,
		MiniMap: () => <div data-testid="rf-minimap" />,
		ConnectionMode: { Loose: 'loose' },
		ConnectionLineType: { Bezier: 'bezier' },
	};
});

vi.mock('../../../../renderer/components/CuePipelineEditor/nodes/TriggerNode', () => ({
	TriggerNode: () => <div />,
}));
vi.mock('../../../../renderer/components/CuePipelineEditor/nodes/AgentNode', () => ({
	AgentNode: () => <div />,
}));
vi.mock('../../../../renderer/components/CuePipelineEditor/edges/PipelineEdge', () => ({
	edgeTypes: {},
}));
vi.mock('../../../../renderer/components/CuePipelineEditor/drawers/TriggerDrawer', () => ({
	TriggerDrawer: ({ isOpen }: any) =>
		isOpen ? <div data-testid="trigger-drawer">TriggerDrawer</div> : null,
}));
vi.mock('../../../../renderer/components/CuePipelineEditor/drawers/AgentDrawer', () => ({
	AgentDrawer: ({ isOpen }: any) =>
		isOpen ? <div data-testid="agent-drawer">AgentDrawer</div> : null,
}));
vi.mock('../../../../renderer/components/CuePipelineEditor/panels/NodeConfigPanel', () => ({
	NodeConfigPanel: () => <div data-testid="node-config-panel" />,
}));
vi.mock('../../../../renderer/components/CuePipelineEditor/panels/EdgeConfigPanel', () => ({
	EdgeConfigPanel: () => <div data-testid="edge-config-panel" />,
}));
vi.mock('../../../../renderer/components/CuePipelineEditor/panels/CueSettingsPanel', () => ({
	CueSettingsPanel: () => <div data-testid="cue-settings-panel" />,
}));

function buildProps(overrides: Partial<PipelineCanvasProps> = {}): PipelineCanvasProps {
	return {
		theme: mockTheme,
		nodes: [],
		edges: [],
		onNodesChange: vi.fn(),
		onEdgesChange: vi.fn(),
		onConnect: vi.fn(),
		isValidConnection: vi.fn().mockReturnValue(true),
		onNodeClick: vi.fn(),
		onEdgeClick: vi.fn(),
		onPaneClick: vi.fn(),
		onNodeContextMenu: vi.fn(),
		onDragOver: vi.fn(),
		onDrop: vi.fn(),
		triggerDrawerOpen: false,
		setTriggerDrawerOpen: vi.fn(),
		agentDrawerOpen: false,
		setAgentDrawerOpen: vi.fn(),
		sessions: [],
		groups: [],
		onCanvasSessionIds: new Set<string>(),
		pipelineCount: 1,
		createPipeline: vi.fn(),
		selectedPipelineId: 'p1',
		pipelines: [],
		selectPipeline: vi.fn(),
		showSettings: false,
		cueSettings: {
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: 3,
			queue_size: 10,
		},
		setCueSettings: vi.fn(),
		setShowSettings: vi.fn(),
		setIsDirty: vi.fn(),
		selectedNode: null,
		selectedEdge: null,
		selectedNodeHasOutgoingEdge: false,
		hasIncomingAgentEdges: false,
		incomingTriggerEdges: [],
		onUpdateNode: vi.fn(),
		onUpdateEdgePrompt: vi.fn(),
		onDeleteNode: vi.fn(),
		onSwitchToSession: vi.fn(),
		triggerDrawerOpenForConfig: false,
		agentDrawerOpenForConfig: false,
		edgeSourceNode: null,
		edgeTargetNode: null,
		selectedEdgePipelineColor: '#06b6d4',
		onUpdateEdge: vi.fn(),
		onDeleteEdge: vi.fn(),
		...overrides,
	};
}

describe('PipelineCanvas', () => {
	it('renders ReactFlow canvas', () => {
		render(<PipelineCanvas {...buildProps()} />);
		expect(screen.getByTestId('react-flow')).toBeInTheDocument();
	});

	it('renders TriggerDrawer when triggerDrawerOpen is true', () => {
		render(<PipelineCanvas {...buildProps({ triggerDrawerOpen: true })} />);
		expect(screen.getByTestId('trigger-drawer')).toBeInTheDocument();
	});

	it('does not render TriggerDrawer when triggerDrawerOpen is false', () => {
		render(<PipelineCanvas {...buildProps({ triggerDrawerOpen: false })} />);
		expect(screen.queryByTestId('trigger-drawer')).not.toBeInTheDocument();
	});

	it('renders AgentDrawer when agentDrawerOpen is true', () => {
		render(<PipelineCanvas {...buildProps({ agentDrawerOpen: true })} />);
		expect(screen.getByTestId('agent-drawer')).toBeInTheDocument();
	});

	it('shows "Create your first pipeline" when pipelineCount=0 and nodes=[]', () => {
		render(<PipelineCanvas {...buildProps({ pipelineCount: 0, nodes: [] })} />);
		expect(screen.getByText('Create your first pipeline')).toBeInTheDocument();
	});

	it('shows drag instruction when pipelineCount>0 and nodes=[]', () => {
		render(<PipelineCanvas {...buildProps({ pipelineCount: 1, nodes: [] })} />);
		expect(
			screen.getByText('Drag a trigger from the left drawer and an agent from the right drawer')
		).toBeInTheDocument();
	});

	it('does not show empty state when nodes are present', () => {
		const nodes = [{ id: 'n1', type: 'trigger', position: { x: 0, y: 0 }, data: {} }] as any[];
		render(<PipelineCanvas {...buildProps({ nodes })} />);
		expect(screen.queryByText('Create your first pipeline')).not.toBeInTheDocument();
		expect(
			screen.queryByText('Drag a trigger from the left drawer and an agent from the right drawer')
		).not.toBeInTheDocument();
	});

	it('shows pipeline legend in All Pipelines view', () => {
		const pipelines = [
			{ id: 'p1', name: 'Alpha', color: '#06b6d4', nodes: [{ id: 'n1' }], edges: [] },
			{ id: 'p2', name: 'Beta', color: '#8b5cf6', nodes: [], edges: [] },
		] as any[];
		render(<PipelineCanvas {...buildProps({ selectedPipelineId: null, pipelines })} />);
		expect(screen.getByText('Alpha')).toBeInTheDocument();
		expect(screen.getByText('Beta')).toBeInTheDocument();
		expect(screen.getByText('(1)')).toBeInTheDocument();
		expect(screen.getByText('(0)')).toBeInTheDocument();
	});

	it('shows CueSettingsPanel when showSettings is true', () => {
		render(<PipelineCanvas {...buildProps({ showSettings: true })} />);
		expect(screen.getByTestId('cue-settings-panel')).toBeInTheDocument();
	});

	it('shows NodeConfigPanel when selectedNode is set and selectedEdge is null', () => {
		const selectedNode = {
			id: 'n1',
			type: 'trigger' as const,
			position: { x: 0, y: 0 },
			data: { eventType: 'file.changed', label: 'File Changed', config: {} },
		};
		render(<PipelineCanvas {...buildProps({ selectedNode, selectedEdge: null })} />);
		expect(screen.getByTestId('node-config-panel')).toBeInTheDocument();
	});

	it('shows EdgeConfigPanel when selectedEdge is set and selectedNode is null', () => {
		const selectedEdge = {
			id: 'e1',
			source: 'n1',
			target: 'n2',
			mode: 'pass' as const,
		};
		render(<PipelineCanvas {...buildProps({ selectedEdge, selectedNode: null })} />);
		expect(screen.getByTestId('edge-config-panel')).toBeInTheDocument();
	});
});
