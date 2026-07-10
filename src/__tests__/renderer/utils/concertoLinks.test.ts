/**
 * Tests for the Concerto chat "point" link parser + dispatcher. An agent drops a
 * markdown link with a `maestro://concerto/<surface>/<id>` href to point the user
 * at a view it composed; the chat renderer turns it into a chip and clicking it
 * pulses the target. These pin the parse (the security-relevant seam - a bad href
 * must never dispatch) and that a valid href flashes the right store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseConcertoHref, flashConcertoTarget } from '../../../renderer/utils/concertoLinks';
import { useMovementStore } from '../../../renderer/stores/movementStore';

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
		useMovementStore.setState({ flashedId: null, hidden: true });
		flashCadenza = vi.fn();
		origMaestro = win.maestro;
		win.maestro = { process: { flashCadenza } };
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		win.maestro = origMaestro;
	});

	it('flashes the movement store (and un-stashes it) for a movement href', () => {
		expect(flashConcertoTarget('maestro://concerto/movement/deploy')).toBe(true);
		expect(useMovementStore.getState().flashedId).toBe('deploy');
		expect(useMovementStore.getState().hidden).toBe(false);
	});

	it('routes a cadenza href through main (flashCadenza), since cadenzas live in the HUD', () => {
		expect(flashConcertoTarget('maestro://concerto/cadenza/tests')).toBe(true);
		expect(flashCadenza).toHaveBeenCalledWith('tests');
	});

	it('is a no-op returning false for a non-concerto href', () => {
		expect(flashConcertoTarget('https://example.com')).toBe(false);
		expect(useMovementStore.getState().flashedId).toBeNull();
		expect(flashCadenza).not.toHaveBeenCalled();
	});
});
