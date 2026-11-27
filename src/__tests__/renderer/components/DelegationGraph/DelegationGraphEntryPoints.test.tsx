/**
 * Tests for the ways into the Delegation Graph, from the click to the graph
 * that is drawn.
 *
 * Each link of the chain has its own test: the palette commands
 * (`commandBuilders.test.ts`), the menu item (`GroupContextMenu.test.tsx`), the
 * threading from the Left Bar (`SessionList.test.tsx`), the opener
 * (`modalStore.test.ts`), the mount (`AppModals-selfSourced.test.tsx`) and the
 * view's initial scope (`DelegationGraphView.test.tsx`). Every one of them stops
 * at a mock of the next link. What is pinned here is the whole chain with
 * nothing mocked between its ends: a palette command or the group's right-click
 * item runs against the real modal store, the real modal reads the scope back,
 * and the real view draws that scope.
 *
 * Two parts are stand-ins. reactflow cannot lay itself out in jsdom, so
 * `<ReactFlow>` draws each node it was handed as a marker. And the modal is
 * mounted by a host that reads the store the way `AppInfoModals` does, since
 * that component mounts every other info modal with it.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Node } from 'reactflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MindMapProps } from '../../../../renderer/components/DocumentGraph/MindMap';

vi.mock('../../../../renderer/components/DocumentGraph/MindMap', () => ({
	MindMap: ({ nodes }: MindMapProps) => (
		<div data-testid="document-graph-canvas">
			{nodes.map((node) => (
				<div key={node.id} data-testid="flow-node" data-node-id={node.id} />
			))}
		</div>
	),
}));

vi.mock('reactflow', async (importOriginal) => {
	const actual = await importOriginal<typeof import('reactflow')>();
	// One object for the life of the file: the view re-arms its fit timer when
	// this reference changes.
	const api = {
		fitView: vi.fn(),
		screenToFlowPosition: (point: { x: number; y: number }) => point,
	};
	return {
		...actual,
		default: ({ nodes, children }: { nodes: Node[]; children?: ReactNode }) => (
			<div data-testid="react-flow">
				{nodes.map((node) => (
					<div key={node.id} data-testid="flow-node" data-node-id={node.id} />
				))}
				{children}
			</div>
		),
		ReactFlowProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
		useReactFlow: () => api,
		Background: () => null,
		Controls: () => null,
		MiniMap: () => null,
	};
});

import { DelegationGraphModal } from '../../../../renderer/components/DelegationGraph/DelegationGraphModal';
import {
	buildDelegationGraphCommands,
	delegationGraphGroupCommandId,
} from '../../../../renderer/components/QuickActionsModal/commands/delegationGraphCommands';
import { GroupContextMenu } from '../../../../renderer/components/SessionList/GroupContextMenu';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import {
	getModalActions,
	selectModalData,
	selectModalOpen,
	useModalStore,
} from '../../../../renderer/stores/modalStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import type { Group, Session } from '../../../../renderer/types';
import type { DelegationGraphScope } from '../../../../shared/delegationGraph';
import { scopeStorageKey } from '../../../../shared/delegationGraphLayout';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
import { createMockSession } from '../../../helpers/mockSession';
import { mockTheme } from '../../../helpers/mockTheme';

const PLATFORM: Group = { id: 'g-1', name: 'Platform', emoji: '', collapsed: false };
const RESEARCH: Group = { id: 'g-2', name: 'Research', emoji: '', collapsed: false };

const ALL_KEY = scopeStorageKey({ kind: 'all' });

function groupKey(group: Group): string {
	return scopeStorageKey({ kind: 'group', groupId: group.id });
}

/**
 * Four agents and one edge:
 *
 *   Alpha (Platform) -> Beta (Research)
 *   Gamma (Research)                      reaches nobody
 *   Delta (no group)                      reaches nobody
 *
 * So the three graphs differ: every agent, Platform (Alpha, and Beta from
 * outside), and Research (Beta and Gamma, and Alpha from outside).
 */
