import { describe, expect, it } from 'vitest';

import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';

const gate = () => {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
};

describe('createKeyedWriteQueue', () => {
	it('runs work on one key in order, and different keys at once', async () => {
		const queue = createKeyedWriteQueue();
		const order: string[] = [];
		const first = gate();
		const a1 = queue.enqueue('a', async () => {
			order.push('a1 start');
			await first.promise;
			order.push('a1 end');
		});
		const a2 = queue.enqueue('a', async () => void order.push('a2'));
		const b1 = queue.enqueue('b', async () => void order.push('b1'));

		await b1;
		expect(order).toEqual(['a1 start', 'b1']);
		first.release();
		await Promise.all([a1, a2]);
		expect(order).toEqual(['a1 start', 'b1', 'a1 end', 'a2']);
	});

	describe('idle', () => {
		it('resolves at once when nothing is queued', async () => {
			await expect(createKeyedWriteQueue().idle()).resolves.toBeUndefined();
		});

		it('waits for every key, including work chained behind a running write', async () => {
			const queue = createKeyedWriteQueue();
			const done: string[] = [];
			const slow = gate();
			void queue.enqueue('a', async () => {
				await slow.promise;
				done.push('a1');
			});
			void queue.enqueue('a', async () => void done.push('a2'));
			void queue.enqueue('b', async () => void done.push('b1'));

			let idle = false;
			const waiting = queue.idle().then(() => {
				idle = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(idle).toBe(false);

			slow.release();
			await waiting;
			expect(done.sort()).toEqual(['a1', 'a2', 'b1']);
		});

		it('does not reject when a write failed: the caller of that write already heard', async () => {
			const queue = createKeyedWriteQueue();
			const failed = queue.enqueue('a', async () => {
				throw new Error('disk full');
			});
			await expect(failed).rejects.toThrow('disk full');
			await expect(queue.idle()).resolves.toBeUndefined();
		});
	});
});
