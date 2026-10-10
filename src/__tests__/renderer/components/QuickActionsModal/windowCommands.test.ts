/**
 * Tests for buildWindowCommands - the Cmd+K palette commands that move the active
 * agent between windows. Mirrors the Left Bar's Move-to-Window submenu.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildWindowCommands } from '../../../../renderer/components/QuickActionsModal/commands/windowCommands';
import type { Session } from '../../../../renderer/types';
import type { WindowMoveTarget } from '../../../../renderer/utils/windowTargets';

function makeSession(partial: Partial<Session> & Pick<Session, 'id' | 'name'>): Session {
	// Only id/name are read by buildWindowCommands; cast the rest.
	return { id: partial.id, name: partial.name } as Session;
}

function makeTarget(
	partial: Partial<WindowMoveTarget> & Pick<WindowMoveTarget, 'windowId'>
): WindowMoveTarget {
	return {
		isMain: false,
		windowNumber: 2,
		label: 'Bravo',
		isCurrentOwner: false,
		...partial,
	};
}

describe('buildWindowCommands', () => {
	const noop = () => {};

	it('returns [] with no active agent', () => {
		expect(
			buildWindowCommands({
				activeSession: undefined,
				windowTargets: [makeTarget({ windowId: 'win-2' })],
				moveToNewWindow: vi.fn(),
				moveToWindow: vi.fn(),
				setQuickActionOpen: noop,
			})
		).toEqual([]);
	});

	it('returns [] when no windows are enumerated (single-window app)', () => {
		expect(
			buildWindowCommands({
				activeSession: makeSession({ id: 'a', name: 'Alpha' }),
				windowTargets: [],
				moveToNewWindow: vi.fn(),
				moveToWindow: vi.fn(),
				setQuickActionOpen: noop,
			})
		).toEqual([]);
	});

	it('always offers "new window" and one command per non-owner window', () => {
		const commands = buildWindowCommands({
			activeSession: makeSession({ id: 'a', name: 'Alpha' }),
			windowTargets: [
				makeTarget({
					windowId: 'primary',
					isMain: true,
					label: 'Main Window',
					isCurrentOwner: true,
				}),
				makeTarget({ windowId: 'win-2', label: 'Bravo' }),
			],
			moveToNewWindow: vi.fn(),
			moveToWindow: vi.fn(),
			setQuickActionOpen: noop,
		});
		const labels = commands.map((c) => c.label);
		expect(labels).toContain('Move Agent to New Window: Alpha');
		expect(labels).toContain('Move Agent to Bravo');
		// The current owner (primary) is not a destination.
		expect(labels).not.toContain('Move Agent to Main Window');
	});

	it('wires "new window" and per-window actions to the movers and closes the palette', () => {
		const moveToNewWindow = vi.fn();
		const moveToWindow = vi.fn();
		const setQuickActionOpen = vi.fn();
		const commands = buildWindowCommands({
			activeSession: makeSession({ id: 'a', name: 'Alpha' }),
			windowTargets: [makeTarget({ windowId: 'win-2', label: 'Bravo' })],
			moveToNewWindow,
			moveToWindow,
			setQuickActionOpen,
		});

		commands.find((c) => c.id === 'move-to-new-window')!.action();
		expect(moveToNewWindow).toHaveBeenCalledWith('a');
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);

		commands.find((c) => c.id === 'move-to-window-win-2')!.action();
		expect(moveToWindow).toHaveBeenCalledWith('a', 'win-2');
	});

	describe('rename this window command', () => {
		it('offers "Rename This Window" only when canRenameCurrentWindow is set', () => {
			const withRename = buildWindowCommands({
				activeSession: makeSession({ id: 'a', name: 'Alpha' }),
				windowTargets: [makeTarget({ windowId: 'win-2', label: 'Bravo' })],
				moveToNewWindow: vi.fn(),
				moveToWindow: vi.fn(),
				setQuickActionOpen: noop,
				canRenameCurrentWindow: true,
				beginRenameCurrentWindow: vi.fn(),
			});
			expect(withRename.map((c) => c.label)).toContain('Rename This Window');

			const withoutRename = buildWindowCommands({
				activeSession: makeSession({ id: 'a', name: 'Alpha' }),
				windowTargets: [makeTarget({ windowId: 'win-2', label: 'Bravo' })],
				moveToNewWindow: vi.fn(),
				moveToWindow: vi.fn(),
				setQuickActionOpen: noop,
			});
			expect(withoutRename.map((c) => c.label)).not.toContain('Rename This Window');
		});

		it('rename action begins the inline rename WITHOUT closing the palette', () => {
			const beginRenameCurrentWindow = vi.fn();
			const setQuickActionOpen = vi.fn();
			const commands = buildWindowCommands({
				activeSession: makeSession({ id: 'a', name: 'Alpha' }),
				windowTargets: [makeTarget({ windowId: 'win-2', label: 'Bravo' })],
				moveToNewWindow: vi.fn(),
				moveToWindow: vi.fn(),
				setQuickActionOpen,
				canRenameCurrentWindow: true,
				beginRenameCurrentWindow,
			});

			commands.find((c) => c.id === 'rename-current-window')!.action();
			expect(beginRenameCurrentWindow).toHaveBeenCalledTimes(1);
			// The palette stays open so the rename input can take over.
			expect(setQuickActionOpen).not.toHaveBeenCalled();
		});

		it('offers the rename command even with no move targets (secondary owning nothing movable)', () => {
			const commands = buildWindowCommands({
				activeSession: undefined,
				windowTargets: [],
				moveToNewWindow: vi.fn(),
				moveToWindow: vi.fn(),
				setQuickActionOpen: noop,
				canRenameCurrentWindow: true,
				beginRenameCurrentWindow: vi.fn(),
			});
			expect(commands.map((c) => c.id)).toEqual(['rename-current-window']);
		});
	});
});
