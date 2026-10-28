/**
 * Tests for AgentDelegationNode - one agent on the Delegation Graph.
 *
 * The four states (in scope, spill, isolated, placed) must be told apart by
 * shape and not by color alone, so the tests here read the border style, the opacity and
 * the markers, never a color on its own.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { Position, ReactFlowProvider, type NodeProps } from 'reactflow';
import {
	AGENT_DELEGATION_NODE_HEIGHT,
	AGENT_DELEGATION_NODE_MIN_WIDTH,
	AgentDelegationNode,
	agentDelegationNodeState,
	estimateAgentDelegationNodeWidth,
	removedAgentLabel,
	type AgentDelegationNodeData,
	type AgentDelegationNodeState,
} from '../../../../../renderer/components/DelegationGraph/nodes/AgentDelegationNode';
import { getAgentIcon } from '../../../../../renderer/constants/agentIcons';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import type { Group } from '../../../../../renderer/types';
import { buildDelegationGraph, connectedAgentIds } from '../../../../../shared/delegationGraph';
import { createMockSession } from '../../../../helpers/mockSession';
import { mockTheme } from '../../../../helpers/mockTheme';

const PLATFORM: Group = { id: 'g-1', name: 'Platform Team', emoji: '', collapsed: false };
const RESEARCH: Group = {
	id: 'g-2',
	name: 'Research',
	emoji: '',
	collapsed: false,
	shortLabel: 'RSCH',
};

interface RenderOptions {
	sessionId?: string;
	state?: AgentDelegationNodeState;
	selected?: boolean;
	isConnectable?: boolean;
	sourcePosition?: Position;
	targetPosition?: Position;
}

function renderNode(options: RenderOptions = {}) {
	const data: AgentDelegationNodeData = {
		sessionId: options.sessionId ?? 'a',
		state: options.state ?? 'in-scope',
		theme: mockTheme,
	};
	const props = {
		id: data.sessionId,
		data,
		type: 'agent',
		selected: options.selected ?? false,
		isConnectable: options.isConnectable ?? false,
		xPos: 0,
		yPos: 0,
		zIndex: 0,
		dragging: false,
		sourcePosition: options.sourcePosition,
		targetPosition: options.targetPosition,
	} as NodeProps<AgentDelegationNodeData>;

	return render(
		<ReactFlowProvider>
			<AgentDelegationNode {...props} />
		</ReactFlowProvider>
	);
}

function rootOf(container: HTMLElement): HTMLElement {
	return container.querySelector('[data-testid="agent-delegation-node"]') as HTMLElement;
}

// The node and the edge tooltip both name an agent that is gone, and both ask here.
describe('removedAgentLabel', () => {
	it('names a deleted agent by the first eight characters of its id', () => {
		expect(removedAgentLabel('deleted-agent-id')).toBe('Removed agent deleted-');
	});
});

// The layouts reserve space with this before a node is drawn and measured.
describe('estimateAgentDelegationNodeWidth', () => {
	it('is the least width for a short name', () => {
		expect(estimateAgentDelegationNodeWidth('Al')).toBe(AGENT_DELEGATION_NODE_MIN_WIDTH);
	});

	it('grows with a name too long for the least width', () => {
		const long = estimateAgentDelegationNodeWidth('An agent with a very long name indeed');
		expect(long).toBeGreaterThan(AGENT_DELEGATION_NODE_MIN_WIDTH);
		expect(
			estimateAgentDelegationNodeWidth('An agent with a very long name indeed, and more')
		).toBeGreaterThan(long);
	});
});

describe('AgentDelegationNode', () => {
	beforeEach(() => {
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'a', name: 'Alpha', toolType: 'claude-code', groupId: 'g-1' }),
				createMockSession({ id: 'b', name: 'Beta', toolType: 'codex', groupId: 'g-2' }),
				createMockSession({ id: 'c', name: 'Gamma', toolType: 'codex' }),
			],
			groups: [PLATFORM, RESEARCH],
		});
	});

	describe('what it shows', () => {
		it('shows the agent name, the provider glyph and the provider name', () => {
			const { getByText, getByTestId } = renderNode();

			expect(getByText('Alpha')).toBeInTheDocument();
			expect(getByTestId('agent-delegation-node-glyph')).toHaveTextContent(
				getAgentIcon('claude-code')
			);
			expect(getByText('Claude Code')).toBeInTheDocument();
		});

		it("shows the group's pill, and the full group name on hover", () => {
			const { getByTestId } = renderNode({ sessionId: 'b' });
			const pill = getByTestId('agent-delegation-node-group');

			expect(pill).toHaveTextContent('RSCH');
			expect(pill).toHaveAttribute('title', 'Research');
		});

		it('shows no group pill for an agent in no group', () => {
			const { queryByTestId } = renderNode({ sessionId: 'c' });

			expect(queryByTestId('agent-delegation-node-group')).toBeNull();
		});

		it('keeps the size the layout is told about', () => {
			const root = rootOf(renderNode().container);

			expect(root.style.height).toBe(`${AGENT_DELEGATION_NODE_HEIGHT}px`);
			expect(root.style.minWidth).toBe(`${AGENT_DELEGATION_NODE_MIN_WIDTH}px`);
			// The isolated badge hangs over the corner.
			expect(root.style.overflow).toBe('visible');
		});

		it('has a drag handle with the drag-handle class', () => {
			const { container } = renderNode();

			expect(container.querySelector('.drag-handle')).not.toBeNull();
		});
	});

	describe('live resolution', () => {
		// The node data holds an id and never a name, so a rename has to show
		// without the graph rebuilding its nodes.
		it('follows a rename in the session store', () => {
			const { getByText, queryByText } = renderNode();
			expect(getByText('Alpha')).toBeInTheDocument();

			act(() => {
				useSessionStore.setState((store) => ({
					sessions: store.sessions.map((session) =>
						session.id === 'a' ? { ...session, name: 'Renamed' } : session
					),
				}));
			});

			expect(getByText('Renamed')).toBeInTheDocument();
			expect(queryByText('Alpha')).toBeNull();
		});

		it('follows a move to another group', () => {
			const { getByTestId } = renderNode();
			expect(getByTestId('agent-delegation-node-group')).toHaveAttribute('title', 'Platform Team');

			act(() => {
				useSessionStore.setState((store) => ({
					sessions: store.sessions.map((session) =>
						session.id === 'a' ? { ...session, groupId: 'g-2' } : session
					),
				}));
			});

			expect(getByTestId('agent-delegation-node-group')).toHaveAttribute('title', 'Research');
		});

		// The agent can be deleted a render before the graph drops its node.
		it('stays whole, handles included, when its agent is gone', () => {
			const { container, getByText } = renderNode({ sessionId: 'deleted-agent-id' });

			expect(getByText('Removed agent deleted-')).toBeInTheDocument();
			expect(container.querySelectorAll('.react-flow__handle')).toHaveLength(2);
		});

		it('treats a group id with no group behind it as no group', () => {
			useSessionStore.setState((store) => ({
				sessions: store.sessions.map((session) =>
					session.id === 'a' ? { ...session, groupId: 'gone' } : session
				),
			}));
			const { queryByTestId } = renderNode();

			expect(queryByTestId('agent-delegation-node-group')).toBeNull();
		});
	});

	describe('the four states', () => {
		it('draws an in-scope agent at full opacity with a solid border', () => {
			const { container, queryByTestId, queryByText } = renderNode({ state: 'in-scope' });
			const root = rootOf(container);

			expect(root).toHaveAttribute('data-node-state', 'in-scope');
			expect(root.style.borderStyle).toBe('solid');
			expect(root.style.opacity).toBe('1');
			expect(queryByTestId('agent-delegation-node-spill-group')).toBeNull();
			expect(queryByTestId('agent-delegation-node-isolated')).toBeNull();
			expect(queryByText('No peers')).toBeNull();
		});

		it('dims a spill agent, dots its border and names its group in full', () => {
			const { container, getByTestId, queryByTestId } = renderNode({
				sessionId: 'b',
				state: 'spill',
			});
			const root = rootOf(container);

			expect(root).toHaveAttribute('data-node-state', 'spill');
			expect(root.style.borderStyle).toBe('dotted');
			expect(Number(root.style.opacity)).toBeLessThan(1);
			// The full name, not the `RSCH` pill: the point is which boundary was crossed.
			const spillGroup = getByTestId('agent-delegation-node-spill-group');
			expect(spillGroup).toHaveTextContent('Research');
			expect(spillGroup).not.toHaveTextContent('RSCH');
			expect(spillGroup).toHaveAttribute('title', 'Outside this group');
			// One group label, not two.
			expect(queryByTestId('agent-delegation-node-group')).toBeNull();
		});

		it('says so when a spill agent is in no group', () => {
			const { getByTestId } = renderNode({ sessionId: 'c', state: 'spill' });

			expect(getByTestId('agent-delegation-node-spill-group')).toHaveTextContent('Ungrouped');
		});

		it('draws a selected spill agent at full opacity', () => {
			const root = rootOf(renderNode({ sessionId: 'b', state: 'spill', selected: true }).container);

			expect(root.style.opacity).toBe('1');
			// Still spill by shape.
			expect(root.style.borderStyle).toBe('dotted');
		});

		it('marks an isolated agent with a dashed border, a badge and a caption', () => {
			const { container, getByTestId, getByText } = renderNode({ state: 'isolated' });
			const root = rootOf(container);

			expect(root).toHaveAttribute('data-node-state', 'isolated');
			expect(root.style.borderStyle).toBe('dashed');
			expect(root.style.opacity).toBe('1');
			expect(getByTestId('agent-delegation-node-isolated').querySelector('svg')).not.toBeNull();
			expect(getByText('No peers')).toBeInTheDocument();
			// An isolated agent is in scope, so it keeps its group pill.
			expect(getByTestId('agent-delegation-node-group')).toBeInTheDocument();
		});

		// Outside the group like a spill agent, and in front of the user like an
		// in-scope one: it was just put there, to have an edge drawn to it.
		it('draws a placed agent like a spill agent at full opacity, with a caption', () => {
			const { container, getByTestId, queryByTestId } = renderNode({
				sessionId: 'b',
				state: 'placed',
			});
			const root = rootOf(container);

			expect(root).toHaveAttribute('data-node-state', 'placed');
			expect(root.style.borderStyle).toBe('dotted');
			expect(root.style.opacity).toBe('1');
			expect(getByTestId('agent-delegation-node-placed')).toHaveTextContent('No edge yet');
			// The group is named in full, because the agent is NOT in this one.
			expect(getByTestId('agent-delegation-node-spill-group')).toHaveTextContent('Research');
			expect(queryByTestId('agent-delegation-node-group')).toBeNull();
			expect(queryByTestId('agent-delegation-node-isolated')).toBeNull();
		});

		it('shows the placed caption in no other state', () => {
			for (const state of ['in-scope', 'spill', 'isolated'] as const) {
				const { queryByTestId, unmount } = renderNode({ sessionId: 'b', state });
				expect(queryByTestId('agent-delegation-node-placed')).toBeNull();
				unmount();
			}
		});

		// `placed` shares the dotted border with `spill`: both are outside the
		// scope. Opacity and the caption tell the two apart.
		it('gives the three states an edge can produce their own border style', () => {
			const styles = (['in-scope', 'spill', 'isolated'] as const).map((state) => {
				const { container, unmount } = renderNode({ state });
				const style = rootOf(container).style.borderStyle;
				unmount();
				return style;
			});

			expect(new Set(styles).size).toBe(3);
		});

		it('keeps the state border style when selected', () => {
			const root = rootOf(renderNode({ state: 'isolated', selected: true }).container);

			expect(root.style.borderStyle).toBe('dashed');
		});

		it('names the state in the hover summary', () => {
			expect(rootOf(renderNode({ state: 'in-scope' }).container)).toHaveAttribute(
				'title',
				'Alpha, Claude Code, Platform Team'
			);
			expect(rootOf(renderNode({ sessionId: 'b', state: 'spill' }).container)).toHaveAttribute(
				'title',
				'Beta, Codex, Research, outside this group'
			);
			expect(rootOf(renderNode({ sessionId: 'c', state: 'isolated' }).container)).toHaveAttribute(
				'title',
				'Gamma, Codex, no peers'
			);
			expect(rootOf(renderNode({ sessionId: 'b', state: 'placed' }).container)).toHaveAttribute(
				'title',
				'Beta, Codex, Research, outside this group, no edge yet'
			);
		});
	});

	describe('handles', () => {
		it('has one target and one source handle', () => {
			const { container } = renderNode();

			expect(container.querySelectorAll('.react-flow__handle.target')).toHaveLength(1);
			expect(container.querySelectorAll('.react-flow__handle.source')).toHaveLength(1);
		});

		it('defaults to a target on top and a source on the bottom', () => {
			const { container } = renderNode();

			expect(container.querySelector('.react-flow__handle.target')).toHaveClass(
				'react-flow__handle-top'
			);
			expect(container.querySelector('.react-flow__handle.source')).toHaveClass(
				'react-flow__handle-bottom'
			);
		});

		it('puts the handles on the sides the layout asks for', () => {
			const { container } = renderNode({
				sourcePosition: Position.Right,
				targetPosition: Position.Left,
			});

			expect(container.querySelector('.react-flow__handle.target')).toHaveClass(
				'react-flow__handle-left'
			);
			expect(container.querySelector('.react-flow__handle.source')).toHaveClass(
				'react-flow__handle-right'
			);
		});

		// View mode: a handle is an anchor for edges, not something to drag from.
		it('hides the handles while the graph is not connectable', () => {
			const { container } = renderNode({ isConnectable: false });

			for (const handle of container.querySelectorAll<HTMLElement>('.react-flow__handle')) {
				expect(handle.style.opacity).toBe('0');
				expect(handle.style.pointerEvents).toBe('none');
			}
		});

		it('shows the handles when the graph is connectable', () => {
			const { container } = renderNode({ isConnectable: true });

			for (const handle of container.querySelectorAll<HTMLElement>('.react-flow__handle')) {
				expect(handle.style.opacity).toBe('');
				expect(handle.style.width).toBe('16px');
			}
		});
	});
});

describe('agentDelegationNodeState', () => {
	const sessions = [
		{
			id: 'a',
			name: 'Alice',
			groupId: 'g1',
			peerAgents: [{ sessionId: 'x', read: true, write: false }],
		},
		{ id: 'b', name: 'Bob', groupId: 'g1' },
		{ id: 'x', name: 'Xavier', groupId: 'g2' },
	];

	it('reads each node of a built graph as exactly one state', () => {
		const model = buildDelegationGraph({ kind: 'group', groupId: 'g1' }, sessions);
		const connected = connectedAgentIds(model);
		const states = Object.fromEntries(
			model.nodes.map((node) => [node.sessionId, agentDelegationNodeState(node, connected)])
		);

		expect(states).toEqual({ a: 'in-scope', b: 'isolated', x: 'spill' });
	});

	// An agent outside the scope that no edge touches is there because the user
	// placed it. It is never "isolated": that word is about the fleet.
	it('reads a spill node no edge touches as placed, and never as isolated', () => {
		expect(agentDelegationNodeState({ sessionId: 'x', scope: 'spill' }, new Set())).toBe('placed');
		expect(agentDelegationNodeState({ sessionId: 'x', scope: 'spill' }, new Set(['x']))).toBe(
			'spill'
		);
	});

	it('reads an agent the user placed as placed, beside the three other states', () => {
		const fleet = [...sessions, { id: 'y', name: 'Yara', groupId: 'g2' }];
		const model = buildDelegationGraph({ kind: 'group', groupId: 'g1' }, fleet, {
			placedIds: ['y'],
		});
		const connected = connectedAgentIds(model);
		const states = Object.fromEntries(
			model.nodes.map((node) => [node.sessionId, agentDelegationNodeState(node, connected)])
		);

		expect(states).toEqual({ a: 'in-scope', b: 'isolated', x: 'spill', y: 'placed' });
	});
});
