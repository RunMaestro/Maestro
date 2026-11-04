import { describe, it, expect } from 'vitest';
import type React from 'react';
import { buildEventFromKeys, buildKeysFromEvent } from '../../../renderer/utils/shortcutRecorder';

function mkEvent(
	overrides: Partial<{
		key: string;
		code: string;
		metaKey: boolean;
		ctrlKey: boolean;
		altKey: boolean;
		shiftKey: boolean;
	}>
): React.KeyboardEvent {
	return {
		key: '',
		code: '',
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		...overrides,
	} as unknown as React.KeyboardEvent;
}

describe('buildKeysFromEvent', () => {
	it('returns null when only a modifier is pressed', () => {
		expect(buildKeysFromEvent(mkEvent({ key: 'Meta', metaKey: true }))).toBeNull();
		expect(buildKeysFromEvent(mkEvent({ key: 'Control', ctrlKey: true }))).toBeNull();
		expect(buildKeysFromEvent(mkEvent({ key: 'Alt', altKey: true }))).toBeNull();
		expect(buildKeysFromEvent(mkEvent({ key: 'Shift', shiftKey: true }))).toBeNull();
	});

	it('builds a plain Meta+letter combo', () => {
		expect(buildKeysFromEvent(mkEvent({ key: 'k', code: 'KeyK', metaKey: true }))).toEqual([
			'Meta',
			'k',
		]);
	});

	it('orders modifiers as Meta, Ctrl, Alt, Shift', () => {
		const keys = buildKeysFromEvent(
			mkEvent({
				key: 'x',
				code: 'KeyX',
				metaKey: true,
				ctrlKey: true,
				altKey: true,
				shiftKey: true,
			})
		);
		expect(keys).toEqual(['Meta', 'Ctrl', 'Alt', 'Shift', 'x']);
	});

	it('recovers physical letter key when Alt rewrites e.key (macOS Alt+p = π)', () => {
		const keys = buildKeysFromEvent(mkEvent({ key: 'π', code: 'KeyP', altKey: true }));
		expect(keys).toEqual(['Alt', 'p']);
	});

	it('recovers physical digit key when Alt rewrites e.key', () => {
		const keys = buildKeysFromEvent(mkEvent({ key: '¡', code: 'Digit1', altKey: true }));
		expect(keys).toEqual(['Alt', '1']);
	});

	it('leaves non-letter/digit keys alone under Alt', () => {
		const keys = buildKeysFromEvent(mkEvent({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }));
		expect(keys).toEqual(['Alt', 'ArrowLeft']);
	});

	it('uses e.key directly when Alt is not held', () => {
		const keys = buildKeysFromEvent(mkEvent({ key: '/', code: 'Slash', metaKey: true }));
		expect(keys).toEqual(['Meta', '/']);
	});
});

describe('buildEventFromKeys', () => {
	it('returns null for an empty key array', () => {
		expect(buildEventFromKeys([])).toBeNull();
	});

	it('sets the modifier flags named in the key array', () => {
		const e = buildEventFromKeys(['Alt', 'Meta', 'Shift', 'w'])!;
		expect(e.metaKey).toBe(true);
		expect(e.altKey).toBe(true);
		expect(e.shiftKey).toBe(true);
		expect(e.ctrlKey).toBe(false);
		expect(e.key).toBe('w');
	});

	it('treats Ctrl and Control as the same modifier', () => {
		expect(buildEventFromKeys(['Ctrl', 'd'])!.ctrlKey).toBe(true);
		expect(buildEventFromKeys(['Control', 'd'])!.ctrlKey).toBe(true);
	});

	it('populates e.code so Alt combos still match by physical key', () => {
		// A real macOS Alt+Q reports key 'œ'; isShortcut falls back to e.code.
		expect(buildEventFromKeys(['Alt', 'q'])!.code).toBe('KeyQ');
		expect(buildEventFromKeys(['Alt', 'Meta', '1'])!.code).toBe('Digit1');
	});

	it('maps punctuation keys to their physical code names', () => {
		expect(buildEventFromKeys(['Meta', ','])!.code).toBe('Comma');
		expect(buildEventFromKeys(['Meta', '/'])!.code).toBe('Slash');
		expect(buildEventFromKeys(['Meta', 'Shift', '['])!.code).toBe('BracketLeft');
	});

	it('leaves named keys as their own code', () => {
		expect(buildEventFromKeys(['Alt', 'Meta', 'ArrowLeft'])!.code).toBe('ArrowLeft');
		expect(buildEventFromKeys(['Meta', 'Shift', 'Backspace'])!.code).toBe('Backspace');
	});

	it('round-trips through buildKeysFromEvent', () => {
		// buildKeysFromEvent emits modifiers in its own canonical order, so compare
		// the key sets rather than the arrays.
		for (const keys of [
			['Meta', 'j'],
			['Alt', 'Meta', 'ArrowLeft'],
			['Meta', 'Shift', 'Backspace'],
			['Alt', 'q'],
		]) {
			const replayed = buildEventFromKeys(keys)!;
			const recorded = buildKeysFromEvent(replayed as unknown as React.KeyboardEvent);
			expect(recorded?.slice().sort()).toEqual(keys.slice().sort());
		}
	});

	it('bubbles and is cancelable so window-level handlers can preventDefault', () => {
		const e = buildEventFromKeys(['Meta', 'k'])!;
		expect(e.bubbles).toBe(true);
		expect(e.cancelable).toBe(true);
		expect(e.type).toBe('keydown');
	});
});
