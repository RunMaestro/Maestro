import { describe, expect, it, vi } from 'vitest';
import { createProcessRegistry, type RegisteredTurn } from '../processes';

function fakeTurn() {
	let finish!: () => void;
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const turn: RegisteredTurn & { finish(): void } = {
		interrupt: vi.fn(),
		terminate: vi.fn(),
		terminateNow: vi.fn(),
		done,
		finish,
	};
	return turn;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('process registry', () => {
	it('is idle until a turn registers, then busy per agent and per tab', () => {
		const registry = createProcessRegistry();
		expect(registry.isBusy('a1')).toBe(false);
		registry.register('a1', 't1', fakeTurn());
		expect(registry.isBusy('a1')).toBe(true);
		expect(registry.isBusy('a1', 't1')).toBe(true);
		expect(registry.isBusy('a1', 't2')).toBe(false);
		expect(registry.isBusy('a2')).toBe(false);
		expect(registry.size()).toBe(1);
	});

	it('forgets a turn when it ends', async () => {
		const registry = createProcessRegistry();
		const turn = fakeTurn();
		registry.register('a1', 't1', turn);
		turn.finish();
		await flush();
		expect(registry.isBusy('a1')).toBe(false);
		expect(registry.size()).toBe(0);
	});

	it('interrupts one tab only, and reports whether anything ran', async () => {
		const registry = createProcessRegistry();
		const first = fakeTurn();
		const other = fakeTurn();
		registry.register('a1', 't1', first);
		registry.register('a1', 't2', other);
		const stopping = registry.interruptTab('a1', 't1');
		first.finish();
		expect(await stopping).toBe(true);
		expect(first.interrupt).toHaveBeenCalledTimes(1);
		expect(other.interrupt).not.toHaveBeenCalled();
		expect(await registry.interruptTab('a1', 'nothing')).toBe(false);
	});

	it('stops a tab at terminate, not at interrupt', async () => {
		const registry = createProcessRegistry();
		const turn = fakeTurn();
		registry.register('a1', 't1', turn);
		const stopping = registry.stopTab('a1', 't1');
		turn.finish();
		await stopping;
		expect(turn.terminate).toHaveBeenCalledTimes(1);
		expect(turn.interrupt).not.toHaveBeenCalled();
	});

	it('stops every tab of one agent and leaves other agents alone', async () => {
		const registry = createProcessRegistry();
		const a = fakeTurn();
		const b = fakeTurn();
		const other = fakeTurn();
		registry.register('a1', 't1', a);
		registry.register('a1', 't2', b);
		registry.register('a2', 't1', other);
		const stopping = registry.stopAgent('a1');
		a.finish();
		b.finish();
		await stopping;
		expect(a.terminate).toHaveBeenCalled();
		expect(b.terminate).toHaveBeenCalled();
		expect(other.terminate).not.toHaveBeenCalled();
	});

	it('stopAll reaches every agent', async () => {
		const registry = createProcessRegistry();
		const turns = [fakeTurn(), fakeTurn()];
		registry.register('a1', 't1', turns[0]);
		registry.register('a2', 't1', turns[1]);
		const stopping = registry.stopAll();
		for (const turn of turns) turn.finish();
		await stopping;
		for (const turn of turns) expect(turn.terminate).toHaveBeenCalled();
	});

	it('gives up waiting for a turn that never ends, instead of hanging a shutdown', async () => {
		const registry = createProcessRegistry({ waitMs: 10 });
		registry.register('a1', 't1', fakeTurn());
		await expect(registry.stopAll()).resolves.toBeUndefined();
	});

	it('keeps stopping the others when one stop throws', async () => {
		const registry = createProcessRegistry({ waitMs: 10 });
		const broken = fakeTurn();
		vi.mocked(broken.terminate).mockImplementation(() => {
			throw new Error('already gone');
		});
		const fine = fakeTurn();
		registry.register('a1', 't1', broken);
		registry.register('a1', 't2', fine);
		await registry.stopAgent('a1');
		expect(fine.terminate).toHaveBeenCalled();
	});

	it('terminateAllNow swallows a failing handle and reaches the rest', () => {
		const registry = createProcessRegistry();
		const broken = fakeTurn();
		vi.mocked(broken.terminateNow).mockImplementation(() => {
			throw new Error('gone');
		});
		const fine = fakeTurn();
		registry.register('a1', 't1', broken);
		registry.register('a1', 't2', fine);
		expect(() => registry.terminateAllNow()).not.toThrow();
		expect(fine.terminateNow).toHaveBeenCalled();
	});
});
