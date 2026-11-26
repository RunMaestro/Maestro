import { describe, expect, it } from 'vitest';
import { parseMaestroBuiltinCommand } from '../../shared/maestroBuiltinCommands';

describe('parseMaestroBuiltinCommand', () => {
	it('names /history and /wizard for any provider', () => {
		for (const toolType of ['claude-code', 'codex', 'opencode']) {
			expect(parseMaestroBuiltinCommand('  /history ', toolType)).toEqual({ name: '/history' });
			expect(parseMaestroBuiltinCommand('/wizard', toolType)).toEqual({
				name: '/wizard',
				args: '',
			});
			expect(parseMaestroBuiltinCommand('/wizard  plan the release', toolType)).toEqual({
				name: '/wizard',
				args: 'plan the release',
			});
		}
	});

	it('names /skills and /btw for Claude Code only', () => {
		expect(parseMaestroBuiltinCommand('/skills', 'claude-code')).toEqual({ name: '/skills' });
		expect(parseMaestroBuiltinCommand('/btw what changed?', 'claude-code')).toEqual({
			name: '/btw',
			question: 'what changed?',
		});
		expect(parseMaestroBuiltinCommand('/btw', 'claude-code')).toEqual({
			name: '/btw',
			question: '',
		});
		expect(parseMaestroBuiltinCommand('/skills', 'codex')).toBeNull();
		expect(parseMaestroBuiltinCommand('/btw why?', 'codex')).toBeNull();
	});

	it('leaves messages and other commands alone', () => {
		for (const text of ['hello', '/historyx', '/wizardry', '/compact', 'run /history', '']) {
			expect(parseMaestroBuiltinCommand(text, 'claude-code')).toBeNull();
		}
	});
});