function fleet(): Session[] {
	return [
		createMockSession({
			id: 'a',
			name: 'Alpha',
			groupId: PLATFORM.id,
			peerAgents: [{ sessionId: 'b', read: true, write: true }],
		}),
		createMockSession({ id: 'b', name: 'Beta', groupId: RESEARCH.id }),
		createMockSession({ id: 'c', name: 'Gamma', groupId: RESEARCH.id }),
		createMockSession({ id: 'd', name: 'Delta' }),
	];
}

const ALL_IDS = ['a', 'b', 'c', 'd'];
const PLATFORM_IDS = ['a', 'b'];
const RESEARCH_IDS = ['a', 'b', 'c'];

/** The mount of `AppInfoModals`: open and scope are both read from the store. */
function GraphHost() {
	const open = useModalStore(selectModalOpen('delegationGraph'));
	const data = useModalStore(selectModalData('delegationGraph'));
	if (!open) return null;
	return (
		<DelegationGraphModal
			theme={mockTheme}
			onClose={() => useModalStore.getState().closeModal('delegationGraph')}
			scope={data?.scope}
		/>
	);
}

function renderHost(menu?: ReactNode) {
	return render(
		<LayerStackProvider>
			{menu}
			<GraphHost />
		</LayerStackProvider>
	);
}

/** Run a palette command by its id, as a pick in the palette does. */
function runPaletteCommand(id: string): { setQuickActionOpen: ReturnType<typeof vi.fn> } {
	const setQuickActionOpen = vi.fn();
	const command = buildDelegationGraphCommands({
		setQuickActionOpen,
		groups: useSessionStore.getState().groups,
	}).find((candidate) => candidate.id === id);
	if (!command) throw new Error(`the palette has no command ${id}`);
	act(() => {
		command.action();
	});
	return { setQuickActionOpen };
}

/**
 * The right-click menu of a group, with the one prop the Left Bar threads for
 * the graph. `SessionList.test.tsx` pins that the Left Bar passes this call
 * with the group that was right-clicked.
 */
function groupMenu(group: Group, onDismiss = vi.fn()) {
	return (
		<GroupContextMenu
			x={0}
			y={0}
			theme={mockTheme}
			group={group}
			memberCount={1}
			onRename={vi.fn()}
			onNewAgent={vi.fn()}
			onOpenDelegationGraph={() => getModalActions().openDelegationGraph(group.id)}
			onDismiss={onDismiss}
		/>
	);
}

function clickMenuItem(): void {
	fireEvent.click(screen.getByRole('button', { name: 'Delegation Graph' }));
}

function scopeOnScreen(): string {
	return (screen.getByTestId('delegation-graph-scope') as HTMLSelectElement).value;
}

function drawnNodeIds(): string[] {
	return screen
		.queryAllByTestId('flow-node')
		.map((el) => el.dataset.nodeId ?? '')
		.sort();
}

function storedScope(): DelegationGraphScope | undefined {
	return useModalStore.getState().getData('delegationGraph')?.scope;
}

