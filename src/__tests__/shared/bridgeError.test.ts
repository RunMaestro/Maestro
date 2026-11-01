import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	BridgeTransportError,
	isBridgeTransportError,
	isExpectedBridgeError,
	isBridgeTransportReady,
} from '../../shared/bridgeError';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('bridge transport control flow', () => {
	it('recognizes unsent and read-only failures without suppressing uncertain submissions', () => {
		expect(isExpectedBridgeError(new BridgeTransportError('restoring', 'BRIDGE_RESTORING'))).toBe(
			true
		);
		expect(
			isExpectedBridgeError(new BridgeTransportError('timeout', 'BRIDGE_TIMEOUT', 'read-only'))
		).toBe(true);
		expect(
			isExpectedBridgeError(
				new BridgeTransportError(
					'save acknowledgement lost',
					'BRIDGE_SUBMISSION_UNCERTAIN',
					'unknown'
				)
			)
		).toBe(false);
		expect(
			isExpectedBridgeError(new Error('Submission uncertainty: process:spawn timed out'))
		).toBe(false);
		expect(isExpectedBridgeError(new Error('Bridge request timed out: process:spawn'))).toBe(false);
		expect(isExpectedBridgeError(new Error('Bridge request timed out: groupChat:list'))).toBe(true);
		expect(isExpectedBridgeError(new Error('Unexpected restore failure'))).toBe(false);
	});

	it('requires a known transport code and submission classification for serialized errors', () => {
		expect(isBridgeTransportError({ name: 'BridgeTransportError', code: 'BRIDGE_UNKNOWN' })).toBe(
			false
		);
		expect(isBridgeTransportError({ name: 'BridgeTransportError', code: 'BRIDGE_TIMEOUT' })).toBe(
			false
		);
		expect(
			isExpectedBridgeError({
				name: 'BridgeTransportError',
				code: 'BRIDGE_TIMEOUT',
				submission: 'read-only',
			})
		).toBe(true);
	});

	it('permits native work and pauses browser work until reconciliation completes', () => {
		expect(isBridgeTransportReady()).toBe(true);
		vi.stubGlobal('window', { __MAESTRO_BRIDGE_STATE__: 'reconnecting' });
		expect(isBridgeTransportReady()).toBe(false);
		(window as unknown as Record<string, unknown>).__MAESTRO_BRIDGE_STATE__ = 'connected';
		expect(isBridgeTransportReady()).toBe(true);
	});
});
