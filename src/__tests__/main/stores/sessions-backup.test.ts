/**
 * Tests for the session registry backup guard. The writer is mocked so the
 * suite cannot touch the real user data directory.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/utils/atomic-json-store', () => ({
	atomicWriteJson: vi.fn().mockResolvedValue(undefined),
}));

import {
	backupSessionsBeforeWipe,
	SESSIONS_BACKUP_FILENAME,
} from '../../../main/stores/sessions-backup';
import { atomicWriteJson } from '../../../main/utils/atomic-json-store';
import type { StoredSession } from '../../../main/stores/types';

const mockWrite = atomicWriteJson as unknown as ReturnType<typeof vi.fn>;
const STORE_PATH = '/tmp/maestro-test/maestro-sessions.json';

function makeSession(id: string): StoredSession {
	return { id, name: `Agent ${id}`, toolType: 'claude-code', cwd: '/tmp' } as StoredSession;
}

describe('backupSessionsBeforeWipe', () => {
	beforeEach(() => {
		mockWrite.mockClear();
		mockWrite.mockResolvedValue(undefined);
	});

	it('backs up the stored tree when an empty one replaces it', async () => {
		const stored = [makeSession('a'), makeSession('b')];

		await backupSessionsBeforeWipe(stored, [], STORE_PATH);

		expect(mockWrite).toHaveBeenCalledTimes(1);
		const [writtenPath, payload] = mockWrite.mock.calls[0];
		expect(writtenPath).toBe(path.join(path.dirname(STORE_PATH), SESSIONS_BACKUP_FILENAME));
		expect((payload as { entries: StoredSession[] }).entries).toEqual(stored);
	});

	it('does not back up when the incoming tree still has agents', async () => {
		await backupSessionsBeforeWipe([makeSession('a')], [makeSession('a')], STORE_PATH);
		expect(mockWrite).not.toHaveBeenCalled();
	});

	it('does not back up when there was nothing stored to lose', async () => {
		await backupSessionsBeforeWipe([], [], STORE_PATH);
		expect(mockWrite).not.toHaveBeenCalled();
	});

	it('does not throw when the backup write fails', async () => {
		mockWrite.mockRejectedValueOnce(new Error('disk full'));
		await expect(
			backupSessionsBeforeWipe([makeSession('a')], [], STORE_PATH)
		).resolves.toBeUndefined();
	});
});
