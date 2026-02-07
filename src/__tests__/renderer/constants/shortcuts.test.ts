import { describe, expect, it } from 'vitest';
import { TERMINAL_TAB_SHORTCUTS } from '../../../renderer/constants/shortcuts';

describe('TERMINAL_TAB_SHORTCUTS', () => {
	it('defines expected terminal shortcut IDs', () => {
		expect(Object.keys(TERMINAL_TAB_SHORTCUTS)).toEqual(['newTerminalTab', 'clearTerminal']);
	});

	it('uses Ctrl+Shift+` for new terminal tab', () => {
		expect(TERMINAL_TAB_SHORTCUTS.newTerminalTab).toEqual({
			id: 'newTerminalTab',
			label: 'New Terminal Tab',
			keys: ['Control', 'Shift', '`'],
		});
	});

	it('uses Cmd+K for clear terminal', () => {
		expect(TERMINAL_TAB_SHORTCUTS.clearTerminal).toEqual({
			id: 'clearTerminal',
			label: 'Clear Terminal',
			keys: ['Meta', 'k'],
		});
	});
});
