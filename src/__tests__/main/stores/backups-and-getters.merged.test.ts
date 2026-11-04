// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/main/stores/groups-backup.test.ts
// Source: src/__tests__/main/stores/sessions-backup.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	backupGroupsBeforeWipe,
	GROUPS_BACKUP_FILENAME,
	type GroupsBackupStore,
} from '../../../main/stores/groups-backup';
import { atomicWriteJson as s1_atomicWriteJson } from '../../../shared/maestro-lib/store/atomic-write';
import type { Group } from '../../../shared/types';
import path from 'node:path';
import {
	backupSessionsBeforeWipe,
	SESSIONS_BACKUP_FILENAME,
} from '../../../main/stores/sessions-backup';
import { atomicWriteJson as s2_atomicWriteJson } from '../../../shared/maestro-lib/store/atomic-write';
import type { StoredSession } from '../../../main/stores/types';
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../shared/maestro-lib/store/atomic-write', () => ({
	atomicWriteJson: vi.fn().mockResolvedValue(undefined),
}));
// Source: src/__tests__/main/stores/groups-backup.test.ts
describe('', () => {
	const mockWrite = s1_atomicWriteJson as unknown as ReturnType<typeof vi.fn>;
	function makeGroup(id: string): Group {
		return { id, name: `Group ${id}`, emoji: '', collapsed: false } as Group;
	}
	function makeStore(stored: Group[] | (() => never)): GroupsBackupStore {
		return {
			get: typeof stored === 'function' ? (stored as () => never) : () => stored,
			path: '/tmp/maestro-test/maestro-groups.json',
		};
	}
	describe('backupGroupsBeforeWipe', () => {
		beforeEach(() => {
			mockWrite.mockClear();
			mockWrite.mockResolvedValue(undefined);
		});
		it('backs up the stored registry when an empty one replaces it', async () => {
			const stored = [makeGroup('g1'), makeGroup('g2')];
			await backupGroupsBeforeWipe(makeStore(stored), []);
			expect(mockWrite).toHaveBeenCalledTimes(1);
			const [writtenPath, payload] = mockWrite.mock.calls[0];
			expect(writtenPath).toContain(GROUPS_BACKUP_FILENAME);
			expect(
				(
					payload as {
						entries: Group[];
					}
				).entries
			).toEqual(stored);
			expect(
				(
					payload as {
						reason: string;
					}
				).reason
			).toBe('registry-emptied');
		});
		it('does not back up when the incoming registry still has groups', async () => {
			await backupGroupsBeforeWipe(makeStore([makeGroup('g1')]), [makeGroup('g1')]);
			expect(mockWrite).not.toHaveBeenCalled();
		});
		it('does not back up when there was nothing stored to lose', async () => {
			await backupGroupsBeforeWipe(makeStore([]), []);
			expect(mockWrite).not.toHaveBeenCalled();
		});
		it('treats a null incoming registry as a wipe', async () => {
			await backupGroupsBeforeWipe(makeStore([makeGroup('g1')]), null);
			expect(mockWrite).toHaveBeenCalledTimes(1);
		});
		it('does not throw when the store cannot be read', async () => {
			const store = makeStore((() => {
				throw new Error('corrupt registry');
			}) as () => never);
			await expect(backupGroupsBeforeWipe(store, [])).resolves.toBeUndefined();
			expect(mockWrite).not.toHaveBeenCalled();
		});
		it('does not throw when the backup write fails', async () => {
			mockWrite.mockRejectedValueOnce(new Error('disk full'));
			// A snapshot that cannot be written must not stop the user's actual
			// change from being saved.
			await expect(
				backupGroupsBeforeWipe(makeStore([makeGroup('g1')]), [])
			).resolves.toBeUndefined();
		});
	});
});
// Source: src/__tests__/main/stores/sessions-backup.test.ts
describe('', () => {
	const mockWrite = s2_atomicWriteJson as unknown as ReturnType<typeof vi.fn>;
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
			expect(
				(
					payload as {
						entries: StoredSession[];
					}
				).entries
			).toEqual(stored);
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
});
