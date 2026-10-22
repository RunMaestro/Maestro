/**
 * countTokens() counts in a Web Worker so building the cl100k encoder (~100ms)
 * and encoding a long document never block the UI thread. jsdom has no Worker,
 * so these install a fake one. The module keeps its worker for the session, so
 * each test re-imports it fresh.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type Listener = ((event: { data: unknown }) => void) | null;

class FakeWorker {
	static instances: FakeWorker[] = [];
	onmessage: Listener = null;
	onerror: ((event: { message: string; preventDefault: () => void }) => void) | null = null;
	posted: Array<{ id: number; text: string }> = [];
	terminated = false;
	constructor() {
		FakeWorker.instances.push(this);
	}
	postMessage(message: { id: number; text: string }): void {
		this.posted.push(message);
	}
	terminate(): void {
		this.terminated = true;
	}
}

async function loadCounter() {
	vi.resetModules();
	return import('../../../renderer/utils/tokenCounter');
}

afterEach(() => {
	vi.unstubAllGlobals();
	FakeWorker.instances = [];
});

describe('countTokens off the UI thread', () => {
	it('counts in the worker and reuses one worker', async () => {
		vi.stubGlobal('Worker', FakeWorker);
		const { countTokens } = await loadCounter();

		const first = countTokens('hello');
		const second = countTokens('hello world');
		const worker = FakeWorker.instances[0];
		expect(FakeWorker.instances).toHaveLength(1);
		expect(worker.posted.map((message) => message.text)).toEqual(['hello', 'hello world']);

		worker.onmessage?.({ data: { id: worker.posted[1].id, count: 2 } });
		worker.onmessage?.({ data: { id: worker.posted[0].id, count: 1 } });

		await expect(first).resolves.toBe(1);
		await expect(second).resolves.toBe(2);
	});

	it('falls back to counting on the UI thread when the worker fails', async () => {
		vi.stubGlobal('Worker', FakeWorker);
		const { countTokens } = await loadCounter();

		const pending = countTokens('hello');
		const worker = FakeWorker.instances[0];
		worker.onerror?.({ message: 'failed to load', preventDefault: () => undefined });

		await expect(pending).resolves.toBe(1);
		expect(worker.terminated).toBe(true);
		// Once failed, later counts stay on the UI thread rather than respawning.
		await expect(countTokens('hello')).resolves.toBe(1);
		expect(FakeWorker.instances).toHaveLength(1);
	});
});
