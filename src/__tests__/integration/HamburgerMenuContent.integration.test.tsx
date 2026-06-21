import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HamburgerMenuContent } from '../../renderer/components/SessionList/HamburgerMenuContent';
import type { Theme } from '../../renderer/types';

const testHarness = vi.hoisted(() => ({
	settingsState: {
		activeThemeId: undefined as string | undefined,
		shortcuts: {} as Record<string, { keys: string[] }>,
		encoreFeatures: { directorNotes: true, symphony: true, usageStats: true },
	},
	modalActions: {
		setShortcutsHelpOpen: vi.fn(),
		setSettingsModalOpen: vi.fn(),
		setSettingsTab: vi.fn(),
		setLogViewerOpen: vi.fn(),
		setProcessMonitorOpen: vi.fn(),
		setUsageDashboardOpen: vi.fn(),
		setSymphonyModalOpen: vi.fn(),
		setDirectorNotesOpen: vi.fn(),
		setUpdateCheckModalOpen: vi.fn(),
		setAboutModalOpen: vi.fn(),
		setQuickActionOpen: vi.fn(),
	},
}));

vi.mock('lucide-react', () => {
	const Icon = ({ className }: { className?: string }) => (
		<span data-testid="menu-icon" className={className} />
	);
	return {
		Wand2: Icon,
		Plus: Icon,
		Settings: Icon,
		Keyboard: Icon,
		ScrollText: Icon,
		Cpu: Icon,
		ExternalLink: Icon,
		Info: Icon,
		Download: Icon,
		Compass: Icon,
		Globe: Icon,
		BookOpen: Icon,
		BarChart3: Icon,
		Music: Icon,
		Command: Icon,
	};
});

vi.mock('../../renderer/stores/settingsStore', () => {
	const useSettingsStore = (selector: (state: typeof testHarness.settingsState) => unknown) =>
		selector(testHarness.settingsState);
	useSettingsStore.getState = () => testHarness.settingsState;

	return { useSettingsStore };
});

vi.mock('../../renderer/stores/modalStore', () => ({
	getModalActions: () => testHarness.modalActions,
}));

const theme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	colors: {
		bgActivity: '#222222',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#66ccff',
		border: '#333333',
	},
};

function createShortcuts(): Record<string, { keys: string[] }> {
	return {
		newInstance: { keys: ['Meta', 'N'] },
		openWizard: { keys: ['Shift', 'Meta', 'N'] },
		quickAction: { keys: ['Meta', 'K'] },
		help: { keys: ['Meta', '?'] },
		settings: { keys: ['Meta', ','] },
		systemLogs: { keys: ['Shift', 'Meta', 'L'] },
		processMonitor: { keys: ['Shift', 'Meta', 'P'] },
		usageDashboard: { keys: ['Shift', 'Meta', 'U'] },
		openSymphony: { keys: ['Shift', 'Meta', 'Y'] },
		directorNotes: { keys: ['Shift', 'Meta', 'D'] },
	};
}

function renderMenu(overrides: Partial<Parameters<typeof HamburgerMenuContent>[0]> = {}) {
	const props = {
		theme,
		setMenuOpen: vi.fn(),
		...overrides,
	};
	const result = render(<HamburgerMenuContent {...props} />);
	return { ...props, ...result };
}

function clickMenuItem(label: string) {
	fireEvent.click(screen.getByText(label));
}

