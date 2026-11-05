/**
 * Tests for Encore-gated entries in the Left Bar hamburger menu.
 *
 * An entry for a switched-off Encore Feature must leave no trace, and an entry
 * for a switched-on one must do what its hotkey does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HamburgerMenuContent } from '../../../../renderer/components/SessionList/HamburgerMenuContent';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useThroughputGaugeStore } from '../../../../renderer/stores/throughputGaugeStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useModalStore } from '../../../../renderer/stores/modalStore';
import { createMockSession } from '../../../helpers/mockSession';
import { mockTheme } from '../../../helpers/mockTheme';

function renderMenu(setMenuOpen = vi.fn()) {
	return render(
		<HamburgerMenuContent
			theme={mockTheme}
			onNewAgentSession={vi.fn()}
			openWizard={vi.fn()}
			startTour={vi.fn()}
			setMenuOpen={setMenuOpen}
		/>
	);
}

function setGaugeFlag(on: boolean) {
	useSettingsStore.setState((s) => ({
		encoreFeatures: { ...s.encoreFeatures, throughputGauge: on },
	}));
}

describe('HamburgerMenuContent - Throughput Gauge', () => {
	const initialEncore = useSettingsStore.getState().encoreFeatures;

	beforeEach(() => {
		useThroughputGaugeStore.setState({ visible: false });
	});

	afterEach(() => {
		useSettingsStore.setState({ encoreFeatures: initialEncore });
	});

	it('leaves the item out while the Encore Feature is off', () => {
		setGaugeFlag(false);
		renderMenu();
		expect(screen.queryByText('Throughput Gauge')).not.toBeInTheDocument();
	});

	it('toggles the gauge and closes the menu while the Encore Feature is on', () => {
		setGaugeFlag(true);
		const closeMenu = vi.fn();
		renderMenu(closeMenu);

		fireEvent.click(screen.getByRole('button', { name: /Throughput Gauge/ }));
		expect(useThroughputGaugeStore.getState().visible).toBe(true);
		expect(closeMenu).toHaveBeenCalledWith(false);

		fireEvent.click(screen.getByRole('button', { name: /Throughput Gauge/ }));
		expect(useThroughputGaugeStore.getState().visible).toBe(false);
	});
});

describe('HamburgerMenuContent - Worktree PR and CI', () => {
	afterEach(() => {
		useSessionStore.setState({ sessions: [], activeSessionId: '' });
		useModalStore.getState().closeModal('worktreePRDetails');
	});
	it('opens the active managed worktree and closes the menu', () => {
		const session = createMockSession({
			id: 'worktree',
			isGitRepo: true,
			parentSessionId: 'parent',
			worktreeBranch: 'feat/x',
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
		const close = vi.fn();
		renderMenu(close);
		fireEvent.click(screen.getByRole('button', { name: /Worktree PR and CI/ }));
		expect(useModalStore.getState().modals.get('worktreePRDetails')).toMatchObject({
			open: true,
			data: { sessionId: session.id },
		});
		expect(close).toHaveBeenCalledWith(false);
	});
	it('omits the entry for a parent repository', () => {
		const session = createMockSession({ id: 'parent', isGitRepo: true });
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
		renderMenu();
		expect(screen.queryByRole('button', { name: /Worktree PR and CI/ })).not.toBeInTheDocument();
	});
});
