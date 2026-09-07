/**
 * Tests for the A Cappella shared protocol module (src/shared/acappella/).
 *
 * These cover the runtime pieces only: the state transition table, the event
 * direction map, and the route decision helpers plus JSON Schema. The session
 * service's use of them is tested separately in the main-process suites.
 */

import { describe, it, expect } from 'vitest';
import {
	VOICE_EVENT_DIRECTIONS,
	isClientVoiceEvent,
	isContiguousVoiceSeq,
	type VoiceEvent,
	type VoiceEventType,
} from '../../shared/acappella/protocol';
import {
	VOICE_SESSION_STATES,
	VOICE_STATE_TRANSITIONS,
	assertVoiceStateTransition,
	canTransitionVoiceState,
	isVoiceSessionActive,
	InvalidVoiceStateTransitionError,
	type VoiceSessionState,
} from '../../shared/acappella/session-state';
import {
	ROUTE_DECISION_JSON_SCHEMA,
	ROUTE_TAB_ACTIONS,
	isConductorTarget,
	routeTargetSessionId,
} from '../../shared/acappella/route-decision';
import {
	audioHostErrorToMicIssue,
	audioHostErrorToSessionError,
	isRecoverableAudioHostError,
	type AudioHostErrorCode,
} from '../../shared/acappella/audio-host';
import { micSettingsLabel, micSettingsUrl } from '../../shared/acappella/mic-settings';

const ALL_EVENT_TYPES: VoiceEventType[] = [
	'wake',
	'listen-start',
	'listen-stop',
	'partial-transcript',
	'final-transcript',
	'route-decision',
	'dispatch',
	'route-correction',
	'agent-reply',
	'speak-start',
	'speak-sentence',
	'speak-end',
	'barge-in',
	'stop-word',
	'session-error',
	'audio-level',
	'mic-state',
	'provider-state',
	'tab-state',
	'agent-roster',
];

function makeEvent(type: VoiceEventType): VoiceEvent {
	return { type, sessionId: 'voice-1', seq: 1, ts: 0 } as VoiceEvent;
}

describe('VOICE_STATE_TRANSITIONS', () => {
	it('should cover every state as a source', () => {
		expect(Object.keys(VOICE_STATE_TRANSITIONS).sort()).toEqual([...VOICE_SESSION_STATES].sort());
	});

	it('should only name known states as targets', () => {
		for (const targets of Object.values(VOICE_STATE_TRANSITIONS)) {
			for (const target of targets) {
				expect(VOICE_SESSION_STATES).toContain(target);
			}
		}
	});

	it('should let every non-idle state stop to idle', () => {
		for (const state of VOICE_SESSION_STATES) {
			if (state === 'idle') continue;
			expect(canTransitionVoiceState(state, 'idle')).toBe(true);
		}
	});

	it('should keep the floor on barge-in: speaking -> interrupted -> listening', () => {
		expect(canTransitionVoiceState('speaking', 'interrupted')).toBe(true);
		expect(canTransitionVoiceState('interrupted', 'listening')).toBe(true);
	});

	it('should reject skipping the pipeline', () => {
		expect(canTransitionVoiceState('idle', 'speaking')).toBe(false);
		expect(canTransitionVoiceState('listening', 'dispatching')).toBe(false);
		expect(canTransitionVoiceState('error', 'listening')).toBe(false);
	});
});