describe('HamburgerMenuContent', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		testHarness.settingsState.activeThemeId = undefined;
		testHarness.settingsState.shortcuts = createShortcuts();
		testHarness.settingsState.encoreFeatures = {
			directorNotes: true,
			symphony: true,
			usageStats: true,
		};
		const maestroWindow = window as typeof window & {
			maestro?: { shell?: { openExternal?: ReturnType<typeof vi.fn> } };
		};
		maestroWindow.maestro ??= {};
		maestroWindow.maestro.shell ??= {};
		maestroWindow.maestro.shell.openExternal = vi.fn();
	});

	it('renders optional agent, wizard, and tour actions only when callbacks are provided', () => {
		renderMenu();

		expect(screen.queryByText('New Agent')).not.toBeInTheDocument();
		expect(screen.queryByText('New Agent Wizard')).not.toBeInTheDocument();
		expect(screen.queryByText('Introductory Tour')).not.toBeInTheDocument();

		renderMenu({
			onNewAgentSession: vi.fn(),
			openWizard: vi.fn(),
			startTour: vi.fn(),
		});

		expect(screen.getByText('New Agent')).toBeInTheDocument();
		expect(screen.getByText('New Agent Wizard')).toBeInTheDocument();
		expect(screen.getByText('Introductory Tour')).toBeInTheDocument();
	});

	it('runs optional session actions and closes the menu', () => {
		const onNewAgentSession = vi.fn();
		const openWizard = vi.fn();
		const startTour = vi.fn();
		const props = renderMenu({ onNewAgentSession, openWizard, startTour });

		clickMenuItem('New Agent');
		clickMenuItem('New Agent Wizard');
		clickMenuItem('Introductory Tour');

		expect(onNewAgentSession).toHaveBeenCalledTimes(1);
		expect(openWizard).toHaveBeenCalledTimes(1);
		expect(startTour).toHaveBeenCalledTimes(1);
		expect(props.setMenuOpen).toHaveBeenCalledWith(false);
		expect(props.setMenuOpen).toHaveBeenCalledTimes(3);
	});

	it('opens command, app, telemetry, symphony, update, and about modals', () => {
		const props = renderMenu();

		clickMenuItem('Command Palette');
		clickMenuItem('Keyboard Shortcuts');
		clickMenuItem('Settings');
		clickMenuItem('System Logs');
		clickMenuItem('Process Monitor');
		clickMenuItem('Usage Dashboard');
		clickMenuItem('Maestro Symphony');
		clickMenuItem('Check for Updates');
		clickMenuItem('About Maestro');

		expect(testHarness.modalActions.setQuickActionOpen).toHaveBeenCalledWith(true);
		expect(testHarness.modalActions.setShortcutsHelpOpen).toHaveBeenCalledWith(true);
		expect(testHarness.modalActions.setSettingsModalOpen).toHaveBeenCalledWith(true);
		expect(testHarness.modalActions.setLogViewerOpen).toHaveBeenCalledWith(true);
		expect(testHarness.modalActions.setProcessMonitorOpen).toHaveBeenCalledWith(true);
		expect(testHarness.modalActions.setUsageDashboardOpen).toHaveBeenCalledWith(true);
		expect(testHarness.modalActions.setSymphonyModalOpen).toHaveBeenCalledWith(true);
		expect(testHarness.modalActions.setUpdateCheckModalOpen).toHaveBeenCalledWith(true);
		expect(testHarness.modalActions.setAboutModalOpen).toHaveBeenCalledWith(true);
		expect(props.setMenuOpen).toHaveBeenCalledTimes(9);
		expect(props.setMenuOpen).toHaveBeenLastCalledWith(false);
	});

	it('gates Director Notes on the encore feature flag', () => {
		const props = renderMenu();

		clickMenuItem("Director's Notes");
		expect(testHarness.modalActions.setDirectorNotesOpen).toHaveBeenCalledWith(true);
		expect(props.setMenuOpen).toHaveBeenCalledWith(false);

		props.unmount();
		testHarness.settingsState.encoreFeatures = { directorNotes: false };
		renderMenu();

		expect(screen.queryByText("Director's Notes")).not.toBeInTheDocument();
	});

	it('opens external product links and closes the menu', () => {
		const props = renderMenu();

		clickMenuItem('Maestro Website');
		clickMenuItem('Documentation');

		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://runmaestro.ai/');
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://docs.runmaestro.ai/');
		expect(props.setMenuOpen).toHaveBeenCalledTimes(2);
		expect(props.setMenuOpen).toHaveBeenLastCalledWith(false);
	});

	it('uses fallback shortcut labels when optional shortcuts are absent', () => {
		testHarness.settingsState.shortcuts = {
			help: { keys: ['Meta', '?'] },
			settings: { keys: ['Meta', ','] },
			systemLogs: { keys: ['Shift', 'Meta', 'L'] },
			processMonitor: { keys: ['Shift', 'Meta', 'P'] },
			usageDashboard: { keys: ['Shift', 'Meta', 'U'] },
		};

		renderMenu({ onNewAgentSession: vi.fn(), openWizard: vi.fn() });

		expect(screen.getByText('⌘N')).toBeInTheDocument();
		expect(screen.getByText('⇧⌘N')).toBeInTheDocument();
		expect(screen.getByText('⌘K')).toBeInTheDocument();
		expect(screen.getByText('⇧⌘Y')).toBeInTheDocument();
	});
});
