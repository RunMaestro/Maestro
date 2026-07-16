/**
 * @fileoverview Regression tests for Left Bar re-render cost (#1186).
 *
 * Collapsing or expanding a sidebar folder / agent group re-renders SessionList.
 * That is unavoidable, but it must NOT re-render the agent rows that the toggle
 * does not affect. SessionItem is `React.memo`'d, so the contract is simply that
 * every prop handed to an unaffected row keeps its identity across the toggle.
 *
 * Two props used to break that contract by building a fresh closure per row per
 * render - `onStartRename` (all rows) and `onDrop` (grouped rows) - which
 * defeated the memo bail-out and re-rendered every visible agent on every
 * toggle. These tests pin the prop identities rather than a render count, since
 * identity is what memo actually compares.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { SessionList } from '../../../../renderer/components/SessionList';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../../renderer/stores/uiStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { createMockSession } from '../../../helpers/mockSession';
import { mockTheme } from '../../../helpers/mockTheme';
import type { Group, Session } from '../../../../renderer/types';

// Capture the props SessionItem is called with, per session id. `vi.hoisted` so
// the map exists before the hoisted `vi.mock` factory runs.
const { capturedProps } = vi.hoisted(() => ({
	capturedProps: new Map<string, Record<string, unknown>[]>(),
}));

// Swap only the component; the module also exports helpers that other Left Bar
// children (CollapsedSessionPill) import.
vi.mock('../../../../renderer/components/SessionItem', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/components/SessionItem')>()),
	SessionItem: (props: { session: Session }) => {
		const bucket = capturedProps.get(props.session.id) ?? [];
		bucket.push(props as unknown as Record<string, unknown>);
		capturedProps.set(props.session.id, bucket);
		return null;
	},
}));

// Context providers SessionList reads from; mocked to avoid wrapping in Providers.
vi.mock('../../../../renderer/contexts/InlineWizardContext', () => ({
	useInlineWizardContext: () => ({ wizardActiveSessions: new Map() }),
}));

vi.mock('../../../../renderer/contexts/GitStatusContext', () => ({
	useGitFileStatus: () => ({ getFileCount: () => 0, hasChanges: () => false }),
	useGitBranch: () => ({ getBranchInfo: () => undefined }),
	useGitDetail: () => ({
		getFileDetails: () => undefined,
		refreshGitStatus: vi.fn().mockResolvedValue(undefined),
	}),
}));

const lastPropsFor = (sessionId: string): Record<string, unknown> => {
	const bucket = capturedProps.get(sessionId);
	if (!bucket?.length) throw new Error(`SessionItem never rendered for "${sessionId}"`);
	return bucket[bucket.length - 1];
};

const renderCountFor = (sessionId: string): number => capturedProps.get(sessionId)?.length ?? 0;

/**
 * Assert every prop kept its identity. This is exactly what `React.memo`'s
 * default shallow comparison checks, so an all-identical prop set means the
 * real SessionItem would have bailed out of re-rendering.
 */
const expectPropsIdentical = (
	before: Record<string, unknown>,
	after: Record<string, unknown>,
	label: string
) => {
	const changed = Object.keys({ ...before, ...after }).filter(
		(key) => !Object.is(before[key], after[key])
	);
	expect(changed, `${label}: props lost identity and would defeat React.memo`).toEqual([]);
};

const makeGroup = (overrides: Partial<Group> = {}): Group => ({
	id: 'g',
	name: 'Group',
	emoji: '📁',
	collapsed: false,
	...overrides,
});

// SessionList takes a large handler surface; all of it is stable across renders
// in the app (useCallback) and stable here (one vi.fn per key, built once).
const createProps = (sortedSessions: Session[]) =>
	({
		theme: mockTheme,
		sortedSessions,
		visibleSessions: sortedSessions,
		isLiveMode: false,
		webInterfaceUrl: null,
		showSessionJumpNumbers: false,
		starredItems: [],
		activateStarredItem: vi.fn(),
		toggleGlobalLive: vi.fn(),
		restartWebServer: vi.fn().mockResolvedValue(null),
		toggleGroup: vi.fn(),
		handleDragStart: vi.fn(),
		handleDragOver: vi.fn(),
		handleDropOnGroup: vi.fn(),
		handleDropOnUngrouped: vi.fn(),
		finishRenamingGroup: vi.fn(),
		finishRenamingSession: vi.fn(),
		startRenamingGroup: vi.fn(),
		startRenamingSession: vi.fn(),
		showConfirmation: vi.fn(),
		createNewGroup: vi.fn(),
		onCreateGroupAndMove: vi.fn(),
		addNewSession: vi.fn(),
		onDeleteWorktreeGroup: vi.fn(),
		onEditAgent: vi.fn(),
		onNewAgentSession: vi.fn(),
		onToggleWorktreeExpanded: vi.fn(),
		onOpenCreatePR: vi.fn(),
		onQuickCreateWorktree: vi.fn(),
		onOpenWorktreeConfig: vi.fn(),
		onDeleteWorktree: vi.fn(),
		openWizard: vi.fn(),
		startTour: vi.fn(),
		onOpenGroupChat: vi.fn(),
		onNewGroupChat: vi.fn(),
		onEditGroupChat: vi.fn(),
		onRenameGroupChat: vi.fn(),
		onDeleteGroupChat: vi.fn(),
	}) as unknown as React.ComponentProps<typeof SessionList>;

