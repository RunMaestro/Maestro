import { describe, expect, it, vi } from 'vitest';
import { buildMediaPlayerCommands } from '../../../../../renderer/components/QuickActionsModal/commands/mediaPlayerCommands';

function harness(canOpenMediaPlayer = true) {
	const openMediaPlayer = vi.fn();
	const setQuickActionOpen = vi.fn();
	const actions = buildMediaPlayerCommands({
		canOpenMediaPlayer,
		openMediaPlayer,
		setQuickActionOpen,
	});
	return { actions, openMediaPlayer, setQuickActionOpen };
}

const byId = (actions: ReturnType<typeof harness>['actions'], id: string) =>
	actions.find((a) => a.id === id);

describe('buildMediaPlayerCommands', () => {
	it('always offers Open Media Player, even with nothing loaded', () => {
		// Deliberately NOT hidden when idle. A palette that omits the command
		// teaches the user the feature does not exist; the subtext explains
		// instead. Same lesson as the inline Force Send button.
		const open = byId(harness(false).actions, 'open-media-player');
		expect(open).toBeDefined();
		expect(open!.subtext).toMatch(/Nothing has been played yet/i);
	});

	it('promises to open the player when there is something to play', () => {
		const open = byId(harness(true).actions, 'open-media-player');
		expect(open!.subtext).toMatch(/floating player/i);
	});

	it('opens the player and closes the palette', () => {
		const h = harness(true);
		byId(h.actions, 'open-media-player')!.action();
		expect(h.openMediaPlayer).toHaveBeenCalledOnce();
		expect(h.setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('does not try to open anything when there is nothing to play', () => {
		const h = harness(false);
		byId(h.actions, 'open-media-player')!.action();
		expect(h.openMediaPlayer).not.toHaveBeenCalled();
		// Still dismisses the palette - the click was acknowledged.
		expect(h.setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('offers exactly one way to reach the player', () => {
		// There was a second entry, "Show Floating Media Player", offered whenever
		// the widget happened to be minimized. Two commands a word apart, both
		// meaning "put the player on screen", is a choice the user has to stop and
		// read for a distinction that is internal bookkeeping.
		expect(harness(true).actions).toHaveLength(1);
		expect(byId(harness(true).actions, 'show-floating-media-player')).toBeUndefined();
	});

	it('is findable by searching for "media"', () => {
		// The label has to contain the word users would type; this pins it
		// against a rename that would make the command unreachable.
		for (const action of harness(true).actions) {
			expect(action.label.toLowerCase()).toContain('media');
		}
	});
});
