/**
 * @file floatingWidgets.test.ts
 * @description The floating-widget contract: id validation, the widget specs,
 * and the command guards for the throughput gauge and the media player.
 */

import { describe, it, expect } from 'vitest';
import {
	FLOATING_WIDGET_IDS,
	FLOATING_WIDGET_SPECS,
	MEDIA_COMMAND_ACTIONS,
	isFloatingWidgetId,
	isMediaPlayerWidgetCommand,
	isThroughputGaugeWidgetCommand,
	isVoiceWidgetCommand,
} from '../../shared/floatingWidgets';

describe('isFloatingWidgetId', () => {
	it('accepts every known widget id', () => {
		for (const id of FLOATING_WIDGET_IDS) {
			expect(isFloatingWidgetId(id)).toBe(true);
		}
	});

	it('refuses unknown strings, including near misses', () => {
		expect(isFloatingWidgetId('')).toBe(false);
		expect(isFloatingWidgetId('throughput')).toBe(false);
		expect(isFloatingWidgetId('Throughput-Gauge')).toBe(false);
		expect(isFloatingWidgetId(' media-player')).toBe(false);
		expect(isFloatingWidgetId('constructor')).toBe(false);
	});

	it('refuses values that are not strings', () => {
		for (const value of [undefined, null, 0, 1, true, {}, [], ['media-player']]) {
			expect(isFloatingWidgetId(value)).toBe(false);
		}
	});
});

describe('FLOATING_WIDGET_SPECS', () => {
	it('has one spec per id, keyed by its own id', () => {
		expect(Object.keys(FLOATING_WIDGET_SPECS).sort()).toEqual([...FLOATING_WIDGET_IDS].sort());
		for (const id of FLOATING_WIDGET_IDS) {
			expect(FLOATING_WIDGET_SPECS[id].id).toBe(id);
		}
	});

	it('names the window that owns each widget', () => {
		expect(FLOATING_WIDGET_SPECS['throughput-gauge'].authority).toBe('app');
		expect(FLOATING_WIDGET_SPECS['media-player'].authority).toBe('widget');
		expect(FLOATING_WIDGET_SPECS['acappella-voice'].authority).toBe('app');
	});

	it('never opens a widget below its own minimum size', () => {
		for (const id of FLOATING_WIDGET_IDS) {
			const { defaultSize, minSize } = FLOATING_WIDGET_SPECS[id];
			expect(defaultSize.width).toBeGreaterThanOrEqual(minSize.width);
			expect(defaultSize.height).toBeGreaterThanOrEqual(minSize.height);
		}
	});
});

describe('isThroughputGaugeWidgetCommand', () => {
	it('accepts the hide and reset-peak commands', () => {
		expect(isThroughputGaugeWidgetCommand({ type: 'hide' })).toBe(true);
		expect(isThroughputGaugeWidgetCommand({ type: 'reset-peak' })).toBe(true);
	});

	it('refuses unknown or misspelled command types', () => {
		for (const type of ['', 'show', 'Hide', 'reset', 'resetPeak', 'toString', 'constructor']) {
			expect(isThroughputGaugeWidgetCommand({ type })).toBe(false);
		}
	});

	it('refuses values that are not command objects', () => {
		for (const value of [
			undefined,
			null,
			'hide',
			0,
			true,
			{},
			[],
			['hide'],
			{ type: 1 },
			{ kind: 'hide' },
		]) {
			expect(isThroughputGaugeWidgetCommand(value)).toBe(false);
		}
	});
});

describe('MEDIA_COMMAND_ACTIONS', () => {
	it('lists exactly the store commands a caller issues, once each', () => {
		expect([...MEDIA_COMMAND_ACTIONS].sort()).toEqual(
			[
				'clearHistory',
				'clearQueue',
				'closeItem',
				'dismiss',
				'enqueueMedia',
				'openMedia',
				'openPlayer',
				'removeHistoryItem',
				'requestToggle',
				'restore',
				'setActiveItem',
			].sort()
		);
		expect(new Set(MEDIA_COMMAND_ACTIONS).size).toBe(MEDIA_COMMAND_ACTIONS.length);
	});
});

