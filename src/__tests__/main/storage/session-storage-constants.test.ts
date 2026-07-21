import { describe, expect, it } from 'vitest';
import { MAX_SESSION_FILE_SIZE } from '../../../main/storage/session-storage-constants';

describe('session storage limits', () => {
	it('uses the shared 100 MiB limit for provider transcript reads', () => {
		expect(MAX_SESSION_FILE_SIZE).toBe(100 * 1024 * 1024);
	});
});
