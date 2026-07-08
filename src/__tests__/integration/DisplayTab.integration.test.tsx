import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisplayTab } from '../../renderer/components/Settings/tabs/DisplayTab';
import {
	DEFAULT_FILE_EXPLORER_MAX_DEPTH,
	DEFAULT_FILE_EXPLORER_MAX_ENTRIES,
	DEFAULT_FILE_PREVIEW_TOOLBAR_VISIBILITY,
} from '../../renderer/stores/settingsStore';
import type { Theme } from '../../renderer/types';

const hookMocks = vi.hoisted(() => ({
	settings: {} as Record<string, unknown>,
	useModalLayer: vi.fn(),
}));

vi.mock('../../renderer/hooks', () => ({
	useSettings: () => hookMocks.settings,
	useModalLayer: hookMocks.useModalLayer,
}));

const theme: Theme = {
	id: 'integration-theme',
	name: 'Integration Theme',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#1b1b1b',
		bgActivity: '#262626',
		border: '#444444',
		textMain: '#f5f5f5',
		textDim: '#a3a3a3',
		accent: '#38bdf8',
		accentDim: '#38bdf820',
		accentText: '#7dd3fc',
		accentForeground: '#020617',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const createSettings = (overrides: Record<string, unknown> = {}) => ({
	fontFamily: 'Menlo',
	setFontFamily: vi.fn(),
	fontSize: 14,
	setFontSize: vi.fn(),
	terminalWidth: 100,
	setTerminalWidth: vi.fn(),
	maxLogBuffer: 5000,
	setMaxLogBuffer: vi.fn(),
	maxOutputLines: 25,
	setMaxOutputLines: vi.fn(),
	colorBlindMode: false,
	setColorBlindMode: vi.fn(),
	bionifyReadingMode: false,
	setBionifyReadingMode: vi.fn(),
	bionifyIntensity: 1,
	setBionifyIntensity: vi.fn(),
	bionifyAlgorithm: '- 0 1 1 2 0.4',
	setBionifyAlgorithm: vi.fn(),
	userMessageAlignment: 'left',
	setUserMessageAlignment: vi.fn(),
	fileExplorerIconTheme: 'default',
	setFileExplorerIconTheme: vi.fn(),
	showStarredInUnreadFilter: true,
	setShowStarredInUnreadFilter: vi.fn(),
	showFilePreviewsInUnreadFilter: true,
	setShowFilePreviewsInUnreadFilter: vi.fn(),
	useCmd0AsLastTab: true,
	setUseCmd0AsLastTab: vi.fn(),
	showBrowserTabDomain: true,
	setShowBrowserTabDomain: vi.fn(),
	fileExplorerMaxDepth: DEFAULT_FILE_EXPLORER_MAX_DEPTH,
	setFileExplorerMaxDepth: vi.fn(),
	fileExplorerMaxEntries: DEFAULT_FILE_EXPLORER_MAX_ENTRIES,
	setFileExplorerMaxEntries: vi.fn(),
	sshReduceEntryCapEnabled: true,
	setSshReduceEntryCapEnabled: vi.fn(),
	sshReduceEntryCapFraction: 0.25,
	setSshReduceEntryCapFraction: vi.fn(),
	filePreviewToolbarVisibility: { ...DEFAULT_FILE_PREVIEW_TOOLBAR_VISIBILITY },
	setFilePreviewToolbarButtonVisibility: vi.fn(),
	useNativeTitleBar: false,
	setUseNativeTitleBar: vi.fn(),
	autoHideMenuBar: false,
	setAutoHideMenuBar: vi.fn(),
	showAgentName: true,
	setShowAgentName: vi.fn(),
	showSessionIdPill: true,
	setShowSessionIdPill: vi.fn(),
	showSessionCostPill: true,
	setShowSessionCostPill: vi.fn(),
	showWorktreePill: true,
	setShowWorktreePill: vi.fn(),
	showWorktreeBranchName: true,
	setShowWorktreeBranchName: vi.fn(),
	showStarredSessionsSection: true,
	setShowStarredSessionsSection: vi.fn(),
	showLeftPanelGroupMemberCount: true,
	setShowLeftPanelGroupMemberCount: vi.fn(),
	leftPanelCollapsedPillsPerRow: 20,
	setLeftPanelCollapsedPillsPerRow: vi.fn(),
	showLeftPanelLocationPills: true,
	setShowLeftPanelLocationPills: vi.fn(),
	showLeftPanelGitIndicator: true,
	setShowLeftPanelGitIndicator: vi.fn(),
	showLeftPanelCueIndicator: true,
	setShowLeftPanelCueIndicator: vi.fn(),
	showLeftPanelStartupCommandIndicator: true,
	setShowLeftPanelStartupCommandIndicator: vi.fn(),
	showGroupLabelInBookmarks: true,
	setShowGroupLabelInBookmarks: vi.fn(),
	showFullGroupLabelInBookmarks: false,
	setShowFullGroupLabelInBookmarks: vi.fn(),
	documentGraphShowExternalLinks: true,
	setDocumentGraphShowExternalLinks: vi.fn(),
	documentGraphMaxNodes: 100,
	setDocumentGraphMaxNodes: vi.fn(),
	contextManagementSettings: {
		contextWarningsEnabled: false,
		contextWarningYellowThreshold: 60,
		contextWarningRedThreshold: 80,
	},
	updateContextManagementSettings: vi.fn(),
	localIgnorePatterns: ['.git', 'node_modules'],
	setLocalIgnorePatterns: vi.fn(),
	localHonorGitignore: true,
	setLocalHonorGitignore: vi.fn(),
	...overrides,
});

function renderDisplayTab(overrides: Record<string, unknown> = {}) {
	hookMocks.settings = createSettings(overrides);
	return render(<DisplayTab theme={theme} />);
}

function switchBeside(label: string) {
	const row = screen.getByText(label).parentElement?.parentElement;
	if (!row) throw new Error(`Missing row for ${label}`);
	return within(row).getByRole('switch');
}

describe('DisplayTab integration', () => {
	beforeEach(() => {
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			callback(0);
			return 0;
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it('updates Bionify reading mode, intensity help, and algorithm commits through UI events', () => {
		renderDisplayTab();

		fireEvent.click(screen.getByRole('switch', { name: 'Bionify reading mode' }));
		expect(hookMocks.settings.setBionifyReadingMode).toHaveBeenCalledWith(true);

		fireEvent.click(screen.getByRole('button', { name: 'Info' }));
		expect(screen.getByRole('dialog', { name: 'Bionify Algorithm Reference' })).toBeInTheDocument();
		expect(screen.getByText(/skips common english words/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));
		expect(
			screen.queryByRole('dialog', { name: 'Bionify Algorithm Reference' })
		).not.toBeInTheDocument();

		const algorithmInput = screen.getByLabelText('Bionify algorithm');
		fireEvent.change(algorithmInput, { target: { value: 'invalid algorithm' } });
		expect(screen.getByText(/Enter `\+\|- len1 len2 len3 len4 fraction`/)).toBeInTheDocument();
		fireEvent.blur(algorithmInput);
		expect(hookMocks.settings.setBionifyAlgorithm).not.toHaveBeenCalled();

		fireEvent.change(algorithmInput, { target: { value: '+ 1 2 3 4 1' } });
		fireEvent.keyDown(algorithmInput, { key: 'Enter' });
		fireEvent.blur(algorithmInput);

		expect(hookMocks.settings.setBionifyAlgorithm).toHaveBeenCalledWith('+ 1 2 3 4 1');
	});

	it('updates window chrome and document graph controls', () => {
		renderDisplayTab();

		fireEvent.click(switchBeside('Use native title bar'));
		expect(hookMocks.settings.setUseNativeTitleBar).toHaveBeenCalledWith(true);

		fireEvent.click(switchBeside('Auto-hide menu bar'));
		expect(hookMocks.settings.setAutoHideMenuBar).toHaveBeenCalledWith(true);

		fireEvent.click(switchBeside('Show external links by default'));
		expect(hookMocks.settings.setDocumentGraphShowExternalLinks).toHaveBeenCalledWith(false);

		const documentGraphMaxNodes = screen.getByRole('slider', {
			name: 'Maximum nodes to display',
		});
		fireEvent.change(documentGraphMaxNodes, { target: { value: '250' } });
		expect(hookMocks.settings.setDocumentGraphMaxNodes).toHaveBeenCalledWith(250);
	});

	it('toggles context warnings from row, switch, and keyboard controls', () => {
		renderDisplayTab();

		const row = screen.getByRole('button', { name: /Show context consumption warnings/ });
		fireEvent.click(row);
		fireEvent.keyDown(row, { key: 'Enter' });
		fireEvent.keyDown(row, { key: ' ' });

		const rowSwitch = within(row).getByRole('switch');
		fireEvent.click(rowSwitch);

		expect(hookMocks.settings.updateContextManagementSettings).toHaveBeenCalledTimes(4);
		expect(hookMocks.settings.updateContextManagementSettings).toHaveBeenCalledWith({
			contextWarningsEnabled: true,
		});
	});

	it('keeps context warning thresholds ordered when slider values cross', () => {
		renderDisplayTab({
			contextManagementSettings: {
				contextWarningsEnabled: true,
				contextWarningYellowThreshold: 60,
				contextWarningRedThreshold: 80,
			},
		});

		const yellowSlider = screen.getByRole('slider', { name: 'Yellow warning threshold' });
		const redSlider = screen.getByRole('slider', { name: 'Red warning threshold' });

		fireEvent.change(yellowSlider, { target: { value: '95' } });
		expect(hookMocks.settings.updateContextManagementSettings).toHaveBeenCalledWith({
			contextWarningYellowThreshold: 95,
			contextWarningRedThreshold: 100,
		});

		fireEvent.change(yellowSlider, { target: { value: '65' } });
		expect(hookMocks.settings.updateContextManagementSettings).toHaveBeenCalledWith({
			contextWarningYellowThreshold: 65,
		});

		fireEvent.change(redSlider, { target: { value: '50' } });
		expect(hookMocks.settings.updateContextManagementSettings).toHaveBeenCalledWith({
			contextWarningRedThreshold: 50,
			contextWarningYellowThreshold: 40,
		});

		fireEvent.change(redSlider, { target: { value: '90' } });
		expect(hookMocks.settings.updateContextManagementSettings).toHaveBeenCalledWith({
			contextWarningRedThreshold: 90,
		});
	});

	it('updates local ignore pattern preferences and resets related gitignore behavior', () => {
		renderDisplayTab();

		fireEvent.click(screen.getByRole('checkbox', { name: 'Honor .gitignore' }));
		expect(hookMocks.settings.setLocalHonorGitignore).toHaveBeenCalledWith(false);

		fireEvent.click(
			screen.getByRole('button', { name: 'Reset Local Ignore Patterns to defaults' })
		);

		expect(hookMocks.settings.setLocalIgnorePatterns).toHaveBeenCalledWith(
			expect.arrayContaining(['.git', 'node_modules'])
		);
		expect(hookMocks.settings.setLocalHonorGitignore).toHaveBeenCalledWith(true);
	});
});