describe('isMediaPlayerWidgetCommand', () => {
	it('accepts every command action with an argument list', () => {
		for (const action of MEDIA_COMMAND_ACTIONS) {
			expect(isMediaPlayerWidgetCommand({ type: 'action', action, args: [] })).toBe(true);
		}
		expect(
			isMediaPlayerWidgetCommand({
				type: 'action',
				action: 'setActiveItem',
				args: ['item-1', { autoplay: true }],
			})
		).toBe(true);
	});

	it('refuses element reports, which only the authority makes', () => {
		for (const action of [
			'setPlaying',
			'rememberTime',
			'rememberDuration',
			'rememberAspect',
			'advanceAfterEnded',
			'consumeAutoplay',
			'setFloatGeometry',
			'setFloatFootprint',
		]) {
			expect(isMediaPlayerWidgetCommand({ type: 'action', action, args: [] })).toBe(false);
		}
	});

	it('refuses unknown, misspelled, or inherited action names', () => {
		for (const action of ['', 'OpenMedia', 'open', 'setState', 'toString', 'constructor']) {
			expect(isMediaPlayerWidgetCommand({ type: 'action', action, args: [] })).toBe(false);
		}
	});

	it('refuses a command without an argument array or with the wrong type', () => {
		expect(isMediaPlayerWidgetCommand({ type: 'action', action: 'dismiss' })).toBe(false);
		expect(isMediaPlayerWidgetCommand({ type: 'action', action: 'dismiss', args: 'x' })).toBe(
			false
		);
		expect(isMediaPlayerWidgetCommand({ type: 'action', action: 'dismiss', args: {} })).toBe(false);
		expect(isMediaPlayerWidgetCommand({ type: 'hide', action: 'dismiss', args: [] })).toBe(false);
		expect(isMediaPlayerWidgetCommand({ action: 'dismiss', args: [] })).toBe(false);
	});

	it('refuses values that are not command objects', () => {
		for (const value of [undefined, null, 'dismiss', 0, true, {}, [], [{ type: 'action' }]]) {
			expect(isMediaPlayerWidgetCommand(value)).toBe(false);
		}
	});
});

describe('isVoiceWidgetCommand', () => {
	it.each([
		{ type: 'close' },
		{ type: 'minimize' },
		{ type: 'open-mic', hold: true },
		{ type: 'close-mic', send: false },
		{ type: 'set-mode', mode: 'agent' },
		{ type: 'cycle-mode', direction: -1 },
		{ type: 'set-wait', waitMs: null },
		{ type: 'set-wait', waitMs: 800 },
		{ type: 'set-input', deviceId: 'headset' },
		{ type: 'set-force-send', enabled: true },
		{ type: 'set-send-phrases', phrases: '' },
		{ type: 'navigate', agentSessionId: 'agent', tabId: 'tab' },
	])('accepts a typed voice control: %j', (command) => {
		expect(isVoiceWidgetCommand(command)).toBe(true);
	});
	it.each([
		null,
		[],
		{},
		{ type: 'start' },
		{ type: 'open-mic', hold: 'yes' },
		{ type: 'set-mode', mode: 'document' },
		{ type: 'set-wait', waitMs: NaN },
		{ type: 'set-wait', waitMs: -1 },
		{ type: 'cycle-mode', direction: 0 },
		{ type: 'set-input', deviceId: '' },
		{ type: 'set-force-send', enabled: 1 },
		{ type: 'navigate', agentSessionId: 'agent' },
	])('refuses malformed voice controls: %j', (command) => {
		expect(isVoiceWidgetCommand(command)).toBe(false);
	});
});
