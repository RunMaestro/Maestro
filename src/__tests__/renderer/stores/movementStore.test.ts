/**
 * Tests for the movementStore reducer + bridge adapter. The store backs the
 * agent-driven Movement panels; `applyMovementPayload` is the single seam the
 * CLI/web bridge funnels through, so these pin op-mapping, the JSON spec parse
 * (incl. the visible error on bad JSON), position/size clamps, the `state`
 * snapshot the agent reads back, and the chat-chip flash.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	useMovementStore,
	applyMovementPayload,
	getMovementSnapshot,
	MOVEMENT_ITEM_DEFAULT_WIDTH,
	MOVEMENT_HTML_DEFAULT_WIDTH,
	MOVEMENT_HTML_DEFAULT_HEIGHT,
} from '../../../renderer/stores/movementStore';

function reset() {
	useMovementStore.setState({
		items: [],
		viewportWidth: 0,
		viewportHeight: 0,
		hidden: false,
		flashedId: null,
	});
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
		const spec = useMovementStore.getState().items[0].spec as { blocks: unknown[] };
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

	it('surfaces new panels but preserves the user stash across live updates', () => {
		applyMovementPayload({ op: 'add', id: 'a', body: '{"blocks":[]}' });
		useMovementStore.getState().setHidden(true);

		applyMovementPayload({ op: 'update', id: 'a', body: '{"blocks":[]}' });
		expect(useMovementStore.getState().hidden).toBe(true);

		applyMovementPayload({ op: 'add', id: 'b', body: '{"blocks":[]}' });
		expect(useMovementStore.getState().hidden).toBe(false);
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
		applyMovementPayload({ op: 'add', id: 'cli-status', body: JSON.stringify({ blocks: [] }) });

		expect(useMovementStore.getState().items[0].sourcePlugin).toBeUndefined();
	});
});

describe('movementStore actions', () => {
	beforeEach(reset);

	it('resizeItem clamps below the minimum panel size', () => {
		applyMovementPayload({ op: 'add', id: 'a', width: 400 });
		useMovementStore.getState().resizeItem('a', 50, 40);
		expect(useMovementStore.getState().items[0]).toMatchObject({ width: 200, height: 120 });
	});
});

describe('getMovementSnapshot', () => {
	beforeEach(reset);

	it('rounds coordinates and prefers the measured height over the explicit one', () => {
		useMovementStore.getState().setViewport(1920, 1080);
		applyMovementPayload({ op: 'add', id: 'a', x: 10.6, y: 20.4, width: 300.9, height: 200 });
		useMovementStore.getState().setMeasuredHeight('a', 260);
		const snap = getMovementSnapshot();
		expect(snap).toMatchObject({ width: 1920, height: 1080 });
		expect(snap.items[0]).toMatchObject({ id: 'a', x: 11, y: 20, width: 301, height: 260 });
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

	it('un-stashes the overlay, pulses the id, then clears after the timeout', () => {
		useMovementStore.setState({ hidden: true });
		useMovementStore.getState().flashItem('a');
		expect(useMovementStore.getState()).toMatchObject({ hidden: false, flashedId: 'a' });
		vi.advanceTimersByTime(2200);
		expect(useMovementStore.getState().flashedId).toBeNull();
	});
});
