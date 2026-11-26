import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	registerMaestroBuiltinCommandHandlers,
	runMaestroBuiltinCommand,
} from '../../../renderer/services/maestroBuiltinCommands';
import { registerSessionPersistenceFlush } from '../../../renderer/services/sessionPersistenceFlush';

const target = { sessionId: 'agent-1', tabId: 'tab-2' };

describe('runMaestroBuiltinCommand', () => {
	afterEach(() => registerMaestroBuiltinCommandHandlers(null));

	it('runs /history and /skills for the named tab', () => {
		const history = vi.fn().mockResolvedValue(undefined);
		const skills = vi.fn().mockResolvedValue(undefined);
		registerMaestroBuiltinCommandHandlers({ history, skills });

		expect(runMaestroBuiltinCommand({ name: '/history' }, target)).toBe(true);
		expect(runMaestroBuiltinCommand({ name: '/skills' }, target)).toBe(true);
		expect(history).toHaveBeenCalledExactlyOnceWith(target);
		expect(skills).toHaveBeenCalledExactlyOnceWith(target);
	});

	it('does not run what needs the composer, or anything before App registers', () => {
		expect(runMaestroBuiltinCommand({ name: '/history' }, target)).toBe(false);
		const history = vi.fn().mockResolvedValue(undefined);
		const skills = vi.fn().mockResolvedValue(undefined);
		registerMaestroBuiltinCommandHandlers({ history, skills });
		expect(runMaestroBuiltinCommand({ name: '/wizard', args: '' }, target)).toBe(false);
		expect(runMaestroBuiltinCommand({ name: '/btw', question: 'why?' }, target)).toBe(false);
		expect(history).not.toHaveBeenCalled();
		expect(skills).not.toHaveBeenCalled();
	});

	describe('a desktop host tells its Federation clients (M13)', () => {
		const process$ = () => window.maestro.process as unknown as Record<string, unknown>;
		let broadcast: ReturnType<typeof vi.fn>;
		const order: string[] = [];

		afterEach(() => {
			registerSessionPersistenceFlush(null);
			delete process$().broadcastTranscriptChanged;
			order.length = 0;
		});

		it('flushes the tab to disk, then broadcasts, at the start and again when the command ends', async () => {
			broadcast = vi.fn(async () => {
				order.push('broadcast');
			});
			process$().broadcastTranscriptChanged = broadcast;
			registerSessionPersistenceFlush(async () => {
				order.push('flush');
			});
			let finish!: () => void;
			const skills = vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finish = resolve;
					})
			);
			registerMaestroBuiltinCommandHandlers({ history: vi.fn(), skills });

			expect(runMaestroBuiltinCommand({ name: '/skills' }, target)).toBe(true);
			await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(1));
			expect(broadcast).toHaveBeenCalledWith('agent-1', 'tab-2');

			finish();
			await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(2));
			expect(order).toEqual(['flush', 'broadcast', 'flush', 'broadcast']);
		});

		it('still broadcasts when the command fails, and never throws when the flush does', async () => {
			broadcast = vi.fn().mockResolvedValue(undefined);
			process$().broadcastTranscriptChanged = broadcast;
			const history = vi.fn().mockRejectedValue(new Error('boom'));
			registerMaestroBuiltinCommandHandlers({ history, skills: vi.fn() });
			expect(runMaestroBuiltinCommand({ name: '/history' }, target)).toBe(true);
			await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(2));

			registerSessionPersistenceFlush(() => Promise.reject(new Error('disk full')));
			expect(runMaestroBuiltinCommand({ name: '/history' }, target)).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(broadcast).toHaveBeenCalledTimes(2);
		});
	});
});
