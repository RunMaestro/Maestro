import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	flushSessionPersistenceNow,
	registerSessionPersistenceFlush,
} from '../../../renderer/services/sessionPersistenceFlush';
import type { Session } from '../../../renderer/types';

describe('sessionPersistenceFlush', () => {
	afterEach(() => registerSessionPersistenceFlush(null));

	it('resolves at once when nothing is registered', async () => {
		await expect(flushSessionPersistenceNow()).resolves.toBeUndefined();
	});

	it('hands the snapshot to the registered flush and waits for it', async () => {
		let release!: () => void;
		const flush = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
		registerSessionPersistenceFlush(flush);
		const sessions = [{ id: 'a' }] as Session[];

		let done = false;
		const pending = flushSessionPersistenceNow(sessions).then(() => {
			done = true;
		});
		await Promise.resolve();

		expect(flush).toHaveBeenCalledWith(sessions);
		expect(done).toBe(false);
		release();
		await pending;
		expect(done).toBe(true);
	});
});
