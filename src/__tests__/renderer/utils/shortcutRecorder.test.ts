import { describe, it, expect } from 'vitest';
import type React from 'react';
import {
	buildEventFromKeys,
	buildKeysFromEvent,
	recordSequenceStep,
} from '../../../renderer/utils/shortcutRecorder';

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

describe('recordSequenceStep', () => {
	it('captures a first step', () => {
		const result = recordSequenceStep(mkEvent({ key: 'g', code: 'KeyG' }), []);
		expect(result).toEqual({ outcome: 'step', steps: [['g']] });
	});

	it('captures successive steps, which is the whole point of a sequence', () => {
		const first = recordSequenceStep(mkEvent({ key: 'g', code: 'KeyG' }), []);
		expect(first.outcome).toBe('step');
		const second = recordSequenceStep(
			mkEvent({ key: 't', code: 'KeyT' }),
			first.outcome === 'step' ? first.steps : []
		);
		expect(second).toEqual({ outcome: 'step', steps: [['g'], ['t']] });
	});

	it('records Shift as part of the step, so G is a one-step sequence', () => {
		const result = recordSequenceStep(mkEvent({ key: 'G', code: 'KeyG', shiftKey: true }), []);
		expect(result).toEqual({ outcome: 'step', steps: [['Shift', 'G']] });
	});

	it('keeps recording through a modifier-only keydown without capturing it', () => {
		// Shift fires its own keydown before the character it shifts. Treating
		// that as a step would make `g G` impossible to record.
		const result = recordSequenceStep(mkEvent({ key: 'Shift', shiftKey: true }), [['g']]);
		expect(result).toEqual({ outcome: 'waiting' });
	});

	it('ignores CapsLock and AltGraph, which buildKeysFromEvent would record', () => {
		// The two keys the modifier-only gate is actually load bearing for:
		// `buildKeysFromEvent` only refuses Meta, Control, Alt and Shift, so
		// without the gate a CapsLock press would become a step no keypress can
		// ever satisfy.
		expect(recordSequenceStep(mkEvent({ key: 'CapsLock' }), [['g']])).toEqual({
			outcome: 'waiting',
		});
		expect(recordSequenceStep(mkEvent({ key: 'AltGraph' }), [])).toEqual({ outcome: 'waiting' });
	});

	it('cancels on Escape', () => {
		expect(recordSequenceStep(mkEvent({ key: 'Escape' }), [['g']])).toEqual({
			outcome: 'cancelled',
		});
	});

	it('confirms the captured run on Enter', () => {
		expect(recordSequenceStep(mkEvent({ key: 'Enter' }), [['g'], ['t']])).toEqual({
			outcome: 'confirmed',
			sequence: [['g'], ['t']],
		});
	});

	it('cancels rather than clearing when Enter arrives with nothing captured', () => {
		// The confirm key must not unbind a sequence the user never touched.
		expect(recordSequenceStep(mkEvent({ key: 'Enter' }), [])).toEqual({ outcome: 'cancelled' });
	});

	it('undoes the last step on Backspace', () => {
		expect(recordSequenceStep(mkEvent({ key: 'Backspace' }), [['g'], ['t']])).toEqual({
			outcome: 'step',
			steps: [['g']],
		});
	});

	it('clears the binding when there is nothing left to undo', () => {
		expect(recordSequenceStep(mkEvent({ key: 'Backspace' }), [])).toEqual({ outcome: 'cleared' });
		expect(recordSequenceStep(mkEvent({ key: 'Delete' }), [])).toEqual({ outcome: 'cleared' });
	});

	it('refuses a step carrying Meta, Ctrl, or Alt, and names the chord', () => {
		// The matcher clears a live run on any such event, so a step holding one
		// could never fire. The recorder is the only place to say why.
		expect(recordSequenceStep(mkEvent({ key: 'k', code: 'KeyK', metaKey: true }), [])).toEqual({
			outcome: 'rejected',
			keys: ['Meta', 'k'],
		});
		expect(recordSequenceStep(mkEvent({ key: 'j', code: 'KeyJ', ctrlKey: true }), [['g']])).toEqual(
			{ outcome: 'rejected', keys: ['Ctrl', 'j'] }
		);
		expect(recordSequenceStep(mkEvent({ key: 'π', code: 'KeyP', altKey: true }), [])).toEqual({
			outcome: 'rejected',
			keys: ['Alt', 'p'],
		});
	});

	it('refuses a modified Enter or Backspace rather than reading it as a control', () => {
		expect(recordSequenceStep(mkEvent({ key: 'Enter', metaKey: true }), [['g']])).toEqual({
			outcome: 'rejected',
			keys: ['Meta', 'Enter'],
		});
		expect(recordSequenceStep(mkEvent({ key: 'Backspace', metaKey: true }), [])).toEqual({
			outcome: 'rejected',
			keys: ['Meta', 'Backspace'],
		});
	});

	it('keeps recording when a modifier is held down on its own', () => {
		// `Meta` with metaKey set is the user reaching for a chord, not a chord.
		expect(recordSequenceStep(mkEvent({ key: 'Meta', metaKey: true }), [['g']])).toEqual({
			outcome: 'waiting',
		});
	});

	it('does not alias or mutate the steps it was handed', () => {
		const steps = [['g']];
		const result = recordSequenceStep(mkEvent({ key: 't', code: 'KeyT' }), steps);
		expect(steps).toEqual([['g']]);
		if (result.outcome !== 'step') throw new Error('expected a step');
		result.steps[0].push('Shift');
		expect(steps[0]).toEqual(['g']);
	});

	it('copies the confirmed sequence out of the captured steps', () => {
		const steps = [['g'], ['t']];
		const result = recordSequenceStep(mkEvent({ key: 'Enter' }), steps);
		if (result.outcome !== 'confirmed') throw new Error('expected a confirmation');
		result.sequence.push(['x']);
		expect(steps).toEqual([['g'], ['t']]);
	});
});
