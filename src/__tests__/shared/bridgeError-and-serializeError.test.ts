// Source: src/__tests__/shared/bridgeError.test.ts
// Source: src/__tests__/shared/serializeError.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { afterEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { BridgeTransportError } from '../../shared/bridgeError';
import { isBridgeTransportError } from '../../shared/bridgeError';
import { isExpectedBridgeError } from '../../shared/bridgeError';
import { isBridgeTransportReady } from '../../shared/bridgeError';
import { ipcErrorMessage } from '../../shared/serializeError';
import { serializeError } from '../../shared/serializeError';
import { toLoggableData } from '../../shared/serializeError';
describeSourceSuite('bridgeError', () => {
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
			expect(isExpectedBridgeError(new Error('Bridge request timed out: process:spawn'))).toBe(
				false
			);
			expect(isExpectedBridgeError(new Error('Bridge request timed out: groupChat:list'))).toBe(
				true
			);
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
});
describeSourceSuite('serializeError', () => {
	describe('serializeError', () => {
		it('keeps name, message and stack, which JSON.stringify drops', () => {
			const err = new TypeError('boom');
			expect(JSON.stringify(err)).toBe('{}');
			const out = serializeError(err);
			expect(out).toMatchObject({ name: 'TypeError', message: 'boom', stack: err.stack });
			expect(JSON.parse(JSON.stringify(out)).message).toBe('boom');
		});

		it('keeps enumerable extras such as a Node error code', () => {
			const err = Object.assign(new Error('nope'), { code: 'ENOENT' });
			expect(serializeError(err)).toMatchObject({ code: 'ENOENT', message: 'nope' });
		});

		it('flattens a cause chain', () => {
			const err = Object.assign(new Error('outer'), { cause: new Error('inner') });
			expect(serializeError(err).cause).toMatchObject({ message: 'inner' });
		});

		it('wraps a primitive and passes a plain object through', () => {
			expect(serializeError('text')).toEqual({ value: 'text' });
			const obj = { a: 1 };
			expect(serializeError(obj)).toBe(obj);
		});
	});

	describe('toLoggableData', () => {
		it('converts a top-level Error', () => {
			expect(toLoggableData(new Error('x'))).toMatchObject({ message: 'x' });
		});

		it('converts an Error held by a plain object key without mutating the input', () => {
			const err = new Error('inner');
			const data = { path: '/a', error: err };
			const out = toLoggableData(data) as Record<string, unknown>;
			expect(out).not.toBe(data);
			expect(out.path).toBe('/a');
			expect(out.error).toMatchObject({ message: 'inner' });
			expect(data.error).toBe(err);
		});

		it('returns data with no Errors by reference', () => {
			const data = { a: 1 };
			expect(toLoggableData(data)).toBe(data);
			const arr = [1, 2];
			expect(toLoggableData(arr)).toBe(arr);
			expect(toLoggableData(undefined)).toBeUndefined();
			expect(toLoggableData('s')).toBe('s');
		});
	});

	describe('ipcErrorMessage', () => {
		it('strips the Electron IPC wrapper and every re-thrown Error: layer', () => {
			const err = new Error(
				'Error invoking remote method \'fs:writeFile\': Error: Failed to write file: Error: Unable to connect to "pedtome" over SSH.'
			);
			expect(ipcErrorMessage(err)).toBe('Unable to connect to "pedtome" over SSH.');
		});

		it('handles a wrapper with no inner Error: prefix', () => {
			expect(
				ipcErrorMessage(
					new Error("Error invoking remote method 'groupChat:create': Invalid moderator agent ID")
				)
			).toBe('Invalid moderator agent ID');
		});

		it('passes a plain message through and falls back when there is none', () => {
			expect(ipcErrorMessage(new Error('plain'))).toBe('plain');
			expect(ipcErrorMessage('as string')).toBe('as string');
			expect(ipcErrorMessage(undefined, 'Could not save file.')).toBe('Could not save file.');
			expect(ipcErrorMessage(new Error(''), 'fallback')).toBe('fallback');
		});
	});
});
