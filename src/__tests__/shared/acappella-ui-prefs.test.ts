/**
 * The HUD's remembered preferences, and where the widget is allowed to sit.
 *
 * The placement math is the part worth testing without a DOM: the cases that
 * matter are a position saved on a monitor that is no longer attached and a
 * window the user just made smaller, both of which leave a live microphone on
 * screen at coordinates nobody can see.
 */

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_VOICE_UI_PREFS,
	VOICE_HUD_EDGE_MARGIN,
	clampVoiceHudPosition,
	defaultVoiceHudPosition,
	readVoiceHudPosition,
	readVoiceUiPrefs,
} from '../../shared/acappella/ui-prefs';
import {
	VOICE_HUD_STATE_LABELS,
	voiceHudIsHotMic,
	voiceHudVisualState,
} from '../../shared/acappella/hud-state';
import {
	clampTtsRate,
	clampTtsVolume,
	DEFAULT_TTS_RATE,
	DEFAULT_TTS_VOLUME,
	MAX_TTS_RATE,
	MIN_TTS_RATE,
	MIN_TTS_VOLUME,
	resolveHoldThresholdMs,
	DEFAULT_HOLD_THRESHOLD_MS,
	MAX_HOLD_THRESHOLD_MS,
	MIN_HOLD_THRESHOLD_MS,
} from '../../shared/acappella/voice-controls';

const SIZE = { width: 340, height: 160 };
const VIEWPORT = { width: 1440, height: 900 };

describe('readVoiceUiPrefs', () => {
	it('reads an empty blob as the shipped defaults', () => {
		expect(readVoiceUiPrefs(undefined)).toEqual(DEFAULT_VOICE_UI_PREFS);
		expect(readVoiceUiPrefs({})).toEqual(DEFAULT_VOICE_UI_PREFS);
	});

	it('keeps the transcript off unless it was explicitly turned on', () => {
		expect(readVoiceUiPrefs({ transcriptVisible: 'yes' }).transcriptVisible).toBe(false);
		expect(readVoiceUiPrefs({ transcriptVisible: true }).transcriptVisible).toBe(true);
	});

	it('rejects a minimize behaviour it does not recognise', () => {
		expect(readVoiceUiPrefs({ minimizeBehavior: 'close' }).minimizeBehavior).toBe('manual');
		expect(readVoiceUiPrefs({ minimizeBehavior: 'auto-idle' }).minimizeBehavior).toBe('auto-idle');
	});
});

describe('readVoiceHudPosition', () => {
	it('takes a complete position', () => {
		expect(readVoiceHudPosition({ top: 10, left: 20 })).toEqual({ top: 10, left: 20 });
	});

	it.each([
		['half a position', { top: 10 }],
		['a string coordinate', { top: '10', left: 20 }],
		['a NaN coordinate', { top: Number.NaN, left: 20 }],
		['not an object', 'bottom-right'],
		['null', null],
	])('reads %s as no position at all', (_label, value) => {
		expect(readVoiceHudPosition(value)).toBeNull();
	});
});

describe('clampVoiceHudPosition', () => {
	it('leaves an on-screen position alone', () => {
		expect(clampVoiceHudPosition({ top: 100, left: 200 }, SIZE, VIEWPORT)).toEqual({
			top: 100,
			left: 200,
		});
	});

	it('pulls back a position saved on a monitor that is no longer there', () => {
		const rescued = clampVoiceHudPosition({ top: 400, left: 3000 }, SIZE, VIEWPORT);
		expect(rescued.left).toBe(VIEWPORT.width - SIZE.width);
		expect(rescued.top).toBe(400);
	});

	it('pulls back a position the window just shrank past', () => {
		const rescued = clampVoiceHudPosition({ top: 880, left: 100 }, SIZE, {
			width: 800,
			height: 600,
		});
		expect(rescued.top).toBe(600 - SIZE.height);
		expect(rescued.left).toBe(100);
	});

	it('never goes negative, even in a viewport smaller than the widget', () => {
		const rescued = clampVoiceHudPosition({ top: -50, left: -50 }, SIZE, {
			width: 100,
			height: 80,
		});
		expect(rescued).toEqual({ top: 0, left: 0 });
	});
});

describe('defaultVoiceHudPosition', () => {
	it('parks the widget bottom-right, inset by the edge margin', () => {
		expect(defaultVoiceHudPosition(SIZE, VIEWPORT)).toEqual({
			left: VIEWPORT.width - SIZE.width - VOICE_HUD_EDGE_MARGIN,
			top: VIEWPORT.height - SIZE.height - VOICE_HUD_EDGE_MARGIN,
		});
	});
});

describe('voiceHudVisualState', () => {
	it('collapses the three working states into one readable "thinking"', () => {
		expect(voiceHudVisualState('transcribing')).toBe('thinking');
		expect(voiceHudVisualState('routing')).toBe('thinking');
		expect(voiceHudVisualState('dispatching')).toBe('thinking');
	});

	it('reports an interruption as listening, because barge-in keeps the floor', () => {
		expect(voiceHudVisualState('interrupted')).toBe('listening');
	});

	it('never claims a hot microphone for a state that has none', () => {
		expect(voiceHudIsHotMic(voiceHudVisualState('listening'))).toBe(true);
		for (const state of ['idle', 'arming', 'speaking', 'routing', 'error'] as const) {
			expect(voiceHudIsHotMic(voiceHudVisualState(state))).toBe(false);
		}
	});

	it('has a label for every visual state', () => {
		for (const label of Object.values(VOICE_HUD_STATE_LABELS)) {
			expect(label.length).toBeGreaterThan(0);
		}
	});
});

describe('voice output clamps', () => {
	it('keeps the rate inside the shipped window', () => {
		expect(clampTtsRate(5)).toBe(MAX_TTS_RATE);
		expect(clampTtsRate(0.1)).toBe(MIN_TTS_RATE);
		expect(clampTtsRate('fast')).toBe(DEFAULT_TTS_RATE);
		expect(clampTtsRate(Number.NaN)).toBe(DEFAULT_TTS_RATE);
	});

	it('floors the volume above silence, so a slider cannot become a silent mute', () => {
		expect(clampTtsVolume(0)).toBe(MIN_TTS_VOLUME);
		expect(clampTtsVolume(-1)).toBe(MIN_TTS_VOLUME);
		expect(clampTtsVolume(4)).toBe(1);
		expect(clampTtsVolume(undefined)).toBe(DEFAULT_TTS_VOLUME);
	});

	it('clamps a hold threshold rather than rejecting it', () => {
		expect(resolveHoldThresholdMs(10)).toBe(MIN_HOLD_THRESHOLD_MS);
		expect(resolveHoldThresholdMs(99_999)).toBe(MAX_HOLD_THRESHOLD_MS);
		expect(resolveHoldThresholdMs('slow')).toBe(DEFAULT_HOLD_THRESHOLD_MS);
		expect(resolveHoldThresholdMs(450)).toBe(450);
	});
});