describe('assertVoiceStateTransition', () => {
	it('should not throw on a legal edge', () => {
		expect(() => assertVoiceStateTransition('idle', 'arming')).not.toThrow();
	});

	it('should accept every edge the table names and reject every pair it does not', () => {
		const rejected: string[] = [];
		for (const from of VOICE_SESSION_STATES) {
			for (const to of VOICE_SESSION_STATES) {
				if (VOICE_STATE_TRANSITIONS[from].includes(to)) {
					expect(() => assertVoiceStateTransition(from, to)).not.toThrow();
					continue;
				}
				expect(() => assertVoiceStateTransition(from, to)).toThrow(
					InvalidVoiceStateTransitionError
				);
				rejected.push(`${from} -> ${to}`);
			}
		}

		// A state is never a legal target of itself: re-entering `speaking` would
		// silently orphan the utterance already on the floor.
		for (const state of VOICE_SESSION_STATES) {
			expect(rejected).toContain(`${state} -> ${state}`);
		}
	});

	it('should throw a typed error naming both states', () => {
		let caught: unknown;
		try {
			assertVoiceStateTransition('idle', 'speaking');
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(InvalidVoiceStateTransitionError);
		const typed = caught as InvalidVoiceStateTransitionError;
		expect(typed.from).toBe('idle');
		expect(typed.to).toBe('speaking');
		expect(typed.message).toContain('idle -> speaking');
	});
});

describe('isVoiceSessionActive', () => {
	it('should treat idle and error as not holding resources', () => {
		const inactive: VoiceSessionState[] = ['idle', 'error'];
		for (const state of VOICE_SESSION_STATES) {
			expect(isVoiceSessionActive(state)).toBe(!inactive.includes(state));
		}
	});
});

describe('VOICE_EVENT_DIRECTIONS', () => {
	it('should have an entry for every event type', () => {
		expect(Object.keys(VOICE_EVENT_DIRECTIONS).sort()).toEqual([...ALL_EVENT_TYPES].sort());
	});

	it('should mark exactly the four client-originated events as both-way', () => {
		const both = ALL_EVENT_TYPES.filter((type) => VOICE_EVENT_DIRECTIONS[type] === 'both');
		expect(both.sort()).toEqual(['barge-in', 'final-transcript', 'stop-word', 'wake']);
	});

	it('should classify events through isClientVoiceEvent', () => {
		expect(isClientVoiceEvent(makeEvent('barge-in'))).toBe(true);
		expect(isClientVoiceEvent(makeEvent('speak-sentence'))).toBe(false);
	});
});

describe('audio host error translation', () => {
	const ALL_CODES: AudioHostErrorCode[] = [
		'permission-denied',
		'no-device',
		'device-lost',
		'unsupported',
		'audio-init-failed',
	];

	it('gives every capture failure the same session error code', () => {
		for (const code of ALL_CODES) {
			const error = audioHostErrorToSessionError({ kind: 'mic-error', code, message: 'x' });
			expect(error.code).toBe('audio-capture-failed');
			expect(error.recoverable).toBe(isRecoverableAudioHostError(code));
		}
	});

	it('keeps the three user-fixable failures apart and collapses the rest', () => {
		expect(audioHostErrorToMicIssue('permission-denied')).toBe('permission-denied');
		expect(audioHostErrorToMicIssue('no-device')).toBe('no-device');
		expect(audioHostErrorToMicIssue('device-lost')).toBe('device-lost');
		expect(audioHostErrorToMicIssue('unsupported')).toBe('unavailable');
		expect(audioHostErrorToMicIssue('audio-init-failed')).toBe('unavailable');
	});

	it('agrees with the session error about which failures the user can act on', () => {
		for (const code of ALL_CODES) {
			expect(audioHostErrorToMicIssue(code) === 'unavailable').toBe(
				!isRecoverableAudioHostError(code)
			);
		}
	});
});

describe('micSettingsUrl', () => {
	it('knows where the microphone permission lives on macOS and Windows', () => {
		expect(micSettingsUrl('darwin')).toContain('Privacy_Microphone');
		expect(micSettingsUrl('win32')).toBe('ms-settings:privacy-microphone');
	});

	it('returns null where there is no reliable deep link', () => {
		// A button that opens the wrong window is worse than a sentence saying
		// where to look, so Linux gets no URL rather than a guess.
		expect(micSettingsUrl('linux')).toBeNull();
		expect(micSettingsUrl('')).toBeNull();
	});

	it('names the place the user is being sent', () => {
		expect(micSettingsLabel('win32')).toBe('Open Microphone Settings');
		expect(micSettingsLabel('darwin')).toBe('Open Privacy Settings');
	});
});

describe('isContiguousVoiceSeq', () => {
	it('should accept the next sequence number and reject gaps or replays', () => {
		expect(isContiguousVoiceSeq(4, 5)).toBe(true);
		expect(isContiguousVoiceSeq(4, 6)).toBe(false);
		expect(isContiguousVoiceSeq(4, 4)).toBe(false);
	});
});

describe('route decision helpers', () => {
	it('should identify the conductor target', () => {
		expect(isConductorTarget('conductor')).toBe(true);
		expect(isConductorTarget({ sessionId: 'agent-1' })).toBe(false);
	});

	it('should extract the agent id, or null for the conductor', () => {
		expect(routeTargetSessionId({ sessionId: 'agent-1' })).toBe('agent-1');
		expect(routeTargetSessionId('conductor')).toBeNull();
	});
});

describe('ROUTE_DECISION_JSON_SCHEMA', () => {
	it('should describe the same tab actions as the type', () => {
		expect(ROUTE_DECISION_JSON_SCHEMA.properties.tabAction.enum).toEqual(ROUTE_TAB_ACTIONS);
	});

	it('should require the fields a dispatch cannot run without', () => {
		expect(ROUTE_DECISION_JSON_SCHEMA.required).toEqual([
			'target',
			'tabAction',
			'prompt',
			'confidence',
		]);
	});

	it('should stay GBNF-friendly: closed object, no $ref, bounded confidence', () => {
		const serialized = JSON.stringify(ROUTE_DECISION_JSON_SCHEMA);
		expect(serialized).not.toContain('$ref');
		expect(ROUTE_DECISION_JSON_SCHEMA.additionalProperties).toBe(false);
		expect(ROUTE_DECISION_JSON_SCHEMA.properties.confidence.minimum).toBe(0);
		expect(ROUTE_DECISION_JSON_SCHEMA.properties.confidence.maximum).toBe(1);
	});
});
