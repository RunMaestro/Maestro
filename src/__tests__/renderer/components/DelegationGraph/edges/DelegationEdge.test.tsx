/**
 * Tests for DelegationEdge - one directed peer relationship on the Delegation Graph.
 *
 * The two bits of an edge must be told apart without color, so the tests here
 * read the line style and the badge, never a stroke color.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MarkerType, ReactFlowProvider, useStoreApi, type EdgeProps } from 'reactflow';
import {
	DELEGATION_EDGE_KIND_LABELS,
	DELEGATION_EDGE_LINES,
	DelegationEdge,
	DelegationEdgeBadge,
	delegationEdgeKind,
	delegationEdgeMarker,
	delegationEdgeOpacity,
	delegationEdgeTypes,
	delegationAccessSentence,
	describeDelegationEdge,
	type DelegationEdgeData,
	type DelegationEdgeEmphasis,
	type DelegationEdgeKind,
} from '../../../../../renderer/components/DelegationGraph/edges/DelegationEdge';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import type { DelegationGraphEdge } from '../../../../../shared/delegationGraph';
import { createMockSession } from '../../../../helpers/mockSession';
import { mockTheme } from '../../../../helpers/mockTheme';

// The real EdgeLabelRenderer portals into a layer that only a mounted
// <ReactFlow> owns, and renders nothing without one. Portal to the body instead,
// so the badge is in the document the way it is on a live canvas.
vi.mock('reactflow', async (importOriginal) => {
	const actual = await importOriginal<typeof import('reactflow')>();
	const { createPortal } = await import('react-dom');
	return {
		...actual,
		EdgeLabelRenderer: ({ children }: { children?: ReactNode }) =>
			createPortal(children, document.body),
	};
});

function modelEdge(overrides: Partial<DelegationGraphEdge> = {}): DelegationGraphEdge {
	const sourceId = overrides.sourceId ?? 'a';
	const targetId = overrides.targetId ?? 'b';
	return {
		id: `${sourceId}->${targetId}`,
		sourceId,
		targetId,
		read: true,
		write: false,
		source: 'explicit',
		...overrides,
	};
}

interface EdgeOptions {
	edge?: Partial<DelegationGraphEdge>;
	hasReverse?: boolean;
	emphasis?: DelegationEdgeEmphasis;
	onOpen?: DelegationEdgeData['onOpen'];
	selected?: boolean;
	/** Where reactflow says the two handles are. Used only for unmeasured nodes. */
	from?: { x: number; y: number };
	to?: { x: number; y: number };
}

function edgeProps(options: EdgeOptions = {}): EdgeProps<DelegationEdgeData> {
	const edge = modelEdge(options.edge);
	const from = options.from ?? { x: 0, y: 0 };
	const to = options.to ?? { x: 200, y: 0 };
	return {
		id: edge.id,
		source: edge.sourceId,
		target: edge.targetId,
		sourceX: from.x,
		sourceY: from.y,
		targetX: to.x,
		targetY: to.y,
		selected: options.selected ?? false,
		markerEnd: 'url(#arrow)',
		data: {
			edge,
			hasReverse: options.hasReverse ?? false,
			emphasis: options.emphasis,
			onOpen: options.onOpen,
			theme: mockTheme,
		},
	} as EdgeProps<DelegationEdgeData>;
}

let flowStore: ReturnType<typeof useStoreApi>;
function CaptureFlowStore() {
	flowStore = useStoreApi();
	return null;
}

function renderEdges(...edges: EdgeOptions[]) {
	return render(
		<ReactFlowProvider>
			<CaptureFlowStore />
			<svg>
				{edges.map((options) => {
					const props = edgeProps(options);
					return <DelegationEdge key={props.id} {...props} />;
				})}
			</svg>
		</ReactFlowProvider>
	);
}

/** Give reactflow measured nodes, 180 x 80, with their top-left corner at (x, y). */
function placeNodes(nodes: Array<{ id: string; x: number; y: number }>) {
	act(() => {
		flowStore.setState({
			nodeInternals: new Map(
				nodes.map((node) => [
					node.id,
					{
						id: node.id,
						position: { x: node.x, y: node.y },
						positionAbsolute: { x: node.x, y: node.y },
						width: 180,
						height: 80,
						data: {},
					},
				])
			),
		});
	});
}

