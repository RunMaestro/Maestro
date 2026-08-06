/**
 * @fileoverview Tests for SnoozeHistoryModal's jump-to-tab behaviour.
 *
 * The interesting logic is resolving a history entry against LIVE state: an
 * entry is a snapshot, so its agent may be deleted and its tab closed (or, for
 * a dismissed entry, never restored at all). These tests pin what each of those
 * cases does when clicked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SnoozeHistoryModal } from '../../../renderer/components/SnoozeHistoryModal';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSnoozeHistoryStore } from '../../../renderer/stores/snoozeHistoryStore';
import type { SnoozeHistoryEntry } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import { mockTheme } from '../../helpers/mockTheme';

// The shared Modal registers with the layer stack, which needs a provider we
// don't otherwise care about here.
vi.mock('../../../renderer/contexts/LayerStackContext', async () => {
	const actual = await vi.importActual('../../../renderer/contexts/LayerStackContext');
	return {
		...actual,
		useLayerStack: () => ({
			registerLayer: vi.fn(() => 'layer-1'),
			unregisterLayer: vi.fn(),
			updateLayerHandler: vi.fn(),
			getTopLayer: vi.fn(),
			closeTopLayer: vi.fn(),
			getLayers: vi.fn(() => []),
			hasOpenLayers: vi.fn(() => false),
			hasOpenModal: vi.fn(() => false),
			layerCount: 0,
		}),
	};
});

vi.mock('lucide-react', () => {
	const icon =
		(testId: string) =>
		({ className }: { className?: string }) => <span data-testid={testId} className={className} />;
	return {
		History: icon('history-icon'),
		StickyNote: icon('sticky-note-icon'),
		RotateCcw: icon('rotate-ccw-icon'),
		BellRing: icon('bell-ring-icon'),
		X: icon('x-icon'),
	};
});

function historyEntry(overrides: Partial<SnoozeHistoryEntry> = {}): SnoozeHistoryEntry {
	return {
		id: 'h1',
		label: 'XI CPE Registry',
		sessionId: 's1',
		sessionName: 'Pedsidian',
		tabId: 'tab-1',
		note: 'check the registry',
		snoozedAt: 1000,
		wakeAt: 2000,
		resolvedAt: 3000,
		resolution: 'woke',
		...overrides,
	};
}

/** Seed the session store with one agent owning `tabIds`. */
function seedSessions(tabIds: string[]) {
	useSessionStore.setState({
		sessions: [
			createMockSession({
				id: 's1',
				name: 'Pedsidian',
				aiTabs: tabIds.map((id) => createMockAITab({ id })),
			}),
		],
		activeSessionId: 's1',
	});
}

describe('SnoozeHistoryModal jump-to-tab', () => {
	beforeEach(() => {
		useSnoozeHistoryStore.setState({ entries: [] });
		useSessionStore.setState({ sessions: [], activeSessionId: '' });
	});

	it('jumps to the agent and tab when the tab is still open', () => {
		seedSessions(['tab-1']);
		useSnoozeHistoryStore.setState({ entries: [historyEntry()] });
		const onJumpToTab = vi.fn();

		render(<SnoozeHistoryModal theme={mockTheme} onClose={vi.fn()} onJumpToTab={onJumpToTab} />);
		fireEvent.click(screen.getByText('XI CPE Registry'));

		expect(onJumpToTab).toHaveBeenCalledWith('s1', 'tab-1');
	});

	it('opens just the agent when that tab is no longer open', () => {
		// The agent is still there but the tab has since been closed, so the row
		// must not promise a tab it cannot focus.
		seedSessions(['some-other-tab']);
		useSnoozeHistoryStore.setState({ entries: [historyEntry()] });
		const onJumpToTab = vi.fn();

		render(<SnoozeHistoryModal theme={mockTheme} onClose={vi.fn()} onJumpToTab={onJumpToTab} />);
		fireEvent.click(screen.getByText('XI CPE Registry'));

		expect(onJumpToTab).toHaveBeenCalledWith('s1', undefined);
	});

	it('opens just the agent for a dismissed entry, whose tab was never restored', () => {
		seedSessions(['some-other-tab']);
		useSnoozeHistoryStore.setState({
			entries: [historyEntry({ resolution: 'dismissed' })],
		});
		const onJumpToTab = vi.fn();

		render(<SnoozeHistoryModal theme={mockTheme} onClose={vi.fn()} onJumpToTab={onJumpToTab} />);
		fireEvent.click(screen.getByText('XI CPE Registry'));

		expect(onJumpToTab).toHaveBeenCalledWith('s1', undefined);
	});

	it('is inert when the agent no longer exists', () => {
		// No sessions at all: the agent was deleted after the snooze resolved.
		useSnoozeHistoryStore.setState({ entries: [historyEntry()] });
		const onJumpToTab = vi.fn();

		render(<SnoozeHistoryModal theme={mockTheme} onClose={vi.fn()} onJumpToTab={onJumpToTab} />);
		fireEvent.click(screen.getByText('XI CPE Registry'));

		expect(onJumpToTab).not.toHaveBeenCalled();
	});

	it('exposes a resolvable row as a keyboard-reachable button', () => {
		seedSessions(['tab-1']);
		useSnoozeHistoryStore.setState({ entries: [historyEntry()] });
		const onJumpToTab = vi.fn();

		render(<SnoozeHistoryModal theme={mockTheme} onClose={vi.fn()} onJumpToTab={onJumpToTab} />);
		const row = screen.getByRole('button', { name: /XI CPE Registry/ });
		expect(row).toHaveAttribute('tabindex', '0');

		fireEvent.keyDown(row, { key: 'Enter' });
		expect(onJumpToTab).toHaveBeenCalledWith('s1', 'tab-1');
	});

	it('does not expose an unresolvable row as a button', () => {
		useSnoozeHistoryStore.setState({ entries: [historyEntry()] });

		render(<SnoozeHistoryModal theme={mockTheme} onClose={vi.fn()} onJumpToTab={vi.fn()} />);
		expect(screen.queryByRole('button', { name: /XI CPE Registry/ })).toBeNull();
	});

	it('stays inert when no jump handler is supplied at all', () => {
		seedSessions(['tab-1']);
		useSnoozeHistoryStore.setState({ entries: [historyEntry()] });

		render(<SnoozeHistoryModal theme={mockTheme} onClose={vi.fn()} />);
		expect(screen.queryByRole('button', { name: /XI CPE Registry/ })).toBeNull();
	});
});