describe('the ways into the Delegation Graph', () => {
	beforeEach(() => {
		// The legend's open state is kept in localStorage.
		installLocalStorageMock();
		useSessionStore.setState({
			sessions: fleet(),
			groups: [PLATFORM, RESEARCH],
			activeSessionId: 'a',
		});
		useSettingsStore.setState({ delegationGraphLayouts: {}, modalSizes: {} });
		useModalStore.getState().closeAll();
	});

	it('draws nothing until a way in is used', () => {
		renderHost();

		expect(screen.queryByRole('dialog', { name: 'Delegation Graph' })).not.toBeInTheDocument();
	});

	describe('the command palette', () => {
		it('opens the graph of every agent from "Delegation Graph"', () => {
			renderHost();

			const { setQuickActionOpen } = runPaletteCommand('openDelegationGraph');

			expect(setQuickActionOpen).toHaveBeenCalledWith(false);
			expect(screen.getByRole('dialog', { name: 'Delegation Graph' })).toBeInTheDocument();
			expect(scopeOnScreen()).toBe(ALL_KEY);
			expect(drawnNodeIds()).toEqual(ALL_IDS);
		});

		it('opens the graph of one group from the command of that group', () => {
			renderHost();

			runPaletteCommand(delegationGraphGroupCommandId(PLATFORM.id));

			expect(scopeOnScreen()).toBe(groupKey(PLATFORM));
			// Alpha, and Beta that its edge reaches. Gamma and Delta are not drawn.
			expect(drawnNodeIds()).toEqual(PLATFORM_IDS);
		});

		it('opens each group on its own graph, never on the one beside it', () => {
			renderHost();

			runPaletteCommand(delegationGraphGroupCommandId(RESEARCH.id));

			expect(scopeOnScreen()).toBe(groupKey(RESEARCH));
			expect(drawnNodeIds()).toEqual(RESEARCH_IDS);
		});
	});

	describe('the right-click menu of a group', () => {
		it('opens the graph of that group and closes the menu', () => {
			const onDismiss = vi.fn();
			renderHost(groupMenu(RESEARCH, onDismiss));

			clickMenuItem();

			expect(onDismiss).toHaveBeenCalledTimes(1);
			expect(screen.getByRole('dialog', { name: 'Delegation Graph' })).toBeInTheDocument();
			expect(scopeOnScreen()).toBe(groupKey(RESEARCH));
			expect(drawnNodeIds()).toEqual(RESEARCH_IDS);
		});

		it('opens the same scope the palette command of that group opens', () => {
			renderHost(groupMenu(PLATFORM));

			runPaletteCommand(delegationGraphGroupCommandId(PLATFORM.id));
			const fromPalette = storedScope();
			act(() => useModalStore.getState().closeModal('delegationGraph'));
			clickMenuItem();

			expect(fromPalette).toEqual({ kind: 'group', groupId: PLATFORM.id });
			expect(storedScope()).toEqual(fromPalette);
			expect(scopeOnScreen()).toBe(groupKey(PLATFORM));
			expect(drawnNodeIds()).toEqual(PLATFORM_IDS);
		});
	});

	// The scope is the one that was asked for, never the one the graph last had.
	it('shows the group that was asked for when the graph is already open on another', () => {
		renderHost(groupMenu(RESEARCH));
		runPaletteCommand(delegationGraphGroupCommandId(PLATFORM.id));
		expect(scopeOnScreen()).toBe(groupKey(PLATFORM));

		clickMenuItem();

		expect(scopeOnScreen()).toBe(groupKey(RESEARCH));
		expect(drawnNodeIds()).toEqual(RESEARCH_IDS);
	});

	it('goes back to every agent from the first command after a group was open', () => {
		renderHost();
		runPaletteCommand(delegationGraphGroupCommandId(PLATFORM.id));

		runPaletteCommand('openDelegationGraph');

		expect(storedScope()).toBeUndefined();
		expect(scopeOnScreen()).toBe(ALL_KEY);
		expect(drawnNodeIds()).toEqual(ALL_IDS);
	});

	// No way in arms the canvas: a slipped pointer on a graph that was just
	// opened must not rewrite a roster.
	it.each([
		['the palette, every agent', () => runPaletteCommand('openDelegationGraph')],
		['the palette, one group', () => runPaletteCommand(delegationGraphGroupCommandId(PLATFORM.id))],
		['the right-click menu', () => clickMenuItem()],
	])('opens in View from %s', (_name, open) => {
		renderHost(groupMenu(PLATFORM));

		open();

		expect(screen.getByTestId('delegation-graph-mode-view')).toHaveAttribute(
			'aria-checked',
			'true'
		);
		expect(screen.getByTestId('delegation-graph-canvas')).toHaveAttribute('data-mode', 'view');
	});
});
