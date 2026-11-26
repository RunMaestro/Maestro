import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	registerMaestroBuiltinCommandHandlers,
	runMaestroBuiltinCommand,
} from '../../../renderer/services/maestroBuiltinCommands';

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
});
