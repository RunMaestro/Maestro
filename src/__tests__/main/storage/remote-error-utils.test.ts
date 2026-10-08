import { describe, it, expect } from 'vitest';
import { isExpectedRemoteError } from '../../../main/storage/remote-error-utils';

describe('isExpectedRemoteError', () => {
	it('returns false for empty or missing errors', () => {
		expect(isExpectedRemoteError()).toBe(false);
		expect(isExpectedRemoteError('')).toBe(false);
	});

	it('matches benign not-found and permission phrases', () => {
		expect(isExpectedRemoteError('File not found')).toBe(true);
		expect(isExpectedRemoteError('path not accessible')).toBe(true);
		expect(isExpectedRemoteError('No such file or directory')).toBe(true);
		expect(isExpectedRemoteError('Permission denied')).toBe(true);
		expect(isExpectedRemoteError('Directory does not exist')).toBe(true);
	});

	it('does not match unexpected remote failures', () => {
		expect(isExpectedRemoteError('Connection timed out')).toBe(false);
		expect(isExpectedRemoteError('Host key verification failed')).toBe(false);
	});
});
