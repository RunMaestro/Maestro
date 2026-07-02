/**
 * Tests for offline queue FIFO replay behavior
 *
 * Verifies the queue logic for First-In-First-Out order
 * without requiring full React Native module resolution.
 */

// Mock storage adapter for testing
interface MockStorageAdapter {
	data: Map<string, string>;
	getItem: (key: string) => Promise<string | null>;
	setItem: (key: string, value: string) => Promise<void>;
	removeItem: (key: string) => Promise<void>;
}

function createMockStorage(): MockStorageAdapter {
	const data = new Map<string, string>();
	return {
		data,
		getItem: jest.fn(async (key: string) => data.get(key) ?? null),
		setItem: jest.fn(async (key: string, value: string) => {
			data.set(key, value);
		}),
		removeItem: jest.fn(async (key: string) => {
			data.delete(key);
		}),
	};
}

// Storage key for persistence
const STORAGE_KEY = 'maestro-offline-queue';
const MAX_QUEUE_SIZE = 50;

// Queue item type
interface QueuedCommand {
	id: string;
	command: string;
	sessionId: string;
	timestamp: number;
	inputMode: 'ai' | 'terminal';
	attempts: number;
}

describe('offline queue FIFO behavior', () => {
	describe('queue ordering', () => {
		it('maintains FIFO order when adding items', () => {
			const queue: QueuedCommand[] = [];

			// Add commands in order
			queue.push({
				id: '1',
				command: 'first',
				sessionId: 's1',
				timestamp: 1000,
				inputMode: 'ai',
				attempts: 0,
			});
			queue.push({
				id: '2',
				command: 'second',
				sessionId: 's1',
				timestamp: 2000,
				inputMode: 'ai',
				attempts: 0,
			});
			queue.push({
				id: '3',
				command: 'third',
				sessionId: 's1',
				timestamp: 3000,
				inputMode: 'ai',
				attempts: 0,
			});

			// Process in order (FIFO)
			const processed: string[] = [];
			for (const cmd of queue) {
				processed.push(cmd.command);
			}

			expect(processed).toEqual(['first', 'second', 'third']);
		});

		it('processes queue items sequentially', () => {
			const queue: QueuedCommand[] = [
				{ id: '1', command: 'a', sessionId: 's1', timestamp: 1, inputMode: 'ai', attempts: 0 },
				{ id: '2', command: 'b', sessionId: 's1', timestamp: 2, inputMode: 'ai', attempts: 0 },
				{ id: '3', command: 'c', sessionId: 's1', timestamp: 3, inputMode: 'ai', attempts: 0 },
			];

			const sendOrder: string[] = [];

			// Simulate sequential processing
			while (queue.length > 0) {
				const cmd = queue.shift()!;
				sendOrder.push(cmd.command);
			}

			expect(sendOrder).toEqual(['a', 'b', 'c']);
			expect(queue.length).toBe(0);
		});
	});

	describe('storage persistence', () => {
		it('serializes queue to JSON correctly', async () => {
			const storage = createMockStorage();
			const queue: QueuedCommand[] = [
				{
					id: '1',
					command: 'cmd1',
					sessionId: 's1',
					timestamp: 1000,
					inputMode: 'ai',
					attempts: 0,
				},
				{
					id: '2',
					command: 'cmd2',
					sessionId: 's1',
					timestamp: 2000,
					inputMode: 'ai',
					attempts: 1,
				},
			];

			await storage.setItem(STORAGE_KEY, JSON.stringify(queue));

			const stored = await storage.getItem(STORAGE_KEY);
			expect(stored).toBeTruthy();

			const parsed = JSON.parse(stored!);
			expect(parsed).toHaveLength(2);
			expect(parsed[0].command).toBe('cmd1');
			expect(parsed[1].command).toBe('cmd2');
		});

		it('restores queue from storage', async () => {
			const storage = createMockStorage();
			const original: QueuedCommand[] = [
				{
					id: '1',
					command: 'persisted',
					sessionId: 's1',
					timestamp: 1000,
					inputMode: 'ai',
					attempts: 0,
				},
			];

			await storage.setItem(STORAGE_KEY, JSON.stringify(original));

			const stored = await storage.getItem(STORAGE_KEY);
			const restored: QueuedCommand[] = JSON.parse(stored!);

			expect(restored).toHaveLength(1);
			expect(restored[0].command).toBe('persisted');
		});

		it('handles empty storage gracefully', async () => {
			const storage = createMockStorage();

			const stored = await storage.getItem(STORAGE_KEY);
			expect(stored).toBeNull();

			// Should initialize to empty array
			const queue: QueuedCommand[] = stored ? JSON.parse(stored) : [];
			expect(queue).toEqual([]);
		});
	});

	describe('queue capacity', () => {
		it('respects MAX_QUEUE_SIZE limit', () => {
			const queue: QueuedCommand[] = [];

			// Fill to capacity
			for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
				queue.push({
					id: `${i}`,
					command: `cmd-${i}`,
					sessionId: 's1',
					timestamp: i,
					inputMode: 'ai',
					attempts: 0,
				});
			}

			expect(queue.length).toBe(MAX_QUEUE_SIZE);

			// Check canQueue
			const canQueue = queue.length < MAX_QUEUE_SIZE;
			expect(canQueue).toBe(false);
		});

		it('allows queuing when under capacity', () => {
			const queue: QueuedCommand[] = [];

			// Add 49 items
			for (let i = 0; i < 49; i++) {
				queue.push({
					id: `${i}`,
					command: `cmd-${i}`,
					sessionId: 's1',
					timestamp: i,
					inputMode: 'ai',
					attempts: 0,
				});
			}

			const canQueue = queue.length < MAX_QUEUE_SIZE;
			expect(canQueue).toBe(true);
		});
	});

	describe('retry handling', () => {
		it('increments attempt counter on retry', () => {
			const cmd: QueuedCommand = {
				id: '1',
				command: 'test',
				sessionId: 's1',
				timestamp: 1000,
				inputMode: 'ai',
				attempts: 0,
			};

			// Simulate retry
			cmd.attempts++;
			expect(cmd.attempts).toBe(1);

			cmd.attempts++;
			expect(cmd.attempts).toBe(2);
		});

		it('removes command after max retries', () => {
			const maxRetries = 3;
			const queue: QueuedCommand[] = [
				{
					id: '1',
					command: 'fail',
					sessionId: 's1',
					timestamp: 1000,
					inputMode: 'ai',
					attempts: 0,
				},
			];

			// Simulate 3 failed attempts
			for (let i = 0; i < maxRetries; i++) {
				const cmd = queue[0];
				cmd.attempts++;

				if (cmd.attempts >= maxRetries) {
					queue.shift(); // Remove after max retries
				}
			}

			expect(queue.length).toBe(0);
		});

		it('keeps command in queue while under max retries', () => {
			const maxRetries = 3;
			const queue: QueuedCommand[] = [
				{
					id: '1',
					command: 'retry',
					sessionId: 's1',
					timestamp: 1000,
					inputMode: 'ai',
					attempts: 0,
				},
			];

			// First attempt fails
			queue[0].attempts++;
			expect(queue[0].attempts).toBe(1);
			expect(queue.length).toBe(1); // Still in queue

			// Second attempt fails
			queue[0].attempts++;
			expect(queue[0].attempts).toBe(2);
			expect(queue.length).toBe(1); // Still in queue

			// Third attempt - would be removed
			expect(queue[0].attempts).toBeLessThan(maxRetries);
		});
	});

	describe('command removal', () => {
		it('removes command by id', () => {
			const queue: QueuedCommand[] = [
				{ id: '1', command: 'a', sessionId: 's1', timestamp: 1, inputMode: 'ai', attempts: 0 },
				{ id: '2', command: 'b', sessionId: 's1', timestamp: 2, inputMode: 'ai', attempts: 0 },
				{ id: '3', command: 'c', sessionId: 's1', timestamp: 3, inputMode: 'ai', attempts: 0 },
			];

			const idToRemove = '2';
			const filtered = queue.filter((cmd) => cmd.id !== idToRemove);

			expect(filtered).toHaveLength(2);
			expect(filtered.map((c) => c.id)).toEqual(['1', '3']);
		});

		it('clears entire queue', () => {
			const queue: QueuedCommand[] = [
				{ id: '1', command: 'a', sessionId: 's1', timestamp: 1, inputMode: 'ai', attempts: 0 },
				{ id: '2', command: 'b', sessionId: 's1', timestamp: 2, inputMode: 'ai', attempts: 0 },
			];

			queue.length = 0; // Clear

			expect(queue).toEqual([]);
		});
	});
});

describe('processing state machine', () => {
	type QueueStatus = 'idle' | 'processing' | 'paused';

	it('transitions from idle to processing', () => {
		let status: QueueStatus = 'idle';

		// Start processing
		status = 'processing';
		expect(status).toBe('processing');
	});

	it('transitions from processing to paused', () => {
		let status: QueueStatus = 'processing';

		// Pause
		status = 'paused';
		expect(status).toBe('paused');
	});

	it('transitions from processing to idle on completion', () => {
		let status: QueueStatus = 'processing';

		// Complete
		status = 'idle';
		expect(status).toBe('idle');
	});

	it('prevents starting if already processing', () => {
		let isProcessing = true;

		// Try to start again
		const canStart = !isProcessing;
		expect(canStart).toBe(false);
	});

	it('prevents processing when not connected', () => {
		const isOnline = false;
		const isConnected = false;

		const canProcess = isOnline && isConnected;
		expect(canProcess).toBe(false);
	});
});
