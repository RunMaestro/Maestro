import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openUrlMock = vi.hoisted(() => vi.fn());

vi.mock('../../../renderer/utils/openUrl', () => ({
	openUrl: openUrlMock,
}));

import { EmptyStateView } from '../../../renderer/components/EmptyStateView';
import type { Shortcut, Theme } from '../../../renderer/types';

const theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#101010',
		bgSidebar: '#202020',
		bgActivity: '#303030',
		textMain: '#f5f5f5',
		textDim: '#a0a0a0',
		accent: '#3b82f6',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#ef4444',
		warning: '#f59e0b',
		success: '#22c55e',
		info: '#38bdf8',
		textInverse: '#000000',
	},
} as Theme;

const customShortcuts: Record<string, Shortcut> = {
	openWizard: { id: 'openWizard', label: 'Open Wizard', keys: ['Meta', 'Shift', 'w'] },
	settings: { id: 'settings', label: 'Settings', keys: ['Meta', '.'] },
	help: { id: 'help', label: 'Help', keys: ['Shift', '?'] },
};

function createHandlers() {
	return {
		onNewAgent: vi.fn(),
		onOpenWizard: vi.fn(),
		onOpenSettings: vi.fn(),
		onOpenShortcutsHelp: vi.fn(),
		onOpenAbout: vi.fn(),
		onCheckForUpdates: vi.fn(),
		onStartTour: vi.fn(),
	};
}

function renderEmptyState({
	shortcuts = {},
	includeTour = false,
	handlers = createHandlers(),
}: {
	shortcuts?: Record<string, Shortcut>;
	includeTour?: boolean;
	handlers?: ReturnType<typeof createHandlers>;
} = {}) {
	const view = render(
		<EmptyStateView
			theme={theme}
			shortcuts={shortcuts}
			onNewAgent={handlers.onNewAgent}
			onOpenWizard={handlers.onOpenWizard}
			onOpenSettings={handlers.onOpenSettings}
			onOpenShortcutsHelp={handlers.onOpenShortcutsHelp}
			onOpenAbout={handlers.onOpenAbout}
			onCheckForUpdates={handlers.onCheckForUpdates}
			onStartTour={includeTour ? handlers.onStartTour : undefined}
		/>
	);

	return { ...view, handlers };
}

function openMenu() {
	fireEvent.click(screen.getByTitle('Menu'));
}

describe('EmptyStateView', () => {
	beforeEach(() => {
		vi.mocked(window.maestro.shell.openExternal).mockClear();
		openUrlMock.mockClear();
	});

	it('renders welcome content and triggers the primary empty-state actions', () => {
		const { handlers } = renderEmptyState();

		expect(screen.getByRole('heading', { name: 'MAESTRO' })).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Welcome to Maestro' })).toBeInTheDocument();
		expect(
			screen.getByText(
				'To get started, create your first agent manually or with the help of the AI wizard.'
			)
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Create your first agent' }));
		openMenu();
		fireEvent.click(screen.getByText('New Agent Wizard'));

		expect(handlers.onNewAgent).toHaveBeenCalledTimes(1);
		expect(handlers.onOpenWizard).toHaveBeenCalledTimes(1);
	});

	it('shows fallback shortcuts without the optional tour item and closes by toggling the menu button', () => {
		renderEmptyState();

		openMenu();

		expect(screen.queryByText('Take a Tour')).not.toBeInTheDocument();
		expect(screen.getByText('⇧⌘N')).toBeInTheDocument();
		expect(screen.getByText('⌘,')).toBeInTheDocument();
		expect(screen.getByText('?')).toBeInTheDocument();

		openMenu();

		expect(screen.queryByText('Settings')).not.toBeInTheDocument();
	});

	it('runs menu callbacks, formats configured shortcuts, and closes after each selection', () => {
		const { handlers } = renderEmptyState({ shortcuts: customShortcuts, includeTour: true });

		openMenu();
		expect(screen.getByText('Ctrl+Shift+W')).toBeInTheDocument();
		expect(screen.getByText('Ctrl+.')).toBeInTheDocument();
		expect(screen.getByText('Shift+?')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Take a Tour'));
		expect(handlers.onStartTour).toHaveBeenCalledTimes(1);
		expect(screen.queryByText('Take a Tour')).not.toBeInTheDocument();

		openMenu();
		fireEvent.click(screen.getByText('New Agent Wizard'));
		expect(handlers.onOpenWizard).toHaveBeenCalledTimes(1);
		expect(screen.queryByText('New Agent Wizard')).not.toBeInTheDocument();

		openMenu();
		fireEvent.click(screen.getByText('Settings'));
		expect(handlers.onOpenSettings).toHaveBeenCalledTimes(1);

		openMenu();
		fireEvent.click(screen.getByText('Keyboard Shortcuts'));
		expect(handlers.onOpenShortcutsHelp).toHaveBeenCalledTimes(1);

		openMenu();
		fireEvent.click(screen.getByText('Check for Updates'));
		expect(handlers.onCheckForUpdates).toHaveBeenCalledTimes(1);

		openMenu();
		fireEvent.click(screen.getByText('About Maestro'));
		expect(handlers.onOpenAbout).toHaveBeenCalledTimes(1);
	});

	it('opens external website and documentation links from the menu', () => {
		renderEmptyState();

		openMenu();
		fireEvent.click(screen.getByText('Maestro Website'));

		expect(openUrlMock).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/runmaestro\.ai/));
		expect(screen.queryByText('Maestro Website')).not.toBeInTheDocument();

		openMenu();
		fireEvent.click(screen.getByText('Documentation'));

		expect(openUrlMock).toHaveBeenCalledWith(
			expect.stringMatching(/^https:\/\/docs\.runmaestro\.ai/)
		);
		expect(screen.queryByText('Documentation')).not.toBeInTheDocument();
	});

	it('keeps the menu open for unrelated keys, then closes on Escape and outside clicks', () => {
		renderEmptyState({ includeTour: true });

		openMenu();
		fireEvent.keyDown(document, { key: 'Enter' });
		expect(screen.getByText('Take a Tour')).toBeInTheDocument();

		fireEvent.keyDown(document, { key: 'Escape' });

		expect(screen.queryByText('Take a Tour')).not.toBeInTheDocument();

		openMenu();
		fireEvent.mouseDown(document.body);

		expect(screen.queryByText('Take a Tour')).not.toBeInTheDocument();
	});
});