describe('SessionList memoization (#1186)', () => {
	beforeEach(() => {
		capturedProps.clear();
		useUIStore.setState({
			leftSidebarOpen: true,
			activeFocus: 'main',
			selectedSidebarIndex: -1,
			sidebarExtraSelection: null,
			editingGroupId: null,
			editingSessionId: null,
			draggingSessionId: null,
			bookmarksCollapsed: false,
		} as never);
		useSettingsStore.setState({ ungroupedCollapsed: false } as never);
	});

	it('keeps row props identity-stable when a different group is expanded', () => {
		// gA stays expanded throughout; gB is the group the user expands.
		const groupA = makeGroup({ id: 'gA', name: 'Alpha', collapsed: false });
		const groupB = makeGroup({ id: 'gB', name: 'Bravo', collapsed: true });
		const inA = createMockSession({ id: 'a1', name: 'In Alpha', groupId: 'gA' });
		const inB = createMockSession({ id: 'b1', name: 'In Bravo', groupId: 'gB' });
		const loose = createMockSession({ id: 'u1', name: 'Ungrouped' });
		const sorted = [inA, inB, loose];

		useSessionStore.setState({ sessions: sorted, groups: [groupA, groupB], activeSessionId: '' });
		render(<SessionList {...createProps(sorted)} />);

		const beforeA = lastPropsFor('a1');
		const beforeLoose = lastPropsFor('u1');
		const rendersBefore = { a1: renderCountFor('a1'), u1: renderCountFor('u1') };

		// The user expands Bravo. Only `groups` changes; the agents themselves,
		// and the set of group ids, are untouched.
		act(() => {
			useSessionStore.setState({ groups: [groupA, { ...groupB, collapsed: false }] });
		});

		// Sanity: the toggle really did re-render SessionList and reveal Bravo's row.
		expect(renderCountFor('a1')).toBeGreaterThan(rendersBefore.a1);
		expect(renderCountFor('b1')).toBeGreaterThan(0);

		// ...but Alpha's and the ungrouped rows got byte-for-byte identical props,
		// so the real (memo'd) SessionItem would not have re-rendered them.
		expectPropsIdentical(beforeA, lastPropsFor('a1'), 'grouped row a1');
		expectPropsIdentical(beforeLoose, lastPropsFor('u1'), 'ungrouped row u1');
		expect(renderCountFor('u1')).toBeGreaterThan(rendersBefore.u1);
	});

	it('keeps row props identity-stable when the Bookmarks folder is collapsed', () => {
		const group = makeGroup({ id: 'gA', name: 'Alpha' });
		const inGroup = createMockSession({ id: 'a1', name: 'In Alpha', groupId: 'gA' });
		const starred = createMockSession({ id: 'bm1', name: 'Bookmarked', bookmarked: true });
		const sorted = [inGroup, starred];

		useSessionStore.setState({ sessions: sorted, groups: [group], activeSessionId: '' });
		render(<SessionList {...createProps(sorted)} />);

		const beforeGroupRow = lastPropsFor('a1');

		// Collapsing the Bookmarks folder re-renders SessionList top-to-bottom.
		act(() => {
			useUIStore.setState({ bookmarksCollapsed: true });
		});

		expectPropsIdentical(beforeGroupRow, lastPropsFor('a1'), 'grouped row a1');
	});

	it('hands grouped rows the same onDrop reference across a group toggle', () => {
		const groupA = makeGroup({ id: 'gA', name: 'Alpha', collapsed: false });
		const groupB = makeGroup({ id: 'gB', name: 'Bravo', collapsed: true });
		const inA = createMockSession({ id: 'a1', name: 'In Alpha', groupId: 'gA' });
		const sorted = [inA];

		useSessionStore.setState({ sessions: sorted, groups: [groupA, groupB], activeSessionId: '' });
		render(<SessionList {...createProps(sorted)} />);

		const beforeDrop = lastPropsFor('a1').onDrop;
		expect(typeof beforeDrop).toBe('function');

		act(() => {
			useSessionStore.setState({ groups: [groupA, { ...groupB, collapsed: false }] });
		});

		expect(lastPropsFor('a1').onDrop).toBe(beforeDrop);
	});
});
