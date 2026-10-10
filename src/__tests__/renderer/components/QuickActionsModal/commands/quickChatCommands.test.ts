import { describe, expect, it, vi } from 'vitest';
import { buildQuickChatCommands } from '../../../../../renderer/components/QuickActionsModal/commands/quickChatCommands';

function build(overrides: Partial<Parameters<typeof buildQuickChatCommands>[0]> = {}) {
	return buildQuickChatCommands({
		quickChatAvailable: true,
		hotkey: ['Alt', 'Space'],
		openQuickChat: vi.fn(),
		setQuickActionOpen: vi.fn(),
		...overrides,
	});
}

describe('buildQuickChatCommands', () => {
	it('offers nothing when Quick Chat is unavailable', () => {
		expect(build({ quickChatAvailable: false })).toEqual([]);
	});

	it('shows the hotkey from the Quick Chat settings', () => {
		const [command] = build({ hotkey: ['Meta', 'Shift', 'K'] });
		expect(command.id).toBe('open-quick-chat');
		expect(command.shortcut?.keys).toEqual(['Meta', 'Shift', 'K']);
	});

	it('shows no chord when the hotkey is unbound', () => {
		const [command] = build({ hotkey: [] });
		expect(command.shortcut).toBeUndefined();
	});

	it('opens the window and closes the palette', () => {
		const openQuickChat = vi.fn();
		const setQuickActionOpen = vi.fn();
		const [command] = build({ openQuickChat, setQuickActionOpen });
		command.action();
		expect(openQuickChat).toHaveBeenCalledTimes(1);
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
	});
});
