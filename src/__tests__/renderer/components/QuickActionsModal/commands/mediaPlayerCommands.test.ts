import { describe, expect, it, vi } from 'vitest';
import { buildMediaPlayerCommands } from '../../../../../renderer/components/QuickActionsModal/commands/mediaPlayerCommands';

function harness(canRestoreFloatingPlayer: boolean, canOpenMediaPlayer = true) {
	const restoreFloatingPlayer = vi.fn();
	const openMediaPlayer = vi.fn();
	const setQuickActionOpen = vi.fn();
	const actions = buildMediaPlayerCommands({
		canRestoreFloatingPlayer,
		restoreFloatingPlayer,
		canOpenMediaPlayer,
		openMediaPlayer,
		setQuickActionOpen,
	});
	return { actions, restoreFloatingPlayer, openMediaPlayer, setQuickActionOpen };
}

const byId = (actions: ReturnType<typeof harness>['actions'], id: string) =>
	actions.find((a) => a.id === id);

describe('buildMediaPlayerCommands', () => {
	it('always offers Open Media Player, even with nothing loaded', () => {
		// Deliberately NOT hidden when idle. A palette that omits the command
		// teaches the user the feature does not exist; the subtext explains
		// instead. Same lesson as the inline Force Send button.
		const open = byId(harness(false, false).actions, 'open-media-player');
		expect(open).toBeDefined();
		expect(open!.subtext).toMatch(/Nothing has been played yet/i);
	});

	it('promises to open the player when there is something to play', () => {
		const open = byId(harness(false, true).actions, 'open-media-player');
		expect(open!.subtext).toMatch(/floating player/i);
	});

	it('opens the player and closes the palette', () => {
		const h = harness(false, true);
		byId(h.actions, 'open-media-player')!.action();
		expect(h.openMediaPlayer).toHaveBeenCalledOnce();
		expect(h.setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('does not try to open anything when there is nothing to play', () => {
		const h = harness(false, false);
		byId(h.actions, 'open-media-player')!.action();
		expect(h.openMediaPlayer).not.toHaveBeenCalled();
		// Still dismisses the palette - the click was acknowledged.
		expect(h.setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('omits the restore command when no player is hidden', () => {
		// Restore stays conditional: it is a recovery action, meaningless unless
		// a loaded player was actually dismissed.
		expect(byId(harness(false).actions, 'show-floating-media-player')).toBeUndefined();
	});

	it('offers the restore command when a player is hidden', () => {
		expect(byId(harness(true).actions, 'show-floating-media-player')?.label).toBe(
			'Show Floating Media Player'
		);
	});

	it('restores the widget and closes the palette', () => {
		const h = harness(true);
		byId(h.actions, 'show-floating-media-player')!.action();
		expect(h.restoreFloatingPlayer).toHaveBeenCalledOnce();
		expect(h.setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('is findable by searching for "media"', () => {
		// The labels have to contain the word users would type; this pins them
		// against a rename that would make the commands unreachable.
		for (const action of harness(true).actions) {
			expect(action.label.toLowerCase()).toContain('media');
		}
	});
});
