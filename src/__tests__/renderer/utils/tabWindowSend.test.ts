/**
 * Tests for utils/tabWindowSend: what a send from a tab window may not do.
 * Both the tab window (to say why) and the owner (to refuse) run it, so the
 * two cannot disagree.
 */

import { describe, it, expect } from 'vitest';
import {
	APP_WINDOW_ONLY_SLASH_COMMANDS,
	appWindowOnlySlashCommand,
	tabWindowSendRefusal,
} from '../../../renderer/utils/tabWindowSend';
import { createMockAITab } from '../../helpers/mockTab';

describe('appWindowOnlySlashCommand', () => {
	it('matches the built-ins the way processInput intercepts them', () => {
		expect(appWindowOnlySlashCommand(' /history ', 'codex')).toBe('/history');
		expect(appWindowOnlySlashCommand('/wizard', 'codex')).toBe('/wizard');
		expect(appWindowOnlySlashCommand('/wizard plan the launch', 'codex')).toBe('/wizard');
		expect(appWindowOnlySlashCommand('/skills', 'claude-code')).toBe('/skills');
	});

	it('leaves everything else alone', () => {
		expect(appWindowOnlySlashCommand('/wizardry', 'claude-code')).toBeNull();
		expect(appWindowOnlySlashCommand('/history please', 'claude-code')).toBeNull();
		// Only Claude Code lists skills; elsewhere `/skills` is the agent's to answer.
		expect(appWindowOnlySlashCommand('/skills', 'codex')).toBeNull();
		expect(appWindowOnlySlashCommand('show my history', 'claude-code')).toBeNull();
	});

	it('names the same built-ins the tab window leaves out of its picker', () => {
		expect([...APP_WINDOW_ONLY_SLASH_COMMANDS].sort()).toEqual(['/history', '/skills', '/wizard']);
	});
});

describe('tabWindowSendRefusal', () => {
	const tab = createMockAITab({ id: 't' });

	it('allows an ordinary message, a command line, and an image-only send', () => {
		expect(tabWindowSendRefusal(tab, 'hello', 'off', 'claude-code')).toBeNull();
		expect(tabWindowSendRefusal(tab, '/history', 'shell', 'claude-code')).toBeNull();
		expect(tabWindowSendRefusal(tab, '', 'off', 'claude-code')).toBeNull();
	});

	it('refuses a gone tab, a wizard tab, and the app-window built-ins, saying why', () => {
		expect(tabWindowSendRefusal(undefined, 'hi', 'off', 'claude-code')).toMatch(/no longer open/);
		expect(
			tabWindowSendRefusal(
				createMockAITab({ wizardState: { isActive: true } as never }),
				'hi',
				'off',
				'claude-code'
			)
		).toMatch(/planning wizard runs in the main window/);
		expect(tabWindowSendRefusal(tab, '/history', 'off', 'claude-code')).toBe(
			'/history runs in the main window. Dock this tab to use it.'
		);
	});
});
