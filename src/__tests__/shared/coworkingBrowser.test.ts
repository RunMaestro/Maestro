/**
 * @file coworkingBrowser.test.ts
 * @description The pick target rules shared by `maestro-cli browser-pick`, the
 * `pick_browser_element` handler and the main-process pick: a selector or a
 * `--rect` region, exactly one.
 */

import { describe, it, expect } from 'vitest';
import {
	BROWSER_PICK_RECT_MIN_SIDE,
	formatBrowserPickRect,
	parseBrowserPickRect,
	readBrowserPickRect,
	readBrowserPickTarget,
} from '../../shared/coworkingBrowser';

describe('parseBrowserPickRect', () => {
	it('reads x,y,width,height, with space around a number allowed', () => {
		expect(parseBrowserPickRect('0,120,1280,400')).toEqual({
			x: 0,
			y: 120,
			width: 1280,
			height: 400,
		});
		expect(parseBrowserPickRect(' 10 , 20.5 ,640, 220 ')).toEqual({
			x: 10,
			y: 20.5,
			width: 640,
			height: 220,
		});
		expect(parseBrowserPickRect('.5,0,1,1')).toEqual({ x: 0.5, y: 0, width: 1, height: 1 });
	});

	it('lets the origin be negative: the page clips the box to its viewport', () => {
		expect(parseBrowserPickRect('-40,-10,200,100')).toEqual({
			x: -40,
			y: -10,
			width: 200,
			height: 100,
		});
	});

	it('refuses anything that is not four plain numbers', () => {
		for (const text of [
			'',
			'1,2,3',
			'1,2,3,4,5',
			'1,,3,4',
			'1,2,3,4,',
			'a,b,c,d',
			'1;2;3;4',
			'1 2 3 4',
			'1e3,0,10,10',
			'0x10,0,10,10',
			'1,2,3px,4',
			'Infinity,0,10,10',
			'NaN,0,10,10',
			'+1,0,10,10',
			'1.,0,10,10',
		]) {
			expect(parseBrowserPickRect(text), text).toBeNull();
		}
	});

	it('refuses a width or height under the minimum side', () => {
		expect(BROWSER_PICK_RECT_MIN_SIDE).toBe(1);
		expect(parseBrowserPickRect('0,0,0,100')).toBeNull();
		expect(parseBrowserPickRect('0,0,100,0.5')).toBeNull();
		expect(parseBrowserPickRect('0,0,-100,100')).toBeNull();
		expect(parseBrowserPickRect('0,0,1,1')).toEqual({ x: 0, y: 0, width: 1, height: 1 });
	});

	it('refuses a number too large to be finite', () => {
		expect(parseBrowserPickRect(`0,0,${'9'.repeat(400)},10`)).toBeNull();
	});
});

describe('readBrowserPickRect', () => {
	it('takes four finite numbers and returns a fresh box with only them', () => {
		const sent = { x: 1, y: 2, width: 3, height: 4, frame: { width: 10, height: 10 } };
		const read = readBrowserPickRect(sent);
		expect(read).toEqual({ x: 1, y: 2, width: 3, height: 4 });
		// Nothing else the sender put on the object travels on.
		expect(read).not.toHaveProperty('frame');
		expect(read).not.toBe(sent);
	});

	it('refuses a missing field, a string, a non-finite number, or a non-object', () => {
		for (const value of [
			undefined,
			null,
			'0,0,10,10',
			[0, 0, 10, 10],
			{ x: 0, y: 0, width: 10 },
			{ x: '0', y: 0, width: 10, height: 10 },
			{ x: 0, y: 0, width: Number.NaN, height: 10 },
			{ x: Number.POSITIVE_INFINITY, y: 0, width: 10, height: 10 },
			{ x: 0, y: 0, width: 10, height: 0 },
		]) {
			expect(readBrowserPickRect(value), JSON.stringify(value) ?? String(value)).toBeNull();
		}
	});
});

describe('formatBrowserPickRect', () => {
	it('spells a box as --rect takes it, so parsing it back gives the same box', () => {
		const rect = { x: -4, y: 20.5, width: 640, height: 220 };
		expect(formatBrowserPickRect(rect)).toBe('-4,20.5,640,220');
		expect(parseBrowserPickRect(formatBrowserPickRect(rect))).toEqual(rect);
	});
});

describe('readBrowserPickTarget', () => {
	it('names an element by its trimmed selector', () => {
		expect(readBrowserPickTarget({ selector: ' .hero h1 ' })).toEqual({
			ok: true,
			target: { selector: '.hero h1' },
		});
	});

	it('names a region by its rect', () => {
		expect(readBrowserPickTarget({ rect: { x: 0, y: 120, width: 1280, height: 400 } })).toEqual({
			ok: true,
			target: { rect: { x: 0, y: 120, width: 1280, height: 400 } },
		});
		// A blank selector next to a rect is no selector.
		expect(
			readBrowserPickTarget({ selector: '  ', rect: { x: 0, y: 0, width: 10, height: 10 } })
		).toEqual({ ok: true, target: { rect: { x: 0, y: 0, width: 10, height: 10 } } });
	});

	it('refuses both at once, a malformed rect, and neither', () => {
		expect(
			readBrowserPickTarget({ selector: 'h1', rect: { x: 0, y: 0, width: 10, height: 10 } })
		).toEqual({ ok: false, error: 'Send a selector or a rect, not both' });
		// A rect that is there but wrong is an error, never a fall back to the selector.
		const malformed = readBrowserPickTarget({ rect: { x: 0, y: 0, width: 0, height: 10 } });
		expect(malformed.ok).toBe(false);
		expect(!malformed.ok && malformed.error).toContain('Invalid rect');
		expect(readBrowserPickTarget({ rect: '0,0,10,10' }).ok).toBe(false);
		expect(readBrowserPickTarget({})).toEqual({ ok: false, error: 'Missing selector or rect' });
		expect(readBrowserPickTarget({ selector: '   ', rect: null })).toEqual({
			ok: false,
			error: 'Missing selector or rect',
		});
		expect(readBrowserPickTarget({ selector: 42 })).toEqual({
			ok: false,
			error: 'Missing selector or rect',
		});
	});
});