function pathOf(container: HTMLElement, edgeId = 'a->b'): SVGPathElement {
	return container.querySelector(`path[id="${edgeId}"]`) as SVGPathElement;
}

function labelOf(edgeId = 'a->b'): HTMLElement {
	return document.body.querySelector(
		`[data-testid="delegation-edge-label"][data-edge-id="${edgeId}"]`
	) as HTMLElement;
}

function badgeOf(edgeId = 'a->b'): HTMLElement {
	return labelOf(edgeId).querySelector('[data-testid="delegation-edge-badge"]') as HTMLElement;
}

function openTooltip(edgeId = 'a->b'): HTMLElement {
	// HoverTooltip wraps its trigger in a span that owns the hover.
	fireEvent.mouseEnter(badgeOf(edgeId).parentElement!);
	return screen.getByRole('tooltip');
}

const CONSULT = { read: true, write: false };
const DELEGATE = { read: false, write: true };
const BOTH = { read: true, write: true };

describe('delegationEdgeKind', () => {
	it.each([
		[CONSULT, 'consult'],
		[DELEGATE, 'delegate'],
		[BOTH, 'both'],
		[{ read: false, write: false }, null],
	])('reads %o as %s', (access, kind) => {
		expect(delegationEdgeKind(access)).toBe(kind);
	});
});

describe('the line table', () => {
	// The three kinds must differ in SHAPE: a dash or a width, never a color.
	it('draws consult dashed, delegate solid and thin, both solid and thick', () => {
		expect(DELEGATION_EDGE_LINES.consult.dash).toBeTruthy();
		expect(DELEGATION_EDGE_LINES.delegate.dash).toBeUndefined();
		expect(DELEGATION_EDGE_LINES.both.dash).toBeUndefined();
		expect(DELEGATION_EDGE_LINES.consult.width).toBe(DELEGATION_EDGE_LINES.delegate.width);
		expect(DELEGATION_EDGE_LINES.both.width).toBeGreaterThan(DELEGATION_EDGE_LINES.delegate.width);
	});

	it('gives no two kinds the same line', () => {
		const lines = (Object.keys(DELEGATION_EDGE_LINES) as DelegationEdgeKind[]).map(
			(kind) =>
				`${DELEGATION_EDGE_LINES[kind].width}|${DELEGATION_EDGE_LINES[kind].dash ?? 'solid'}`
		);

		expect(new Set(lines).size).toBe(3);
	});
});

describe('delegationEdgeOpacity', () => {
	it('draws an explicit edge at full contrast', () => {
		expect(delegationEdgeOpacity('explicit')).toBe(1);
	});

	it.each(['group', 'worktree'] as const)(
		'draws a %s edge fainter than an explicit one',
		(grant) => {
			expect(delegationEdgeOpacity(grant)).toBeLessThan(delegationEdgeOpacity('explicit'));
		}
	);

	it('fades a dimmed edge, and leaves a highlighted one alone', () => {
		expect(delegationEdgeOpacity('explicit', 'dimmed')).toBeLessThan(1);
		expect(delegationEdgeOpacity('explicit', 'highlighted')).toBe(1);
	});

	it('keeps a derived edge fainter than an explicit one while both are dimmed', () => {
		expect(delegationEdgeOpacity('group', 'dimmed')).toBeLessThan(
			delegationEdgeOpacity('explicit', 'dimmed')
		);
	});
});

describe('delegationEdgeMarker', () => {
	it('is a closed arrowhead in the color of the line', () => {
		expect(delegationEdgeMarker(mockTheme)).toEqual({
			type: MarkerType.ArrowClosed,
			color: mockTheme.colors.textMain,
			width: 16,
			height: 16,
		});
	});
});

describe('delegationAccessSentence', () => {
	it.each([
		['consult', 'Alpha may consult Beta'],
		['delegate', 'Alpha may delegate to Beta'],
		['both', 'Alpha may consult and delegate to Beta'],
	] as const)('says what a %s edge lets the source do', (kind, sentence) => {
		expect(delegationAccessSentence(kind, 'Alpha', 'Beta')).toBe(sentence);
	});

	// The edge editor names the opposite edge beside the one being drawn.
	it('says a relationship is already there when asked to', () => {
		expect(delegationAccessSentence('delegate', 'Beta', 'Alpha', { already: true })).toBe(
			'Beta may already delegate to Alpha'
		);
	});
});

