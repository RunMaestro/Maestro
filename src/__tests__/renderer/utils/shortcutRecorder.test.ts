import { describe, it, expect } from 'vitest';
import type React from 'react';
import { buildKeysFromEvent } from '../../../renderer/utils/shortcutRecorder';

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
