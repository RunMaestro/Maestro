// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/stores/prCreationStore.test.ts
// Source: src/__tests__/renderer/stores/movementStore.test.ts
// Source: src/__tests__/renderer/stores/thoughtStreamStore.test.ts
// Source: src/__tests__/renderer/stores/autoRunSteeringStore.test.ts
// Source: src/__tests__/renderer/stores/coworkingApprovalStore.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { usePRCreationStore, prRunKey } from '../../../renderer/stores/prCreationStore';
import {
	useMovementStore,
	applyMovementPayload,
	getMovementSnapshot,
	selectHasVisibleMovement,
	MOVEMENT_ITEM_DEFAULT_WIDTH,
	MOVEMENT_HTML_DEFAULT_WIDTH,
	MOVEMENT_HTML_DEFAULT_HEIGHT,
} from '../../../renderer/stores/movementStore';
import { getModalActions, useModalStore } from '../../../renderer/stores/modalStore';
import {
	useThoughtStreamStore,
	selectActivityCount,
	selectLastAppendAt,
	isThoughtStreamLive,
	groupThoughtsIntoBlocks,
	buildActivityFeed,
	isToolEvent,
	THOUGHT_BLOCK_GAP_MS,
	THOUGHT_LIVE_WINDOW_MS,
	MAX_THOUGHTS_PER_SESSION,
	MAX_THOUGHT_CHARS_PER_SESSION,
	MAX_CAPTURED_SESSIONS,
	type ThoughtEntry,
	type StreamEvent,
	type ToolActivityEntry,
	type ToolActivityStatus,
} from '../../../renderer/stores/thoughtStreamStore';
import {
	useAutoRunSteeringStore,
	groupSteeringDeliveries,
	selectDeliveredSteeringNotes,
	selectPendingSteeringNotes,
	MAX_DELIVERED_STEERING_NOTES,
	MAX_STEERING_RESPONSE_LENGTH,
} from '../../../renderer/stores/autoRunSteeringStore';
import { MAX_PENDING_STEERING_NOTES } from '../../../shared/autorunSteering';
import {
	requestCoworkingApproval,
	useCoworkingApprovalStore,
} from '../../../renderer/stores/coworkingApprovalStore';
// Source: src/__tests__/renderer/stores/prCreationStore.test.ts
describe('', () => {
	const TARGET = {
		sessionId: 'session-1',
		worktreePath: '/test/worktree',
		sourceBranch: 'visual-polish',
		targetBranch: 'main',
		title: 'visual polish',
		description: '',
	};
	const KEY = prRunKey(TARGET.worktreePath);
	type CreatePRResult = {
		success: boolean;
		prUrl?: string;
		error?: string;
	};
	let settle: (result: CreatePRResult) => void = () => {};
	let reject: (err: Error) => void = () => {};
	const createPR = vi.fn();
	describe('prCreationStore', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			usePRCreationStore.setState({ runs: {} });
			createPR.mockImplementation(
				() =>
					new Promise<CreatePRResult>((resolve, rejectFn) => {
						settle = resolve;
						reject = rejectFn;
					})
			);
			(
				globalThis as unknown as {
					window: {
						maestro: unknown;
					};
				}
			).window.maestro = {
				git: { createPR },
			};
		});
		it('records a running attempt keyed by repo path', () => {
			usePRCreationStore.getState().startPRCreation(TARGET);
			expect(createPR).toHaveBeenCalledWith('/test/worktree', 'main', 'visual polish', '');
			expect(usePRCreationStore.getState().runs[KEY]).toMatchObject({
				status: 'running',
				sessionId: 'session-1',
				sourceBranch: 'visual-polish',
			});
		});
		it('folds the PR url back into the run', async () => {
			usePRCreationStore.getState().startPRCreation(TARGET);
			settle({ success: true, prUrl: 'https://github.com/o/r/pull/7' });
			await vi.waitFor(() =>
				expect(usePRCreationStore.getState().runs[KEY]?.status).toBe('success')
			);
			expect(usePRCreationStore.getState().runs[KEY]?.prUrl).toBe('https://github.com/o/r/pull/7');
		});
		it('records a rejected call as a failure rather than losing it', async () => {
			usePRCreationStore.getState().startPRCreation(TARGET);
			reject(new Error('gh exploded'));
			await vi.waitFor(() =>
				expect(usePRCreationStore.getState().runs[KEY]?.status).toBe('failed')
			);
			expect(usePRCreationStore.getState().runs[KEY]?.error).toBe('gh exploded');
		});
		it('treats a second attempt on the same repo as a re-attach, not a duplicate PR', () => {
			usePRCreationStore.getState().startPRCreation(TARGET);
			usePRCreationStore.getState().startPRCreation({ ...TARGET, title: 'different title' });
			expect(createPR).toHaveBeenCalledTimes(1);
			expect(usePRCreationStore.getState().runs[KEY]?.title).toBe('visual polish');
		});
		it('lets a settled attempt be retried', async () => {
			usePRCreationStore.getState().startPRCreation(TARGET);
			settle({ success: false, error: 'no commits between branches' });
			await vi.waitFor(() =>
				expect(usePRCreationStore.getState().runs[KEY]?.status).toBe('failed')
			);
			usePRCreationStore.getState().startPRCreation({ ...TARGET, title: 'second go' });
			expect(createPR).toHaveBeenCalledTimes(2);
			expect(usePRCreationStore.getState().runs[KEY]).toMatchObject({
				status: 'running',
				title: 'second go',
			});
			// The previous failure must not survive into the new attempt.
			expect(usePRCreationStore.getState().runs[KEY]?.error).toBeUndefined();
		});
		it('drops a result whose run was cleared while it was in flight', async () => {
			usePRCreationStore.getState().startPRCreation(TARGET);
			usePRCreationStore.getState().clearRun(KEY);
			settle({ success: true, prUrl: 'https://github.com/o/r/pull/7' });
			await Promise.resolve();
			expect(usePRCreationStore.getState().runs[KEY]).toBeUndefined();
		});
		it('announces a settlement only once', async () => {
			usePRCreationStore.getState().startPRCreation(TARGET);
			settle({ success: false, error: 'boom' });
			await vi.waitFor(() =>
				expect(usePRCreationStore.getState().runs[KEY]?.status).toBe('failed')
			);
			usePRCreationStore.getState().markAnnounced(KEY);
			expect(usePRCreationStore.getState().runs[KEY]?.announced).toBe(true);
		});
	});
});
// Source: src/__tests__/renderer/stores/movementStore.test.ts
describe('', () => {
	/** The stage is a modal, so "is the Concerto layer up" lives in modalStore. */
	function stageOpen(): boolean {
		return useModalStore.getState().isOpen('concertoStage');
	}
	function setStageOpen(open: boolean) {
		getModalActions().setConcertoStageOpen(open);
	}
	function reset() {
		useMovementStore.setState({
			items: [],
			dismissedItems: [],
			viewportWidth: 0,
			viewportHeight: 0,
			flashedId: null,
		});
		setStageOpen(false);
	}
	describe('applyMovementPayload', () => {
		beforeEach(reset);
		it('add creates an item with explicit fields and a parsed spec', () => {
			applyMovementPayload({
				op: 'add',
				id: 'a',
				x: 100,
				y: 60,
				width: 320,
				title: 'Repo',
				body: JSON.stringify({ blocks: [{ kind: 'text', text: 'hi' }] }),
			});
			const item = useMovementStore.getState().items[0];
			expect(item).toMatchObject({ id: 'a', x: 100, y: 60, width: 320, title: 'Repo' });
			expect(item.spec).toEqual({ blocks: [{ kind: 'text', text: 'hi' }] });
		});
		it('add defaults width and empty spec when omitted', () => {
			applyMovementPayload({ op: 'add', id: 'a' });
			const item = useMovementStore.getState().items[0];
			expect(item.width).toBe(MOVEMENT_ITEM_DEFAULT_WIDTH);
			expect(item.spec).toEqual({ blocks: [] });
		});
		it('opens HTML as an artifact-sized document and updates it in place', () => {
			applyMovementPayload({
				op: 'add',
				id: 'mockup',
				viewType: 'html',
				body: '<button>First</button>',
				revision: 7,
			});
			expect(useMovementStore.getState().items[0]).toMatchObject({
				viewType: 'html',
				html: '<button>First</button>',
				width: MOVEMENT_HTML_DEFAULT_WIDTH,
				height: MOVEMENT_HTML_DEFAULT_HEIGHT,
				timestamp: 7,
			});
			applyMovementPayload({
				op: 'update',
				id: 'mockup',
				body: '<button>Second</button>',
				revision: 8,
			});
			expect(useMovementStore.getState().items[0]).toMatchObject({
				viewType: 'html',
				html: '<button>Second</button>',
				timestamp: 8,
			});
		});
		it('reserves a preset HTML frame and replaces it in place on first authored paint', () => {
			applyMovementPayload({
				op: 'begin',
				id: 'mockup',
				title: 'Checkout flow',
				x: 80,
				y: 40,
			});
			expect(stageOpen()).toBe(false);
			expect(useMovementStore.getState().items[0]).toMatchObject({
				id: 'mockup',
				viewType: 'html',
				preparing: true,
				minimized: false,
				x: 80,
				y: 40,
				width: MOVEMENT_HTML_DEFAULT_WIDTH,
				height: MOVEMENT_HTML_DEFAULT_HEIGHT,
				html: undefined,
			});
			applyMovementPayload({
				op: 'add',
				id: 'mockup',
				viewType: 'html',
				body: '<main>Checkout</main>',
				revision: 3,
			});
			expect(useMovementStore.getState().items[0]).toMatchObject({
				id: 'mockup',
				preparing: false,
				x: 80,
				y: 40,
				html: '<main>Checkout</main>',
				timestamp: 3,
			});
		});
		it('keeps a prior prototype visible while a new revision is preparing', () => {
			applyMovementPayload({
				op: 'add',
				id: 'mockup',
				viewType: 'html',
				body: '<main>Existing</main>',
				revision: 4,
			});
			applyMovementPayload({ op: 'begin', id: 'mockup', title: 'Revised checkout' });
			expect(useMovementStore.getState().items[0]).toMatchObject({
				preparing: true,
				html: '<main>Existing</main>',
				timestamp: 4,
				title: 'Revised checkout',
			});
		});
		it('uses a fresh shell when beginning an id whose prior document was closed', () => {
			applyMovementPayload({
				op: 'add',
				id: 'mockup',
				viewType: 'html',
				body: '<main>Closed revision</main>',
			});
			useMovementStore.getState().dismissItem('mockup');
			applyMovementPayload({ op: 'begin', id: 'mockup', title: 'Fresh revision' });
			expect(useMovementStore.getState().items[0]).toMatchObject({
				id: 'mockup',
				preparing: true,
				html: undefined,
			});
			expect(useMovementStore.getState().dismissedItems).toEqual([]);
		});
		it('preserves the prior type when an update switches to HTML without a body', () => {
			applyMovementPayload({
				op: 'add',
				id: 'mockup',
				viewType: 'view',
				body: '{"blocks":[]}',
			});
			const timestamp = useMovementStore.getState().items[0].timestamp;
			applyMovementPayload({ op: 'update', id: 'mockup', viewType: 'html' });
			expect(useMovementStore.getState().items[0]).toMatchObject({
				viewType: 'view',
				timestamp,
			});
		});
		it('renders invalid JSON as a visible error callout instead of throwing', () => {
			applyMovementPayload({ op: 'add', id: 'a', body: '{ not json' });
			const spec = useMovementStore.getState().items[0].spec as {
				blocks: unknown[];
			};
			expect(spec.blocks[0]).toEqual({
				kind: 'callout',
				text: 'Invalid movement item JSON',
				color: 'error',
			});
		});
		it('ignores a payload with no id (except clear)', () => {
			applyMovementPayload({ op: 'add' } as never);
			expect(useMovementStore.getState().items).toHaveLength(0);
		});
		it('re-adding an existing id preserves its position when not re-specified', () => {
			applyMovementPayload({ op: 'add', id: 'a', x: 100, y: 60 });
			applyMovementPayload({ op: 'add', id: 'a', title: 'renamed' });
			const item = useMovementStore.getState().items[0];
			expect(useMovementStore.getState().items).toHaveLength(1);
			expect(item).toMatchObject({ x: 100, y: 60, title: 'renamed' });
		});
		it('update patches only the fields provided', () => {
			applyMovementPayload({ op: 'add', id: 'a', x: 10, y: 10, title: 'orig' });
			applyMovementPayload({ op: 'update', id: 'a', title: 'new' });
			expect(useMovementStore.getState().items[0]).toMatchObject({ x: 10, y: 10, title: 'new' });
		});
		it('keeps the stage closed when an agent creates or updates panels', () => {
			applyMovementPayload({ op: 'add', id: 'a', body: '{"blocks":[]}' });
			expect(stageOpen()).toBe(false);
			applyMovementPayload({ op: 'update', id: 'a', body: '{"blocks":[]}' });
			expect(stageOpen()).toBe(false);
			applyMovementPayload({ op: 'add', id: 'b', body: '{"blocks":[]}' });
			expect(stageOpen()).toBe(false);
			expect(useMovementStore.getState().items.map((item) => item.id)).toEqual(['a', 'b']);
		});
		it('keeps an open stage open when an agent creates panels', () => {
			setStageOpen(true);
			applyMovementPayload({ op: 'begin', id: 'mockup', title: 'Mockup' });
			applyMovementPayload({ op: 'add', id: 'metrics' });
			expect(stageOpen()).toBe(true);
			expect(useMovementStore.getState().items).toHaveLength(2);
		});
		it('preserves a minimized panel when an agent begins and fills a new revision', () => {
			applyMovementPayload({
				op: 'add',
				id: 'mockup',
				viewType: 'html',
				body: '<main>Old</main>',
			});
			useMovementStore.getState().setItemMinimized('mockup', true);
			applyMovementPayload({ op: 'begin', id: 'mockup', title: 'Updated mockup' });
			expect(useMovementStore.getState().items[0].minimized).toBe(true);
			applyMovementPayload({
				op: 'add',
				id: 'mockup',
				viewType: 'html',
				body: '<main>New</main>',
			});
			expect(stageOpen()).toBe(false);
			expect(useMovementStore.getState().items[0]).toMatchObject({
				minimized: true,
				html: '<main>New</main>',
			});
		});
		it('move clamps negative coordinates to zero', () => {
			applyMovementPayload({ op: 'add', id: 'a', x: 50, y: 50 });
			applyMovementPayload({ op: 'move', id: 'a', x: -30, y: 20 });
			expect(useMovementStore.getState().items[0]).toMatchObject({ x: 0, y: 20 });
		});
		it('add and update also clamp negative coordinates (no off-screen panels)', () => {
			applyMovementPayload({ op: 'add', id: 'a', x: -50, y: -20 });
			expect(useMovementStore.getState().items[0]).toMatchObject({ x: 0, y: 0 });
			applyMovementPayload({ op: 'update', id: 'a', x: -400, y: 30 });
			expect(useMovementStore.getState().items[0]).toMatchObject({ x: 0, y: 30 });
		});
		it('clamps far-positive coordinates so the header stays reachable', () => {
			useMovementStore.getState().setViewport(1920, 1080);
			applyMovementPayload({ op: 'add', id: 'a', x: 5000, y: 4000 });
			expect(useMovementStore.getState().items[0]).toMatchObject({ x: 1800, y: 1040 });
			applyMovementPayload({ op: 'update', id: 'a', x: 99999 });
			expect(useMovementStore.getState().items[0]).toMatchObject({ x: 1800, y: 1040 });
			useMovementStore.getState().moveItem('a', 2500, 30);
			expect(useMovementStore.getState().items[0]).toMatchObject({ x: 1800, y: 30 });
		});
		it('an unknown viewport (0x0) clamps only at zero, never at an upper bound', () => {
			applyMovementPayload({ op: 'add', id: 'a', x: 5000, y: 4000 });
			expect(useMovementStore.getState().items[0]).toMatchObject({ x: 5000, y: 4000 });
		});
		it('remove drops the item; clear empties all', () => {
			applyMovementPayload({ op: 'add', id: 'a' });
			applyMovementPayload({ op: 'add', id: 'b' });
			applyMovementPayload({ op: 'remove', id: 'a' });
			expect(useMovementStore.getState().items.map((i) => i.id)).toEqual(['b']);
			applyMovementPayload({ op: 'clear' });
			expect(useMovementStore.getState().items).toHaveLength(0);
		});
		it('replaces then removes a plugin-namespaced host view by id', () => {
			const id = 'com.acme.metrics/release-summary';
			applyMovementPayload({
				op: 'add',
				id,
				title: 'Release summary',
				body: JSON.stringify({ blocks: [{ kind: 'text', text: 'Initial report' }] }),
				sourcePlugin: 'Acme Metrics',
			});
			applyMovementPayload({
				op: 'add',
				id,
				title: 'Updated summary',
				body: JSON.stringify({ blocks: [{ kind: 'text', text: 'Updated report' }] }),
			});
			const [view] = useMovementStore.getState().items;
			expect(useMovementStore.getState().items).toHaveLength(1);
			expect(view).toMatchObject({
				id,
				title: 'Updated summary',
				sourcePlugin: 'Acme Metrics',
				spec: { blocks: [{ kind: 'text', text: 'Updated report' }] },
			});
			applyMovementPayload({ op: 'remove', id });
			expect(useMovementStore.getState().items).toHaveLength(0);
		});
		it('keeps the legacy CLI payload shape free of plugin provenance', () => {
			applyMovementPayload({
				op: 'add',
				id: 'cli-status',
				body: JSON.stringify({ blocks: [] }),
			});
			expect(useMovementStore.getState().items[0].sourcePlugin).toBeUndefined();
		});
	});
	describe('movementStore actions', () => {
		beforeEach(reset);
		it('resizeItem clamps below the minimum panel size', () => {
			applyMovementPayload({ op: 'add', id: 'a', x: 40, y: 50, width: 400 });
			useMovementStore.getState().resizeItem('a', {
				x: 80,
				y: 90,
				width: 50,
				height: 40,
			});
			expect(useMovementStore.getState().items[0]).toMatchObject({
				x: 80,
				y: 90,
				width: 200,
				height: 120,
			});
		});
		it('surfaceItem un-stashes a panel and moves it above overlapping peers', () => {
			applyMovementPayload({ op: 'add', id: 'a' });
			applyMovementPayload({ op: 'add', id: 'b' });
			useMovementStore.getState().setItemMinimized('a', true);
			setStageOpen(false);
			useMovementStore.getState().surfaceItem('a');
			expect(stageOpen()).toBe(true);
			expect(useMovementStore.getState().items.map((item) => item.id)).toEqual(['b', 'a']);
			expect(useMovementStore.getState().items[1].minimized).toBe(false);
			expect(
				[...useMovementStore.getState().items]
					.sort((left, right) => left.taskbarOrder - right.taskbarOrder)
					.map((item) => item.id)
			).toEqual(['a', 'b']);
		});
		it('minimizes only the requested panel and preserves that choice across updates', () => {
			applyMovementPayload({ op: 'add', id: 'a' });
			applyMovementPayload({ op: 'add', id: 'b' });
			useMovementStore.getState().setItemMinimized('a', true);
			applyMovementPayload({ op: 'update', id: 'a', title: 'Updated' });
			expect(useMovementStore.getState().items).toMatchObject([
				{ id: 'a', minimized: true, title: 'Updated' },
				{ id: 'b', minimized: false },
			]);
		});
		it('dismisses a panel for chat-chip restoration and removes it permanently on remote remove', () => {
			applyMovementPayload({
				op: 'add',
				id: 'mockup',
				viewType: 'html',
				body: '<button>Open</button>',
				revision: 4,
			});
			useMovementStore.getState().dismissItem('mockup');
			expect(useMovementStore.getState().items).toEqual([]);
			expect(useMovementStore.getState().dismissedItems).toMatchObject([
				{ id: 'mockup', html: '<button>Open</button>' },
			]);
			expect(useMovementStore.getState().restoreDismissedItem('mockup', 9)).toBe(true);
			expect(useMovementStore.getState().items).toMatchObject([
				{ id: 'mockup', minimized: false, timestamp: 9 },
			]);
			useMovementStore.getState().dismissItem('mockup');
			applyMovementPayload({ op: 'remove', id: 'mockup' });
			expect(useMovementStore.getState().dismissedItems).toEqual([]);
			expect(useMovementStore.getState().restoreDismissedItem('mockup')).toBe(false);
		});
		it('updates retained source while a user-dismissed panel is closed', () => {
			applyMovementPayload({ op: 'add', id: 'report', title: 'Initial' });
			useMovementStore.getState().dismissItem('report');
			applyMovementPayload({ op: 'update', id: 'report', title: 'Updated' });
			expect(useMovementStore.getState().dismissedItems).toMatchObject([
				{ id: 'report', title: 'Updated' },
			]);
		});
	});
	describe('getMovementSnapshot', () => {
		beforeEach(reset);
		it('rounds coordinates and prefers the measured height over the explicit one', () => {
			useMovementStore.getState().setViewport(1920, 1080);
			applyMovementPayload({ op: 'add', id: 'a', x: 10.6, y: 20.4, width: 300.9, height: 200 });
			useMovementStore.getState().setMeasuredHeight('a', 260);
			setStageOpen(true);
			const snap = getMovementSnapshot();
			expect(snap).toMatchObject({ width: 1920, height: 1080, hidden: false });
			expect(snap.items[0]).toMatchObject({
				id: 'a',
				x: 11,
				y: 20,
				width: 301,
				height: 260,
				z: 1,
			});
		});
		it('returns only non-minimized items with their real back-to-front layers', () => {
			applyMovementPayload({ op: 'add', id: 'back' });
			applyMovementPayload({ op: 'add', id: 'minimized' });
			applyMovementPayload({ op: 'add', id: 'front' });
			useMovementStore.getState().setItemMinimized('minimized', true);
			useMovementStore.getState().surfaceItem('back');
			setStageOpen(false);
			expect(getMovementSnapshot()).toMatchObject({
				hidden: true,
				items: [
					{ id: 'front', z: 2 },
					{ id: 'back', z: 3 },
				],
			});
		});
	});
	describe('selectHasVisibleMovement', () => {
		beforeEach(reset);
		it('requires at least one panel that is not minimized to the taskbar', () => {
			applyMovementPayload({ op: 'begin', id: 'design', title: 'Design' });
			expect(selectHasVisibleMovement(useMovementStore.getState())).toBe(true);
			useMovementStore.getState().setItemMinimized('design', true);
			expect(selectHasVisibleMovement(useMovementStore.getState())).toBe(false);
			useMovementStore.getState().setItemMinimized('design', false);
			expect(selectHasVisibleMovement(useMovementStore.getState())).toBe(true);
		});
	});
	describe('flashItem', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			reset();
		});
		afterEach(() => {
			vi.clearAllTimers();
			vi.useRealTimers();
		});
		it('reopens the stage, pulses the id, then clears after the timeout', () => {
			applyMovementPayload({ op: 'add', id: 'deploy' });
			applyMovementPayload({ op: 'add', id: 'other' });
			setStageOpen(false);
			useMovementStore.getState().flashItem('deploy');
			expect(stageOpen()).toBe(true);
			expect(useMovementStore.getState().flashedId).toBe('deploy');
			expect(useMovementStore.getState().items.map((item) => item.id)).toEqual(['other', 'deploy']);
			vi.advanceTimersByTime(2200);
			expect(useMovementStore.getState().flashedId).toBeNull();
		});
	});
});
// Source: src/__tests__/renderer/stores/thoughtStreamStore.test.ts
describe('', () => {
	const SID = 'session-1';
	const TAB = 'tab-a';
	/** Build a ThoughtEntry with explicit timestamp/tab for block-grouping tests. */
	function entry(id: string, timestamp: number, text: string, tabId = TAB): ThoughtEntry {
		return { id, timestamp, tabId, text };
	}
	function reset() {
		useThoughtStreamStore.setState({
			panelSessionId: null,
			buffers: {},
		});
	}
	describe('thoughtStreamStore', () => {
		beforeEach(reset);
		it('starts hidden with no captures', () => {
			const s = useThoughtStreamStore.getState();
			expect(s.panelSessionId).toBeNull();
			expect(s.buffers).toEqual({});
		});
		it('openPanel focuses the session and seeds an empty buffer when it has not thought', () => {
			useThoughtStreamStore.getState().openPanel(SID);
			const s = useThoughtStreamStore.getState();
			expect(s.panelSessionId).toBe(SID);
			expect(s.buffers[SID]).toEqual({ entries: [], trimmed: false, chars: 0, lastAppendAt: 0 });
		});
		it('appendThought records into the buffer', () => {
			const store = useThoughtStreamStore.getState();
			store.openPanel(SID);
			store.appendThought(SID, TAB, 'first thought ');
			store.appendThought(SID, TAB, 'second thought');
			const buf = useThoughtStreamStore.getState().buffers[SID];
			expect(buf.entries).toHaveLength(2);
			expect(buf.entries[0].text).toBe('first thought ');
			expect(buf.entries[0].tabId).toBe(TAB);
			expect(buf.entries[1].text).toBe('second thought');
			expect(buf.chars).toBe('first thought '.length + 'second thought'.length);
			expect(buf.lastAppendAt).toBeGreaterThan(0);
		});
		// The whole point of the feature: you open the stream BECAUSE a run wedged,
		// so the history has to already be there.
		it('buffers ambiently for a session whose panel was never opened', () => {
			useThoughtStreamStore.getState().appendThought(SID, TAB, 'thought nobody was watching');
			const s = useThoughtStreamStore.getState();
			expect(s.panelSessionId).toBeNull();
			expect(s.buffers[SID].entries).toHaveLength(1);
			// Opening later shows that backlog rather than a fresh empty buffer.
			s.openPanel(SID);
			const after = useThoughtStreamStore.getState();
			expect(after.buffers[SID].entries).toHaveLength(1);
			expect(after.buffers[SID].entries[0].text).toBe('thought nobody was watching');
		});
		it('appendThought ignores empty text', () => {
			const store = useThoughtStreamStore.getState();
			store.openPanel(SID);
			store.appendThought(SID, TAB, '');
			expect(useThoughtStreamStore.getState().buffers[SID].entries).toHaveLength(0);
		});
		it('reopening a closed session preserves its existing buffer', () => {
			const store = useThoughtStreamStore.getState();
			store.openPanel(SID);
			store.appendThought(SID, TAB, 'kept');
			store.closePanel();
			store.openPanel(SID);
			const s = useThoughtStreamStore.getState();
			expect(s.panelSessionId).toBe(SID);
			expect(s.buffers[SID].entries).toHaveLength(1);
			expect(s.buffers[SID].entries[0].text).toBe('kept');
		});
		it('closePanel hides the panel but keeps the buffer and keeps recording', () => {
			const store = useThoughtStreamStore.getState();
			store.openPanel(SID);
			store.appendThought(SID, TAB, 'survives the close');
			store.closePanel();
			const s = useThoughtStreamStore.getState();
			expect(s.panelSessionId).toBeNull();
			expect(s.buffers[SID].entries).toHaveLength(1);
			s.appendThought(SID, TAB, ' and after');
			expect(useThoughtStreamStore.getState().buffers[SID].entries).toHaveLength(2);
		});
		it('clearBuffer discards entries and resets the counters', () => {
			const store = useThoughtStreamStore.getState();
			store.openPanel(SID);
			store.appendThought(SID, TAB, 'x');
			store.clearBuffer(SID);
			const buf = useThoughtStreamStore.getState().buffers[SID];
			expect(buf.entries).toHaveLength(0);
			expect(buf.chars).toBe(0);
			expect(buf.trimmed).toBe(false);
		});
		it('caps the buffer at MAX_THOUGHTS_PER_SESSION and sets trimmed', () => {
			const store = useThoughtStreamStore.getState();
			store.openPanel(SID);
			for (let i = 0; i < MAX_THOUGHTS_PER_SESSION + 5; i++) {
				store.appendThought(SID, TAB, `thought-${i}`);
			}
			const buf = useThoughtStreamStore.getState().buffers[SID];
			expect(buf.entries).toHaveLength(MAX_THOUGHTS_PER_SESSION);
			expect(buf.trimmed).toBe(true);
			// oldest dropped, newest retained
			expect(buf.entries[0].text).toBe('thought-5');
			expect(buf.entries[buf.entries.length - 1].text).toBe(
				`thought-${MAX_THOUGHTS_PER_SESSION + 4}`
			);
		});
		// The entry cap alone does not bound memory - one flush can carry a whole
		// reasoning paragraph - so the character budget is the cap that actually holds.
		it('caps the buffer at MAX_THOUGHT_CHARS_PER_SESSION by dropping whole oldest entries', () => {
			const store = useThoughtStreamStore.getState();
			const chunk = 'x'.repeat(MAX_THOUGHT_CHARS_PER_SESSION / 4);
			for (let i = 0; i < 6; i++) store.appendThought(SID, TAB, chunk);
			const buf = useThoughtStreamStore.getState().buffers[SID];
			expect(buf.chars).toBeLessThanOrEqual(MAX_THOUGHT_CHARS_PER_SESSION);
			expect(buf.chars).toBe(buf.entries.reduce((n, e) => n + e.text.length, 0));
			expect(buf.entries.length).toBeLessThan(6);
			expect(buf.trimmed).toBe(true);
		});
		it('keeps the newest thought even when it alone blows the character budget', () => {
			const store = useThoughtStreamStore.getState();
			store.appendThought(SID, TAB, 'y'.repeat(MAX_THOUGHT_CHARS_PER_SESSION + 100));
			const buf = useThoughtStreamStore.getState().buffers[SID];
			expect(buf.entries).toHaveLength(1);
			expect(buf.chars).toBe(MAX_THOUGHT_CHARS_PER_SESSION + 100);
		});
		// Ambient capture means a whole fleet buffers in parallel, so cold sessions
		// have to age out or an all-day app grows without limit.
		describe('cross-session eviction', () => {
			it('evicts the least-recently-active session past MAX_CAPTURED_SESSIONS', () => {
				const store = useThoughtStreamStore.getState();
				for (let i = 0; i < MAX_CAPTURED_SESSIONS + 3; i++) {
					store.appendThought(`sess-${i}`, TAB, `t${i}`);
				}
				const { buffers } = useThoughtStreamStore.getState();
				expect(Object.keys(buffers)).toHaveLength(MAX_CAPTURED_SESSIONS);
				// The three oldest are gone, the newest survive.
				expect(buffers['sess-0']).toBeUndefined();
				expect(buffers['sess-2']).toBeUndefined();
				expect(buffers[`sess-${MAX_CAPTURED_SESSIONS + 2}`]).toBeDefined();
			});
			it('never evicts the session the panel is focused on', () => {
				const store = useThoughtStreamStore.getState();
				store.appendThought('watched', TAB, 'the run being diagnosed');
				store.openPanel('watched');
				for (let i = 0; i < MAX_CAPTURED_SESSIONS + 5; i++) {
					store.appendThought(`noise-${i}`, TAB, `n${i}`);
				}
				const { buffers } = useThoughtStreamStore.getState();
				expect(Object.keys(buffers)).toHaveLength(MAX_CAPTURED_SESSIONS);
				expect(buffers['watched'].entries).toHaveLength(1);
			});
		});
		// N parallel Auto Runs must each capture into their own buffer - a thought
		// from one run must never leak into another. The store is keyed by sessionId
		// in `buffers`, and the capture listener routes every
		// IPC chunk by its parsed sessionId, so independence is structural; these
		// tests guard against a regression that reintroduces a shared accumulator.
		describe('parallel Auto Run independence', () => {
			it('keeps interleaved thoughts from N sessions in separate buffers', () => {
				const store = useThoughtStreamStore.getState();
				const sessions = ['run-a', 'run-b', 'run-c'];
				sessions.forEach((sid) => store.openPanel(sid));
				// Interleave appends across all three runs, as parallel streams would arrive.
				for (let i = 0; i < 4; i++) {
					store.appendThought('run-a', 'tab-a', `a${i} `);
					store.appendThought('run-b', 'tab-b', `b${i} `);
					store.appendThought('run-c', 'tab-c', `c${i} `);
				}
				const { buffers } = useThoughtStreamStore.getState();
				expect(buffers['run-a'].entries).toHaveLength(4);
				expect(buffers['run-b'].entries).toHaveLength(4);
				expect(buffers['run-c'].entries).toHaveLength(4);
				// Each buffer contains ONLY its own session's thoughts.
				expect(buffers['run-a'].entries.every((e) => e.text.startsWith('a'))).toBe(true);
				expect(buffers['run-b'].entries.every((e) => e.text.startsWith('b'))).toBe(true);
				expect(buffers['run-c'].entries.every((e) => e.text.startsWith('c'))).toBe(true);
				// ...and every entry is tagged with its own tab.
				expect(buffers['run-a'].entries.every((e) => e.tabId === 'tab-a')).toBe(true);
				expect(buffers['run-b'].entries.every((e) => e.tabId === 'tab-b')).toBe(true);
			});
			it('closing one run leaves every buffer intact', () => {
				const store = useThoughtStreamStore.getState();
				['run-a', 'run-b', 'run-c'].forEach((sid) => store.openPanel(sid));
				store.appendThought('run-a', 'tab-a', 'a');
				store.appendThought('run-b', 'tab-b', 'b');
				store.appendThought('run-c', 'tab-c', 'c');
				// Panel is focused on run-c (last opened); closing it must not touch a/b.
				expect(useThoughtStreamStore.getState().panelSessionId).toBe('run-c');
				store.closePanel();
				const s = useThoughtStreamStore.getState();
				expect(s.buffers['run-a'].entries).toHaveLength(1);
				expect(s.buffers['run-b'].entries).toHaveLength(1);
				expect(s.buffers['run-c'].entries).toHaveLength(1);
			});
			it('per-session cap trims only the overflowing run', () => {
				const store = useThoughtStreamStore.getState();
				store.openPanel('run-big');
				store.openPanel('run-small');
				for (let i = 0; i < MAX_THOUGHTS_PER_SESSION + 3; i++) {
					store.appendThought('run-big', 'tab', `x${i}`);
				}
				store.appendThought('run-small', 'tab', 'only one');
				const { buffers } = useThoughtStreamStore.getState();
				expect(buffers['run-big'].trimmed).toBe(true);
				expect(buffers['run-big'].entries).toHaveLength(MAX_THOUGHTS_PER_SESSION);
				expect(buffers['run-small'].trimmed).toBe(false);
				expect(buffers['run-small'].entries).toHaveLength(1);
			});
		});
		it('selectActivityCount reports how much is buffered', () => {
			const store = useThoughtStreamStore.getState();
			expect(selectActivityCount(SID)(useThoughtStreamStore.getState())).toBe(0);
			expect(selectActivityCount(undefined)(useThoughtStreamStore.getState())).toBe(0);
			store.appendThought(SID, TAB, 'a');
			store.appendThought(SID, TAB, 'b');
			expect(selectActivityCount(SID)(useThoughtStreamStore.getState())).toBe(2);
		});
		it('selectLastAppendAt drives the live indicator', () => {
			const store = useThoughtStreamStore.getState();
			expect(selectLastAppendAt(SID)(useThoughtStreamStore.getState())).toBe(0);
			store.appendThought(SID, TAB, 'thinking');
			const at = selectLastAppendAt(SID)(useThoughtStreamStore.getState());
			expect(isThoughtStreamLive(at, at)).toBe(true);
			expect(isThoughtStreamLive(at, at + THOUGHT_LIVE_WINDOW_MS + 1)).toBe(false);
			// A session that never thought is never "live".
			expect(isThoughtStreamLive(0)).toBe(false);
		});
	});
	describe('groupThoughtsIntoBlocks', () => {
		it('returns an empty list for no entries', () => {
			expect(groupThoughtsIntoBlocks([])).toEqual([]);
		});
		it('merges entries within the gap window into one block', () => {
			const blocks = groupThoughtsIntoBlocks([
				entry('a', 1000, 'one '),
				entry('b', 1500, 'two '),
				entry('c', 2000, 'three'),
			]);
			expect(blocks).toHaveLength(1);
			expect(blocks[0].id).toBe('a'); // keyed by first entry
			expect(blocks[0].text).toBe('one two three');
			expect(blocks[0].startTimestamp).toBe(1000);
			expect(blocks[0].endTimestamp).toBe(2000);
		});
		it('starts a new block when the gap exceeds THOUGHT_BLOCK_GAP_MS', () => {
			const blocks = groupThoughtsIntoBlocks([
				entry('a', 1000, 'first block'),
				entry('b', 1000 + THOUGHT_BLOCK_GAP_MS + 1, 'second block'),
			]);
			expect(blocks).toHaveLength(2);
			expect(blocks[0].text).toBe('first block');
			expect(blocks[1].text).toBe('second block');
			expect(blocks[1].startTimestamp).toBe(1000 + THOUGHT_BLOCK_GAP_MS + 1);
		});
		it('keeps a gap exactly at the threshold in the same block', () => {
			const blocks = groupThoughtsIntoBlocks([
				entry('a', 1000, 'a'),
				entry('b', 1000 + THOUGHT_BLOCK_GAP_MS, 'b'),
			]);
			expect(blocks).toHaveLength(1);
			expect(blocks[0].text).toBe('ab');
		});
		it('splits on a tab change even within the gap window', () => {
			const blocks = groupThoughtsIntoBlocks([
				entry('a', 1000, 'tab-a thought', 'tab-a'),
				entry('b', 1200, 'tab-b thought', 'tab-b'),
			]);
			expect(blocks).toHaveLength(2);
			expect(blocks[0].tabId).toBe('tab-a');
			expect(blocks[1].tabId).toBe('tab-b');
		});
		it('honors a custom gap argument', () => {
			const blocks = groupThoughtsIntoBlocks(
				[entry('a', 0, 'a'), entry('b', 100, 'b')],
				50 // tighter than the 100ms spacing -> two blocks
			);
			expect(blocks).toHaveLength(2);
		});
	});
	/**
	 * The action half of the timeline.
	 *
	 * The design constraint these pin down: reasoning and tool calls live in ONE
	 * array in arrival order. A previous attempt at this feature kept them in two
	 * lists and merged at display time, which cannot place a tool call inside a
	 * block of reasoning - the block has a single timestamp, so a fast tool call
	 * rendered AFTER the reasoning that actually followed it. For a feed whose
	 * whole purpose is "watch what the agent is doing, in order", that is the bug.
	 */
	describe('tool activity capture', () => {
		beforeEach(reset);
		const label = (verb: string, target = '') => ({ verb, target });
		function tool(
			sessionId: string,
			tabId: string,
			toolName: string,
			status: ToolActivityStatus,
			extra: {
				toolCallId?: string;
				timestamp?: number;
				target?: string;
			} = {}
		) {
			useThoughtStreamStore.getState().appendToolActivity(sessionId, tabId, {
				toolName,
				label: label(toolName, extra.target ?? ''),
				status,
				toolCallId: extra.toolCallId,
				timestamp: extra.timestamp,
			});
		}
		it('records a tool call onto the same timeline as the reasoning', () => {
			const store = useThoughtStreamStore.getState();
			store.appendThought(SID, TAB, 'thinking ');
			tool(SID, TAB, 'Bash', 'running');
			const { entries } = useThoughtStreamStore.getState().buffers[SID];
			expect(entries).toHaveLength(2);
			expect(isToolEvent(entries[0])).toBe(false);
			expect(isToolEvent(entries[1])).toBe(true);
		});
		it('ignores an event with no tool name', () => {
			tool(SID, TAB, '   ', 'running');
			expect(useThoughtStreamStore.getState().buffers[SID]).toBeUndefined();
		});
		it('merges a completion into the running entry by toolCallId', () => {
			tool(SID, TAB, 'Bash', 'running', { toolCallId: 'call-1', timestamp: 1000 });
			tool(SID, TAB, 'Bash', 'completed', { toolCallId: 'call-1', timestamp: 5000 });
			const { entries } = useThoughtStreamStore.getState().buffers[SID];
			// One ACTION, not two state transitions.
			expect(entries).toHaveLength(1);
			const event = entries[0] as ToolActivityEntry;
			expect(event.tool.status).toBe('completed');
			expect(event.tool.endedAt).toBe(5000);
		});
		it('keeps the START timestamp when a call completes, so the row does not jump', () => {
			tool(SID, TAB, 'Bash', 'running', { toolCallId: 'call-1', timestamp: 1000 });
			tool(SID, TAB, 'Bash', 'completed', { toolCallId: 'call-1', timestamp: 90000 });
			const event = useThoughtStreamStore.getState().buffers[SID].entries[0] as ToolActivityEntry;
			expect(event.timestamp).toBe(1000);
		});
		it('merges into its ORIGINAL slot, leaving later events after it', () => {
			const store = useThoughtStreamStore.getState();
			tool(SID, TAB, 'Bash', 'running', { toolCallId: 'call-1', timestamp: 1000 });
			store.appendThought(SID, TAB, 'while that runs');
			tool(SID, TAB, 'Bash', 'completed', { toolCallId: 'call-1', timestamp: 9000 });
			const { entries } = useThoughtStreamStore.getState().buffers[SID];
			expect(entries).toHaveLength(2);
			// The completed call stays FIRST - a long build must not leapfrog the
			// reasoning that happened while it ran.
			expect(isToolEvent(entries[0])).toBe(true);
			expect((entries[0] as ToolActivityEntry).tool.status).toBe('completed');
			expect(isToolEvent(entries[1])).toBe(false);
		});
		it('merges by newest running call of the same name when the provider sends no id', () => {
			tool(SID, TAB, 'shell', 'running', { timestamp: 1000 });
			tool(SID, TAB, 'shell', 'running', { timestamp: 2000 });
			tool(SID, TAB, 'shell', 'failed', { timestamp: 3000 });
			const { entries } = useThoughtStreamStore.getState().buffers[SID];
			expect(entries).toHaveLength(2);
			// The NEWEST running call is the one that finished.
			expect((entries[0] as ToolActivityEntry).tool.status).toBe('running');
			expect((entries[1] as ToolActivityEntry).tool.status).toBe('failed');
		});
		it('never merges a completion across tabs', () => {
			tool(SID, 'tab-a', 'shell', 'running', { timestamp: 1000 });
			tool(SID, 'tab-b', 'shell', 'completed', { timestamp: 2000 });
			const { entries } = useThoughtStreamStore.getState().buffers[SID];
			expect(entries).toHaveLength(2);
			expect((entries[0] as ToolActivityEntry).tool.status).toBe('running');
		});
		it('appends a completion with no matching start rather than dropping it', () => {
			tool(SID, TAB, 'Read', 'completed', { timestamp: 1000 });
			expect(useThoughtStreamStore.getState().buffers[SID].entries).toHaveLength(1);
		});
		it('prefers a descriptive label when the running event carried no target', () => {
			useThoughtStreamStore.getState().appendToolActivity(SID, TAB, {
				toolName: 'Bash',
				label: { verb: 'Ran', target: '', targetIsCode: true },
				status: 'running',
				toolCallId: 'c1',
			});
			useThoughtStreamStore.getState().appendToolActivity(SID, TAB, {
				toolName: 'Bash',
				label: { verb: 'Ran', target: 'npm test', targetIsCode: true },
				status: 'completed',
				toolCallId: 'c1',
			});
			const event = useThoughtStreamStore.getState().buffers[SID].entries[0] as ToolActivityEntry;
			expect(event.tool.label.target).toBe('npm test');
		});
		it('merges an id-carrying completion into a start the provider sent without one', () => {
			// Some providers only stamp the id on the completion. Bailing out on the
			// id miss rendered ONE action as two rows: a phantom "still running" call
			// sitting above its own result, which reads exactly like a hung tool.
			tool(SID, TAB, 'shell', 'running', { timestamp: 1000 });
			tool(SID, TAB, 'shell', 'completed', { toolCallId: 'late-id', timestamp: 2000 });
			const { entries } = useThoughtStreamStore.getState().buffers[SID];
			expect(entries).toHaveLength(1);
			const event = entries[0] as ToolActivityEntry;
			expect(event.tool.status).toBe('completed');
			expect(event.tool.toolCallId).toBe('late-id');
		});
		it('never steals a running call that already belongs to a different id', () => {
			tool(SID, TAB, 'shell', 'running', { toolCallId: 'call-a', timestamp: 1000 });
			tool(SID, TAB, 'shell', 'completed', { toolCallId: 'call-b', timestamp: 2000 });
			const { entries } = useThoughtStreamStore.getState().buffers[SID];
			expect(entries).toHaveLength(2);
			expect((entries[0] as ToolActivityEntry).tool.status).toBe('running');
			expect((entries[0] as ToolActivityEntry).tool.toolCallId).toBe('call-a');
		});
		it('re-derives the character total when a merge replaces the label', () => {
			// The merged row is LONGER than the one it replaced. Carrying the old
			// total forward undercounts what the buffer holds, which is what decides
			// when the budget trims and whether the panel admits it trimmed anything.
			useThoughtStreamStore.getState().appendToolActivity(SID, TAB, {
				toolName: 'Bash',
				label: { verb: 'Ran', target: '', targetIsCode: true },
				status: 'running',
				toolCallId: 'c1',
			});
			expect(useThoughtStreamStore.getState().buffers[SID].chars).toBe('Ran'.length);
			useThoughtStreamStore.getState().appendToolActivity(SID, TAB, {
				toolName: 'Bash',
				label: { verb: 'Ran', target: 'npm test', targetIsCode: true },
				status: 'completed',
				toolCallId: 'c1',
			});
			expect(useThoughtStreamStore.getState().buffers[SID].chars).toBe(
				'Ran'.length + 'npm test'.length
			);
		});
		it('counts tool calls toward the timeline cap', () => {
			for (let i = 0; i < MAX_THOUGHTS_PER_SESSION + 5; i++) {
				tool(SID, TAB, `tool-${i}`, 'completed', { timestamp: 1000 + i });
			}
			const buf = useThoughtStreamStore.getState().buffers[SID];
			expect(buf.entries).toHaveLength(MAX_THOUGHTS_PER_SESSION);
			expect(buf.trimmed).toBe(true);
		});
		it('a tool call keeps the session out of LRU eviction', () => {
			tool(SID, TAB, 'Bash', 'running', { timestamp: 5000 });
			expect(selectActivityCount(SID)(useThoughtStreamStore.getState())).toBe(1);
			expect(selectLastAppendAt(SID)(useThoughtStreamStore.getState())).toBe(5000);
		});
	});
	/**
	 * buildActivityFeed - the ordering guarantee.
	 *
	 * These are the regression tests for the defect that sank the first attempt at
	 * this feature: a tool call that happens in the MIDDLE of a run of reasoning
	 * has to render between the two halves of it. That is only expressible because
	 * both kinds of event come off one array in arrival order.
	 */
	describe('buildActivityFeed', () => {
		const toolEvent = (
			id: string,
			timestamp: number,
			name: string,
			tabId = TAB,
			status: ToolActivityStatus = 'completed'
		): StreamEvent => ({
			id,
			timestamp,
			tabId,
			tool: { name, label: { verb: name, target: '', targetIsCode: true }, status },
		});
		it('returns an empty feed for no events', () => {
			expect(buildActivityFeed([])).toEqual([]);
		});
		it('splits a block of reasoning around a tool call that interrupted it', () => {
			// All three thoughts are inside the gap window, so WITHOUT the tool they
			// would coalesce into a single block and the call would have nowhere to go.
			const feed = buildActivityFeed([
				entry('t1', 1000, 'I should check the tests. '),
				toolEvent('x1', 1100, 'Bash'),
				entry('t2', 1200, 'They passed, so '),
				entry('t3', 1300, 'the bug is elsewhere.'),
			]);
			expect(feed.map((i) => i.kind)).toEqual(['thought', 'tool', 'thought']);
			expect(feed[0].kind === 'thought' && feed[0].block.text).toBe('I should check the tests. ');
			expect(feed[1].kind === 'tool' && feed[1].activity.id).toBe('x1');
			// The reasoning AFTER the call is its own block, below it.
			expect(feed[2].kind === 'thought' && feed[2].block.text).toBe(
				'They passed, so the bug is elsewhere.'
			);
		});
		it('renders a fast tool call before the reasoning that followed it', () => {
			// The exact failure of the two-list design: `x1` is 1ms after the block
			// started, so a feed sorted by block START time buried it underneath.
			const feed = buildActivityFeed([
				entry('t1', 1000, 'first'),
				toolEvent('x1', 1001, 'Read'),
				entry('t2', 1002, 'second'),
			]);
			const toolIndex = feed.findIndex((i) => i.kind === 'tool');
			const afterIndex = feed.findIndex(
				(i) => i.kind === 'thought' && i.block.text.includes('second')
			);
			expect(toolIndex).toBeLessThan(afterIndex);
		});
		it('keeps consecutive tool calls as separate rows in order', () => {
			const feed = buildActivityFeed([
				toolEvent('x1', 1000, 'Read'),
				toolEvent('x2', 1100, 'Bash'),
				toolEvent('x3', 1200, 'Edit'),
			]);
			expect(feed).toHaveLength(3);
			expect(feed.map((i) => (i.kind === 'tool' ? i.activity.tool.name : null))).toEqual([
				'Read',
				'Bash',
				'Edit',
			]);
		});
		it('is emitted oldest-first so the panel can reverse for newest-on-top', () => {
			const feed = buildActivityFeed([entry('t1', 1000, 'old'), toolEvent('x1', 2000, 'Bash')]);
			expect(feed[0].kind).toBe('thought');
			expect(feed[1].kind).toBe('tool');
		});
		it('still coalesces reasoning when no tool interrupts it', () => {
			const feed = buildActivityFeed([entry('a', 1000, 'one '), entry('b', 1500, 'two')]);
			expect(feed).toHaveLength(1);
			expect(feed[0].kind === 'thought' && feed[0].block.text).toBe('one two');
		});
		it('groupThoughtsIntoBlocks projects the same walk, dropping tool rows', () => {
			const events: StreamEvent[] = [
				entry('t1', 1000, 'before '),
				toolEvent('x1', 1100, 'Bash'),
				entry('t2', 1200, 'after'),
			];
			// A tool call still SPLITS the reasoning here, because both views are the
			// one walk - they can never disagree about where a block starts.
			expect(groupThoughtsIntoBlocks(events).map((b) => b.text)).toEqual(['before ', 'after']);
		});
	});
});
// Source: src/__tests__/renderer/stores/autoRunSteeringStore.test.ts
describe('', () => {
	const SESSION = 'session-1';
	describe('autoRunSteeringStore', () => {
		beforeEach(() => {
			useAutoRunSteeringStore.setState({ notes: {}, delivered: {} });
		});
		it('parks a note against its session', () => {
			const note = useAutoRunSteeringStore.getState().addNote(SESSION, '  steer left  ');
			expect(note).not.toBeNull();
			expect(note!.text).toBe('steer left');
			expect(useAutoRunSteeringStore.getState().notes[SESSION]).toHaveLength(1);
		});
		it('rejects an empty note so the caller can report the refusal', () => {
			expect(useAutoRunSteeringStore.getState().addNote(SESSION, '   ')).toBeNull();
			expect(useAutoRunSteeringStore.getState().notes[SESSION]).toBeUndefined();
		});
		it('rejects a note past the pending cap', () => {
			for (let i = 0; i < MAX_PENDING_STEERING_NOTES; i++) {
				expect(useAutoRunSteeringStore.getState().addNote(SESSION, `note ${i}`)).not.toBeNull();
			}
			expect(useAutoRunSteeringStore.getState().addNote(SESSION, 'one too many')).toBeNull();
			expect(useAutoRunSteeringStore.getState().notes[SESSION]).toHaveLength(
				MAX_PENDING_STEERING_NOTES
			);
		});
		it('takeNotes reads and clears in one step so a note is never delivered twice', () => {
			useAutoRunSteeringStore.getState().addNote(SESSION, 'first');
			useAutoRunSteeringStore.getState().addNote(SESSION, 'second');
			const taken = useAutoRunSteeringStore.getState().takeNotes(SESSION);
			expect(taken.map((n) => n.text)).toEqual(['first', 'second']);
			expect(useAutoRunSteeringStore.getState().notes[SESSION]).toBeUndefined();
			expect(useAutoRunSteeringStore.getState().takeNotes(SESSION)).toEqual([]);
		});
		it('takeNotes moves the notes onto the delivered list so the panel keeps the record', () => {
			useAutoRunSteeringStore.getState().addNote(SESSION, 'first');
			useAutoRunSteeringStore.getState().takeNotes(SESSION);
			useAutoRunSteeringStore.getState().addNote(SESSION, 'second');
			useAutoRunSteeringStore.getState().takeNotes(SESSION);
			expect(useAutoRunSteeringStore.getState().delivered[SESSION].map((n) => n.text)).toEqual([
				'first',
				'second',
			]);
		});
		it('caps the delivered list, keeping the newest notes', () => {
			for (let i = 0; i < MAX_DELIVERED_STEERING_NOTES + 5; i++) {
				useAutoRunSteeringStore.getState().addNote(SESSION, `note ${i}`);
				useAutoRunSteeringStore.getState().takeNotes(SESSION);
			}
			const history = useAutoRunSteeringStore.getState().delivered[SESSION];
			expect(history).toHaveLength(MAX_DELIVERED_STEERING_NOTES);
			expect(history[history.length - 1].text).toBe(`note ${MAX_DELIVERED_STEERING_NOTES + 4}`);
		});
		it('keeps sessions independent', () => {
			useAutoRunSteeringStore.getState().addNote(SESSION, 'mine');
			useAutoRunSteeringStore.getState().addNote('session-2', 'theirs');
			useAutoRunSteeringStore.getState().takeNotes(SESSION);
			expect(useAutoRunSteeringStore.getState().notes['session-2']).toHaveLength(1);
			expect(useAutoRunSteeringStore.getState().delivered['session-2']).toBeUndefined();
		});
		it('removes one pending note and leaves the rest', () => {
			const first = useAutoRunSteeringStore.getState().addNote(SESSION, 'first')!;
			useAutoRunSteeringStore.getState().addNote(SESSION, 'second');
			useAutoRunSteeringStore.getState().removeNote(SESSION, first.id);
			expect(useAutoRunSteeringStore.getState().notes[SESSION]).toHaveLength(1);
			expect(useAutoRunSteeringStore.getState().notes[SESSION][0].text).toBe('second');
		});
		it('removeNote cannot un-send a note a task already took', () => {
			const note = useAutoRunSteeringStore.getState().addNote(SESSION, 'gone')!;
			useAutoRunSteeringStore.getState().takeNotes(SESSION);
			useAutoRunSteeringStore.getState().removeNote(SESSION, note.id);
			expect(useAutoRunSteeringStore.getState().delivered[SESSION]).toHaveLength(1);
		});
		it('clearNotes drops both lists for a session', () => {
			useAutoRunSteeringStore.getState().addNote(SESSION, 'first');
			useAutoRunSteeringStore.getState().takeNotes(SESSION);
			useAutoRunSteeringStore.getState().addNote(SESSION, 'second');
			useAutoRunSteeringStore.getState().clearNotes(SESSION);
			expect(useAutoRunSteeringStore.getState().notes[SESSION]).toBeUndefined();
			expect(useAutoRunSteeringStore.getState().delivered[SESSION]).toBeUndefined();
		});
		it('clearPendingNotes keeps the delivered record, since a reply lands as the run ends', () => {
			const taken = useAutoRunSteeringStore.getState().addNote(SESSION, 'stop after this doc')!;
			useAutoRunSteeringStore.getState().takeNotes(SESSION);
			useAutoRunSteeringStore.getState().recordResponse(SESSION, [taken.id], {
				summary: '[steered] Halting after this document.',
				text: '[steered] Halting after this document.',
				success: true,
			});
			useAutoRunSteeringStore.getState().addNote(SESSION, 'never taken');
			useAutoRunSteeringStore.getState().clearPendingNotes(SESSION);
			expect(useAutoRunSteeringStore.getState().notes[SESSION]).toBeUndefined();
			const [kept] = useAutoRunSteeringStore.getState().delivered[SESSION];
			expect(kept.response?.summary).toBe('[steered] Halting after this document.');
		});
		describe('replies', () => {
			const reply = (text: string, success = true) => ({ summary: text, text, success });
			it('stamps every note one task took with the same delivery', () => {
				useAutoRunSteeringStore.getState().addNote(SESSION, 'first');
				useAutoRunSteeringStore.getState().addNote(SESSION, 'second');
				useAutoRunSteeringStore.getState().takeNotes(SESSION);
				useAutoRunSteeringStore.getState().addNote(SESSION, 'third');
				useAutoRunSteeringStore.getState().takeNotes(SESSION);
				const [a, b, c] = useAutoRunSteeringStore.getState().delivered[SESSION];
				expect(a.deliveryId).toBe(b.deliveryId);
				expect(c.deliveryId).not.toBe(a.deliveryId);
			});
			it('attaches a reply only to the notes that task took', () => {
				useAutoRunSteeringStore.getState().addNote(SESSION, 'first');
				const first = useAutoRunSteeringStore.getState().takeNotes(SESSION);
				useAutoRunSteeringStore.getState().addNote(SESSION, 'second');
				useAutoRunSteeringStore.getState().takeNotes(SESSION);
				useAutoRunSteeringStore.getState().recordResponse(
					SESSION,
					first.map((n) => n.id),
					reply('  [steered] switched endpoints  ')
				);
				const [a, b] = useAutoRunSteeringStore.getState().delivered[SESSION];
				expect(a.response).toMatchObject({
					summary: '[steered] switched endpoints',
					text: '[steered] switched endpoints',
					success: true,
				});
				expect(a.response!.timestamp).toBeGreaterThan(0);
				expect(b.response).toBeUndefined();
			});
			it('keeps a failed task as a reply rather than leaving the note waiting', () => {
				const note = useAutoRunSteeringStore.getState().addNote(SESSION, 'first')!;
				useAutoRunSteeringStore.getState().takeNotes(SESSION);
				useAutoRunSteeringStore
					.getState()
					.recordResponse(SESSION, [note.id], reply('context limit reached', false));
				expect(useAutoRunSteeringStore.getState().delivered[SESSION][0].response?.success).toBe(
					false
				);
			});
			it('does not resurrect a note a new run already cleared', () => {
				const note = useAutoRunSteeringStore.getState().addNote(SESSION, 'first')!;
				useAutoRunSteeringStore.getState().takeNotes(SESSION);
				useAutoRunSteeringStore.getState().clearNotes(SESSION);
				useAutoRunSteeringStore.getState().recordResponse(SESSION, [note.id], reply('late'));
				expect(useAutoRunSteeringStore.getState().delivered[SESSION]).toBeUndefined();
			});
			it('caps a runaway reply', () => {
				const note = useAutoRunSteeringStore.getState().addNote(SESSION, 'first')!;
				useAutoRunSteeringStore.getState().takeNotes(SESSION);
				useAutoRunSteeringStore.getState().recordResponse(SESSION, [note.id], {
					summary: 'short',
					text: 'x'.repeat(MAX_STEERING_RESPONSE_LENGTH + 500),
					success: true,
				});
				expect(
					useAutoRunSteeringStore.getState().delivered[SESSION][0].response!.text
				).toHaveLength(MAX_STEERING_RESPONSE_LENGTH);
			});
			it("groups notes by the task that took them, with that task's one reply", () => {
				useAutoRunSteeringStore.getState().addNote(SESSION, 'first');
				useAutoRunSteeringStore.getState().addNote(SESSION, 'second');
				const batch = useAutoRunSteeringStore.getState().takeNotes(SESSION);
				useAutoRunSteeringStore.getState().recordResponse(
					SESSION,
					batch.map((n) => n.id),
					reply('[steered] did both')
				);
				useAutoRunSteeringStore.getState().addNote(SESSION, 'third');
				useAutoRunSteeringStore.getState().takeNotes(SESSION);
				const deliveries = groupSteeringDeliveries(
					useAutoRunSteeringStore.getState().delivered[SESSION]
				);
				expect(deliveries.map((d) => d.notes.map((n) => n.text))).toEqual([
					['first', 'second'],
					['third'],
				]);
				expect(deliveries[0].response?.summary).toBe('[steered] did both');
				// The second task is still running: delivered, not yet answered.
				expect(deliveries[1].response).toBeUndefined();
			});
			it('groups nothing into nothing', () => {
				expect(groupSteeringDeliveries([])).toEqual([]);
			});
		});
		it('hands back a stable empty array so the selectors never churn subscribers', () => {
			const state = useAutoRunSteeringStore.getState();
			expect(selectPendingSteeringNotes(SESSION)(state)).toBe(
				selectPendingSteeringNotes('other')(state)
			);
			expect(selectDeliveredSteeringNotes(SESSION)(state)).toBe(
				selectDeliveredSteeringNotes('other')(state)
			);
		});
	});
});
// Source: src/__tests__/renderer/stores/coworkingApprovalStore.test.ts
describe('', () => {
	const INPUT = { agentId: 'a', sessionId: 's', title: 't', message: 'm' };
	describe('requestCoworkingApproval auto-decline timeout', () => {
		beforeEach(() => {
			useCoworkingApprovalStore.setState({ queue: [] });
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});
		it('auto-declines and dismisses the dialog exactly at the deadline', async () => {
			const p = requestCoworkingApproval(INPUT, 1000);
			let settled: boolean | undefined;
			void p.then((v) => {
				settled = v;
			});
			// Armed but undecided: request is queued, promise still pending.
			expect(useCoworkingApprovalStore.getState().queue).toHaveLength(1);
			expect(vi.getTimerCount()).toBe(1);
			// Just shy of the deadline: nothing has fired.
			vi.advanceTimersByTime(999);
			await Promise.resolve();
			expect(settled).toBeUndefined();
			expect(useCoworkingApprovalStore.getState().queue).toHaveLength(1);
			// Crossing 1000ms auto-declines and dismisses the dialog.
			vi.advanceTimersByTime(1);
			await expect(p).resolves.toBe(false);
			expect(settled).toBe(false);
			expect(useCoworkingApprovalStore.getState().queue).toHaveLength(0);
		});
		it('a decision before the deadline cancels the timer and resolves exactly once', async () => {
			const p = requestCoworkingApproval(INPUT, 1000);
			const resolutions: boolean[] = [];
			void p.then((v) => resolutions.push(v));
			expect(vi.getTimerCount()).toBe(1);
			const id = useCoworkingApprovalStore.getState().queue[0].id;
			useCoworkingApprovalStore.getState().settle(id, true);
			await expect(p).resolves.toBe(true);
			// The user's decision must have cleared the pending auto-decline timer.
			expect(vi.getTimerCount()).toBe(0);
			expect(useCoworkingApprovalStore.getState().queue).toHaveLength(0);
			// Advancing past the original deadline neither throws nor re-resolves.
			expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
			await Promise.resolve();
			expect(resolutions).toEqual([true]);
			expect(useCoworkingApprovalStore.getState().queue).toHaveLength(0);
		});
		it('never auto-declines when no timeoutMs is supplied', async () => {
			const p = requestCoworkingApproval(INPUT);
			let settled: boolean | undefined;
			void p.then((v) => {
				settled = v;
			});
			// No timer armed at all.
			expect(vi.getTimerCount()).toBe(0);
			vi.advanceTimersByTime(10 * 60 * 1000);
			await Promise.resolve();
			expect(settled).toBeUndefined();
			expect(useCoworkingApprovalStore.getState().queue).toHaveLength(1);
		});
		it('does not arm a timer for a non-positive timeoutMs', async () => {
			const p = requestCoworkingApproval(INPUT, 0);
			let settled: boolean | undefined;
			void p.then((v) => {
				settled = v;
			});
			expect(vi.getTimerCount()).toBe(0);
			vi.advanceTimersByTime(10 * 60 * 1000);
			await Promise.resolve();
			expect(settled).toBeUndefined();
			expect(useCoworkingApprovalStore.getState().queue).toHaveLength(1);
		});
	});
});
