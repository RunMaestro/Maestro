import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisplayTab } from '../../renderer/components/Settings/tabs/DisplayTab';
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
	useNativeTitleBar: false,
	setUseNativeTitleBar: vi.fn(),
	autoHideMenuBar: false,
	setAutoHideMenuBar: vi.fn(),
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

		fireEvent.click(screen.getByRole('button', { name: 'Bionify' }));
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

		const [documentGraphMaxNodes] = screen.getAllByRole('slider');
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

		const [, yellowSlider, redSlider] = screen.getAllByRole('slider');

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

		fireEvent.click(screen.getByRole('checkbox'));
		expect(hookMocks.settings.setLocalHonorGitignore).toHaveBeenCalledWith(false);

		fireEvent.click(screen.getByRole('button', { name: /Reset to defaults/ }));

		expect(hookMocks.settings.setLocalIgnorePatterns).toHaveBeenCalledWith(
			expect.arrayContaining(['.git', 'node_modules'])
		);
		expect(hookMocks.settings.setLocalHonorGitignore).toHaveBeenCalledWith(true);
	});
});
