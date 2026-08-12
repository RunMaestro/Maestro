import { describe, expect, it, vi } from 'vitest';
import { buildMediaPlayerCommands } from '../../../../../renderer/components/QuickActionsModal/commands/mediaPlayerCommands';

function harness(canRestoreFloatingPlayer: boolean) {
	const restoreFloatingPlayer = vi.fn();
	const setQuickActionOpen = vi.fn();
	const actions = buildMediaPlayerCommands({
		canRestoreFloatingPlayer,
		restoreFloatingPlayer,
		setQuickActionOpen,
	});
	return { actions, restoreFloatingPlayer, setQuickActionOpen };
}

describe('buildMediaPlayerCommands', () => {
	it('offers nothing when there is no hidden player to restore', () => {
		// Keeps the palette free of a dead entry for users who never open media.
		expect(harness(false).actions).toEqual([]);
	});

	it('offers the restore command when a player is hidden', () => {
		const { actions } = harness(true);
		expect(actions).toHaveLength(1);
		expect(actions[0].id).toBe('show-floating-media-player');
		expect(actions[0].label).toBe('Show Floating Media Player');
	});

	it('restores the widget and closes the palette', () => {
		const { actions, restoreFloatingPlayer, setQuickActionOpen } = harness(true);
		actions[0].action();
		expect(restoreFloatingPlayer).toHaveBeenCalledOnce();
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('is findable by searching for "media"', () => {
		// The label has to contain the word users would type; this pins it against
		// a rename that would make the command unreachable.
		expect(harness(true).actions[0].label.toLowerCase()).toContain('media');
	});
});
