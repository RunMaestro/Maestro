import { describe, it, expect } from 'vitest';
import {
	parseUrlRoutingHint,
	isWebUrl,
	hasUrlRoutingHint,
	stripUrlRoutingHint,
} from '../../shared/urlRoutingHint';

describe('parseUrlRoutingHint', () => {
	it('leaves an unhinted URL untouched', () => {
		expect(parseUrlRoutingHint('https://example.com/a#b')).toEqual({
			kind: 'none',
			url: 'https://example.com/a#b',
		});
	});

	it('strips a maestro+ hint', () => {
		expect(parseUrlRoutingHint('maestro+http://localhost:8000/x?y=1#z')).toEqual({
			kind: 'hinted',
			hint: 'maestro',
			url: 'http://localhost:8000/x?y=1#z',
		});
	});

	it('strips a system+ hint', () => {
		expect(parseUrlRoutingHint('system+https://github.com')).toEqual({
			kind: 'hinted',
			hint: 'system',
			url: 'https://github.com',
		});
	});

	it('is case-insensitive on the hint and the scheme', () => {
		expect(parseUrlRoutingHint('Maestro+HTTPS://x.com')).toEqual({
			kind: 'hinted',
			hint: 'maestro',
			url: 'HTTPS://x.com',
		});
	});

	it.each([
		'maestro+file:///tmp/x',
		'maestro+javascript:void(0)',
		'system+ssh://host',
		'maestro+',
		'system+mailto:a@b.c',
		'maestro+https:/missing-slash',
	])('rejects a hint in front of a non-http target: %s', (url) => {
		expect(parseUrlRoutingHint(url)).toEqual({ kind: 'invalid' });
	});

	it('does not treat the maestro:// deep-link scheme as a hint', () => {
		expect(parseUrlRoutingHint('maestro://agent/1')).toEqual({
			kind: 'none',
			url: 'maestro://agent/1',
		});
	});
});

describe('isWebUrl / hasUrlRoutingHint / stripUrlRoutingHint', () => {
	it('accepts plain and hinted http(s)', () => {
		expect(isWebUrl('https://x.com')).toBe(true);
		expect(isWebUrl('maestro+http://localhost')).toBe(true);
		expect(isWebUrl('system+https://x.com')).toBe(true);
	});

	it('rejects other schemes, hinted or not', () => {
		expect(isWebUrl('mailto:a@b.c')).toBe(false);
		expect(isWebUrl('maestro+file:///tmp/x')).toBe(false);
		expect(isWebUrl('maestro://x')).toBe(false);
	});

	it('reports a hint only when it is valid', () => {
		expect(hasUrlRoutingHint('maestro+https://x.com')).toBe(true);
		expect(hasUrlRoutingHint('https://x.com')).toBe(false);
		expect(hasUrlRoutingHint('maestro+javascript:void(0)')).toBe(false);
	});

	it('strips a valid hint and leaves anything else unchanged', () => {
		expect(stripUrlRoutingHint('maestro+https://x.com/p')).toBe('https://x.com/p');
		expect(stripUrlRoutingHint('https://x.com/p')).toBe('https://x.com/p');
		expect(stripUrlRoutingHint('system+ssh://host')).toBe('system+ssh://host');
	});
});
