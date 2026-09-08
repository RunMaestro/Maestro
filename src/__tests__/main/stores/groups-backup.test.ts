/**
 * Tests for the group registry backup guard.
 *
 * Emptying `maestro-groups.json` is unrecoverable: the rows carry every group's
 * name, emoji and collapsed state, agents only reference them by `groupId`, and
 * nothing else on disk holds a second copy. This guard keeps the outgoing
 * registry before an empty one replaces it.
 *
 * The writer is mocked rather than pointed at a temp dir so the suite cannot
 * touch the real user data directory under any circumstance.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/utils/atomic-json-store', () => ({
	atomicWriteJson: vi.fn().mockResolvedValue(undefined),
}));

import {
	backupGroupsBeforeWipe,
	GROUPS_BACKUP_FILENAME,
	type GroupsBackupStore,
} from '../../../main/stores/groups-backup';
import { atomicWriteJson } from '../../../main/utils/atomic-json-store';
import type { Group } from '../../../shared/types';

const mockWrite = atomicWriteJson as unknown as ReturnType<typeof vi.fn>;

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
		expect((payload as { groups: Group[] }).groups).toEqual(stored);
		expect((payload as { reason: string }).reason).toBe('group-registry-emptied');
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
		await expect(backupGroupsBeforeWipe(makeStore([makeGroup('g1')]), [])).resolves.toBeUndefined();
	});
});
