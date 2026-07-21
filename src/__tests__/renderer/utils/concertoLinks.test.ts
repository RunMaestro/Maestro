/**
 * Tests for the Concerto chat "point" link parser + dispatcher. An agent drops a
 * markdown link with a `maestro://concerto/<surface>/<id>` href to point the user
 * at a view it composed; the chat renderer turns it into a chip and clicking it
 * pulses the target. These pin the parse (the security-relevant seam - a bad href
 * must never dispatch) and that a valid href flashes the right store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseConcertoHref, flashConcertoTarget } from '../../../renderer/utils/concertoLinks';
import { applyMovementPayload, useMovementStore } from '../../../renderer/stores/movementStore';

describe('parseConcertoHref', () => {
	it('parses the canonical maestro:// form for both surfaces', () => {
		expect(parseConcertoHref('maestro://concerto/movement/deploy-status')).toEqual({
			surface: 'movement',
			id: 'deploy-status',
		});
		expect(parseConcertoHref('maestro://concerto/cadenza/tests')).toEqual({
			surface: 'cadenza',
			id: 'tests',
		});
	});

	it('parses the bare concerto: fallback form', () => {
		expect(parseConcertoHref('concerto:movement/foo')).toEqual({ surface: 'movement', id: 'foo' });
	});

	it('decodes a percent-encoded id', () => {
		expect(parseConcertoHref('maestro://concerto/movement/a%2Fb')).toEqual({
			surface: 'movement',
			id: 'a/b',
		});
	});

	it('is case-insensitive on scheme and surface', () => {
		expect(parseConcertoHref('MAESTRO://CONCERTO/MOVEMENT/x')).toEqual({
			surface: 'movement',
			id: 'x',
		});
	});

	it('returns null for non-concerto, empty-id, unknown-surface, and nullish hrefs', () => {
		expect(parseConcertoHref('https://example.com')).toBeNull();
		expect(parseConcertoHref('maestro://concerto/movement/')).toBeNull();
		expect(parseConcertoHref('maestro://concerto/bogus/x')).toBeNull();
		expect(parseConcertoHref('')).toBeNull();
		expect(parseConcertoHref(null)).toBeNull();
		expect(parseConcertoHref(undefined)).toBeNull();
	});
});

describe('flashConcertoTarget', () => {
	let flashCadenza: ReturnType<typeof vi.fn>;
	let origMaestro: unknown;
	const win = window as unknown as { maestro: unknown };

	beforeEach(() => {
		vi.useFakeTimers();
		useMovementStore.setState({ items: [], dismissedItems: [], flashedId: null, hidden: true });
		flashCadenza = vi.fn();
		origMaestro = win.maestro;
		win.maestro = {
			process: {
				flashCadenza,
				restoreConcertoHtmlDocument: vi.fn().mockResolvedValue(17),
			},
		};
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		win.maestro = origMaestro;
	});

	it('flashes the movement store (and un-stashes it) for a live movement href', async () => {
		applyMovementPayload({ op: 'add', id: 'deploy' });
		useMovementStore.getState().setHidden(true);

		await expect(flashConcertoTarget('maestro://concerto/movement/deploy')).resolves.toBe(true);
		expect(useMovementStore.getState().flashedId).toBe('deploy');
		expect(useMovementStore.getState().hidden).toBe(false);
	});

	it('restores a dismissed HTML movement as a fresh document', async () => {
		applyMovementPayload({
			op: 'add',
			id: 'mockup',
			viewType: 'html',
			body: '<button>Fresh</button>',
			revision: 3,
		});
		useMovementStore.getState().dismissItem('mockup');

		await expect(flashConcertoTarget('maestro://concerto/movement/mockup')).resolves.toBe(true);

		expect((win.maestro as any).process.restoreConcertoHtmlDocument).toHaveBeenCalledWith(
			'movement',
			'mockup',
			'<button>Fresh</button>'
		);
		expect(useMovementStore.getState().items).toMatchObject([
			{ id: 'mockup', timestamp: 17, minimized: false },
		]);
		expect(useMovementStore.getState().dismissedItems).toEqual([]);
	});

	it('returns false when the movement is neither live nor recently dismissed', async () => {
		await expect(flashConcertoTarget('maestro://concerto/movement/missing')).resolves.toBe(false);
		expect(useMovementStore.getState().flashedId).toBeNull();
	});

	it('routes a cadenza href through main (flashCadenza), since cadenzas live in the HUD', async () => {
		await expect(flashConcertoTarget('maestro://concerto/cadenza/tests')).resolves.toBe(true);
		expect(flashCadenza).toHaveBeenCalledWith('tests');
	});

	it('is a no-op returning false for a non-concerto href', async () => {
		await expect(flashConcertoTarget('https://example.com')).resolves.toBe(false);
		expect(useMovementStore.getState().flashedId).toBeNull();
		expect(flashCadenza).not.toHaveBeenCalled();
	});
});
