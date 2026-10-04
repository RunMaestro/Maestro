import { describe, expect, it, vi } from 'vitest';
import { buildFeatureCommands } from '../../../../../renderer/components/QuickActionsModal/commands/featureCommands';

function build(onOpenComputerHistory?: () => void, close = vi.fn()) {
	return buildFeatureCommands({
		activeSession: undefined,
		onOpenComputerHistory,
		setQuickActionOpen: close,
		setSuccessFlashNotification: vi.fn(),
		setAgentSessionsOpen: vi.fn(),
		setActiveAgentSessionId: vi.fn(),
		bionifyReadingMode: false,
		setBionifyReadingMode: vi.fn(),
		audioFeedbackEnabled: false,
		setAudioFeedbackEnabled: vi.fn(),
		idleNotificationEnabled: false,
		setIdleNotificationEnabled: vi.fn(),
		showStarredSessionsSection: true,
		setShowStarredSessionsSection: vi.fn(),
		shortcuts: {
			computerHistory: {
				id: 'computerHistory',
				label: 'Computer History',
				keys: ['Control', 'Meta', 'h'],
			},
		},
	});
}

describe('Computer History palette entry', () => {
	it('is absent unless the caller can open the viewer (Encore off, or web-desktop)', () => {
		expect(build().map((a) => a.id)).not.toContain('computer-history');
	});

	it('opens the viewer, closes the palette, and shows its chord', () => {
		const open = vi.fn();
		const close = vi.fn();
		const entry = build(open, close).find((a) => a.id === 'computer-history')!;
		expect(entry.label).toBe('Computer History');
		expect(entry.shortcut?.keys).toEqual(['Control', 'Meta', 'h']);
		entry.action();
		expect(open).toHaveBeenCalled();
		expect(close).toHaveBeenCalledWith(false);
	});
});