describe('describeDelegationEdge', () => {
	it.each([
		[CONSULT, 'Alpha may consult Beta'],
		[DELEGATE, 'Alpha may delegate to Beta'],
		[BOTH, 'Alpha may consult and delegate to Beta'],
	])('says what the source may do for %o', (access, sentence) => {
		const lines = describeDelegationEdge({ ...access, source: 'explicit' }, 'Alpha', 'Beta');

		expect(lines[0]).toBe(sentence);
	});

	it('names the peer list for an explicit edge', () => {
		const lines = describeDelegationEdge({ ...CONSULT, source: 'explicit' }, 'Alpha', 'Beta');

		expect(lines).toEqual(['Alpha may consult Beta', 'Named in the peer list of Alpha']);
	});

	// The grant is named the way the Peers tab labels its checkbox.
	it('names the group grant for an edge the group grant derived', () => {
		const lines = describeDelegationEdge({ ...CONSULT, source: 'group' }, 'Alpha', 'Beta');

		expect(lines[1]).toBe('From the "Peers in my group" grant of Alpha');
	});

	it('names the worktree grant for an edge the worktree grant derived', () => {
		const lines = describeDelegationEdge({ ...BOTH, source: 'worktree' }, 'Alpha', 'Beta');

		expect(lines[1]).toBe('From the "Worktree family" grant of Alpha');
	});

	it('adds the peer description when the row has one', () => {
		const lines = describeDelegationEdge(
			{ ...DELEGATE, source: 'explicit', description: 'Owns the release notes' },
			'Alpha',
			'Beta'
		);

		expect(lines).toHaveLength(3);
		expect(lines[2]).toBe('Owns the release notes');
	});

	it('has nothing to say about an edge with neither bit', () => {
		expect(
			describeDelegationEdge({ read: false, write: false, source: 'explicit' }, 'Alpha', 'Beta')
		).toEqual([]);
	});
});

describe('DelegationEdgeBadge', () => {
	it.each([
		['consult', 'C'],
		['delegate', 'D'],
		['both', 'CD'],
	] as const)('reads %s as %s', (kind, text) => {
		const { getByTestId } = render(<DelegationEdgeBadge kind={kind} theme={mockTheme} />);

		expect(getByTestId('delegation-edge-badge').textContent).toBe(text);
	});

	// Position is the second encoding: C is always the left slot and D the right,
	// and a bit that is off leaves its slot empty and in place.
	it.each([
		['consult', 'true', 'false'],
		['delegate', 'false', 'true'],
		['both', 'true', 'true'],
	] as const)('keeps two slots in order for %s', (kind, consultLit, delegateLit) => {
		const { getByTestId } = render(<DelegationEdgeBadge kind={kind} theme={mockTheme} />);
		const slots = Array.from(getByTestId('delegation-edge-badge').children);

		expect(slots).toHaveLength(2);
		expect(slots[0]).toHaveAttribute('data-slot', 'C');
		expect(slots[0]).toHaveAttribute('data-lit', consultLit);
		expect(slots[1]).toHaveAttribute('data-slot', 'D');
		expect(slots[1]).toHaveAttribute('data-lit', delegateLit);
	});

	it('names its kind for a screen reader', () => {
		const { getByTestId } = render(<DelegationEdgeBadge kind="both" theme={mockTheme} />);

		expect(getByTestId('delegation-edge-badge')).toHaveAttribute(
			'aria-label',
			DELEGATION_EDGE_KIND_LABELS.both
		);
	});
});

describe('DelegationEdge', () => {
	beforeEach(() => {
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'a', name: 'Alpha' }),
				createMockSession({ id: 'b', name: 'Beta' }),
				createMockSession({ id: 'manager', name: 'Manager' }),
				createMockSession({ id: 'employee', name: 'Employee' }),
			],
			groups: [],
		});
	});

	it('is registered under the delegation edge type', () => {
		expect(delegationEdgeTypes.delegation).toBe(DelegationEdge);
	});

	describe('the two bits', () => {
		it('draws a consult-only edge dashed and thin, with a C badge', () => {
			const { container } = renderEdges({ edge: CONSULT });
			const path = pathOf(container);

			expect(path.style.strokeDasharray).toBe(DELEGATION_EDGE_LINES.consult.dash);
			expect(Number(path.style.strokeWidth)).toBe(DELEGATION_EDGE_LINES.consult.width);
			expect(badgeOf().textContent).toBe('C');
		});

		it('draws a delegate-only edge solid and thin, with a D badge', () => {
			const { container } = renderEdges({ edge: DELEGATE });
			const path = pathOf(container);

			expect(path.style.strokeDasharray).toBeFalsy();
			expect(Number(path.style.strokeWidth)).toBe(DELEGATION_EDGE_LINES.delegate.width);
			expect(badgeOf().textContent).toBe('D');
		});

		it('draws an edge with both bits solid and thick, with a CD badge', () => {
			const { container } = renderEdges({ edge: BOTH });
			const path = pathOf(container);

			expect(path.style.strokeDasharray).toBeFalsy();
			expect(Number(path.style.strokeWidth)).toBe(DELEGATION_EDGE_LINES.both.width);
			expect(badgeOf().textContent).toBe('CD');
		});

		it('draws nothing for an edge with neither bit', () => {
			const { container } = renderEdges({ edge: { read: false, write: false } });

			expect(pathOf(container)).toBeNull();
			expect(labelOf()).toBeNull();
		});

		it('passes the arrowhead through to the line', () => {
			const { container } = renderEdges({ edge: CONSULT });

			expect(pathOf(container).getAttribute('marker-end')).toBe('url(#arrow)');
		});
	});

	describe('explicit and derived', () => {
		it('draws an explicit edge and its badge at full contrast', () => {
			const { container } = renderEdges({ edge: { source: 'explicit' } });

			expect(Number(pathOf(container).style.opacity)).toBe(1);
			expect(Number(labelOf().style.opacity)).toBe(1);
			expect(labelOf()).toHaveAttribute('data-edge-grant', 'explicit');
		});

		it.each(['group', 'worktree'] as const)(
			'draws a %s edge and its badge at lower contrast',
			(grant) => {
				const { container } = renderEdges({ edge: { source: grant } });

				expect(Number(pathOf(container).style.opacity)).toBeLessThan(1);
				expect(Number(labelOf().style.opacity)).toBe(Number(pathOf(container).style.opacity));
				expect(labelOf()).toHaveAttribute('data-edge-grant', grant);
			}
		);
	});

	describe('neighbor focus', () => {
		it('draws no glow while nothing has the focus', () => {
			const { container } = renderEdges({ edge: CONSULT });

			expect(container.querySelector('[data-testid="delegation-edge-glow"]')).toBeNull();
		});

		it.each([
			['a highlighted edge', { emphasis: 'highlighted' as const }],
			['a selected edge', { selected: true }],
		])('thickens %s and puts a glow under it', (_label, options) => {
			const { container } = renderEdges({ edge: DELEGATE, ...options });

			expect(container.querySelector('[data-testid="delegation-edge-glow"]')).not.toBeNull();
			expect(Number(pathOf(container).style.strokeWidth)).toBeGreaterThan(
				DELEGATION_EDGE_LINES.delegate.width
			);
		});

		// A raised thin edge must not grow into the width that means "both bits".
		it('keeps a raised delegate edge thinner than a raised edge with both bits', () => {
			const thin = renderEdges({ edge: DELEGATE, emphasis: 'highlighted' });
			const thinWidth = Number(pathOf(thin.container).style.strokeWidth);
			thin.unmount();
			const thick = renderEdges({ edge: BOTH, emphasis: 'highlighted' });

			expect(thinWidth).toBeLessThan(Number(pathOf(thick.container).style.strokeWidth));
		});

		it('fades a dimmed edge and its badge, and keeps the dash', () => {
			const { container } = renderEdges({ edge: CONSULT, emphasis: 'dimmed' });
			const path = pathOf(container);

			expect(Number(path.style.opacity)).toBeLessThan(1);
			expect(Number(labelOf().style.opacity)).toBeLessThan(1);
			expect(path.style.strokeDasharray).toBe(DELEGATION_EDGE_LINES.consult.dash);
			expect(container.querySelector('[data-testid="delegation-edge-glow"]')).toBeNull();
		});
	});

	describe('the tooltip', () => {
		it('says what the source may do and which grant says so', () => {
			renderEdges({ edge: { ...BOTH, source: 'group' } });
			const tooltip = openTooltip();

			expect(tooltip).toHaveTextContent('Alpha may consult and delegate to Beta');
			expect(tooltip).toHaveTextContent('From the "Peers in my group" grant of Alpha');
		});

		it('shows the peer description when there is one', () => {
			renderEdges({ edge: { ...DELEGATE, description: 'Owns the release notes' } });

			expect(openTooltip()).toHaveTextContent('Owns the release notes');
		});

		// The data holds ids and never a name, so a rename has to show without
		// the graph rebuilding its edges.
		it('follows a rename in the session store', () => {
			renderEdges({ edge: CONSULT });
			act(() => {
				useSessionStore.setState((store) => ({
					sessions: store.sessions.map((session) =>
						session.id === 'b' ? { ...session, name: 'Renamed' } : session
					),
				}));
			});

			expect(openTooltip()).toHaveTextContent('Alpha may consult Renamed');
		});

		it('still names an agent that was deleted a render ago', () => {
			renderEdges({ edge: { ...CONSULT, targetId: 'deleted-agent-id' } });

			expect(openTooltip('a->deleted-agent-id')).toHaveTextContent(
				'Alpha may consult Removed agent deleted-'
			);
		});
	});

	// The badge is the way into an edge, and only while the canvas hands one.
	describe('opening the edge', () => {
		it('is a plain label while the canvas hands no way in', () => {
			renderEdges({ edge: CONSULT });

			expect(labelOf()).not.toHaveAttribute('role');
			expect(labelOf()).not.toHaveAttribute('tabindex');
			expect(labelOf().style.cursor).toBe('');
		});

		it('is a button that names the direction once it can be opened', () => {
			renderEdges({ edge: CONSULT, onOpen: vi.fn() });

			expect(labelOf()).toHaveAttribute('role', 'button');
			expect(labelOf()).toHaveAttribute('tabindex', '0');
			expect(labelOf()).toHaveAttribute('aria-label', 'Edit the edge from Alpha to Beta');
			expect(labelOf().style.cursor).toBe('pointer');
		});

		it('opens the model edge where the badge was clicked', () => {
			const onOpen = vi.fn();
			renderEdges({ edge: { ...BOTH, source: 'group' }, onOpen });

			fireEvent.click(badgeOf(), { clientX: 240, clientY: 130 });

			expect(onOpen).toHaveBeenCalledTimes(1);
			expect(onOpen).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'a->b', sourceId: 'a', targetId: 'b', source: 'group' }),
				{ x: 240, y: 130 }
			);
		});

		// The badge is drawn through a portal, and a React event bubbles through
		// a portal to the edge. The canvas opens the line, so a click on the badge
		// must stop at the badge or the same edge is opened twice.
		it('keeps a click on the badge from reaching the edge it belongs to', () => {
			const onOpen = vi.fn();
			const onEdgeClick = vi.fn();
			render(
				<ReactFlowProvider>
					<svg>
						<g onClick={onEdgeClick}>
							<DelegationEdge {...edgeProps({ edge: CONSULT, onOpen })} />
						</g>
					</svg>
				</ReactFlowProvider>
			);

			fireEvent.click(badgeOf());

			expect(onOpen).toHaveBeenCalledTimes(1);
			expect(onEdgeClick).not.toHaveBeenCalled();
		});

		it.each([
			['Enter', 'Enter'],
			['Space', ' '],
		])('opens at the middle of the badge on %s', (_name, key) => {
			const onOpen = vi.fn();
			renderEdges({ edge: CONSULT, onOpen });
			vi.spyOn(labelOf(), 'getBoundingClientRect').mockReturnValue({
				left: 100,
				top: 50,
				width: 24,
				height: 12,
			} as DOMRect);

			fireEvent.keyDown(labelOf(), { key });

			expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'a->b' }), {
				x: 112,
				y: 56,
			});
		});

		it('ignores every other key', () => {
			const onOpen = vi.fn();
			renderEdges({ edge: CONSULT, onOpen });

			fireEvent.keyDown(labelOf(), { key: 'Tab' });
			fireEvent.keyDown(labelOf(), { key: 'Backspace' });
			fireEvent.keyDown(labelOf(), { key: 'Delete' });

			expect(onOpen).not.toHaveBeenCalled();
		});
	});

	describe('routing', () => {
		it('runs between the handle points while the nodes are not measured', () => {
			const { container } = renderEdges({
				edge: CONSULT,
				from: { x: 0, y: 0 },
				to: { x: 200, y: 0 },
			});

			expect(pathOf(container).getAttribute('d')).toBe('M 0,0 L 200,0');
		});

		it('runs between the node borders once reactflow has measured the nodes', () => {
			const { container } = renderEdges({ edge: CONSULT });
			placeNodes([
				{ id: 'a', x: 0, y: 0 },
				{ id: 'b', x: 400, y: 0 },
			]);

			expect(pathOf(container).getAttribute('d')).toBe('M 180,40 L 400,40');
		});

		it('follows a node that moves', () => {
			const { container } = renderEdges({ edge: CONSULT });
			placeNodes([
				{ id: 'a', x: 0, y: 0 },
				{ id: 'b', x: 400, y: 0 },
			]);
			placeNodes([
				{ id: 'a', x: 0, y: 0 },
				{ id: 'b', x: 0, y: 200 },
			]);

			expect(pathOf(container).getAttribute('d')).toBe('M 90,80 L 90,200');
		});

		it('centers the badge on the middle of the line', () => {
			renderEdges({ edge: CONSULT });
			placeNodes([
				{ id: 'a', x: 0, y: 0 },
				{ id: 'b', x: 400, y: 0 },
			]);

			expect(labelOf().style.transform).toMatch(/translate\(290px,\s*40px\)/);
		});
	});

	/**
	 * The visual case: a manager who delegates down to an employee who consults
	 * back up, with the manager directly above. Drawn center to center, the two
	 * edges would be one vertical line with an arrowhead at each end and two
	 * badges on top of each other, which reads as one bidirectional relationship.
	 */
	describe('a manager and an employee who reach each other', () => {
		function renderPair() {
			const view = renderEdges(
				{ edge: { ...DELEGATE, sourceId: 'manager', targetId: 'employee' }, hasReverse: true },
				{ edge: { ...CONSULT, sourceId: 'employee', targetId: 'manager' }, hasReverse: true }
			);
			placeNodes([
				{ id: 'manager', x: 0, y: 0 },
				{ id: 'employee', x: 0, y: 200 },
			]);
			return {
				down: pathOf(view.container, 'manager->employee'),
				up: pathOf(view.container, 'employee->manager'),
			};
		}

		it('draws the two edges as two separate curves', () => {
			const { down, up } = renderPair();

			expect(down.getAttribute('d')).toBe('M 82,80 Q 54,140 82,200');
			expect(up.getAttribute('d')).toBe('M 98,200 Q 126,140 98,80');
		});

		it('puts the two badges on opposite sides of the line between the nodes', () => {
			renderPair();

			// The shared line is x = 90. One badge is left of it, the other right.
			expect(labelOf('manager->employee').style.transform).toMatch(/translate\(68px,\s*140px\)/);
			expect(labelOf('employee->manager').style.transform).toMatch(/translate\(112px,\s*140px\)/);
		});

		it('keeps each direction readable by its own line and badge', () => {
			const { down, up } = renderPair();

			expect(down.style.strokeDasharray).toBeFalsy();
			expect(badgeOf('manager->employee').textContent).toBe('D');
			expect(up.style.strokeDasharray).toBe(DELEGATION_EDGE_LINES.consult.dash);
			expect(badgeOf('employee->manager').textContent).toBe('C');
		});

		it('gives each direction its own sentence', () => {
			renderPair();

			expect(openTooltip('manager->employee')).toHaveTextContent(
				'Manager may delegate to Employee'
			);
		});

		it('leaves a one-way edge straight', () => {
			const { container } = renderEdges({
				edge: { ...DELEGATE, sourceId: 'manager', targetId: 'employee' },
				hasReverse: false,
			});
			placeNodes([
				{ id: 'manager', x: 0, y: 0 },
				{ id: 'employee', x: 0, y: 200 },
			]);

			expect(pathOf(container, 'manager->employee').getAttribute('d')).toBe('M 90,80 L 90,200');
		});
	});
});
