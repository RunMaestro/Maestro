import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
	AccessibilitySection,
	ContextWarningsSection,
	DocumentGraphSection,
	FileEditPreviewSection,
	LeftSidePanelSection,
	MainHeaderPanelSection,
	TabOptionsSection,
} from '../../../../../../renderer/components/Settings/tabs/DisplayTab/components';
import type { BionifyAlgorithmState } from '../../../../../../renderer/components/Settings/tabs/DisplayTab/types';
import { TOOLBAR_BUTTON_LABELS } from '../../../../../../renderer/components/Settings/tabs/DisplayTab/utils';
import {
	FILE_PREVIEW_TOOLBAR_BUTTON_KEYS,
	type FilePreviewToolbarVisibility,
} from '../../../../../../renderer/stores/settingsStore';
import type { ContextManagementSettings } from '../../../../../../renderer/types';
import { mockTheme } from '../../../../../helpers/mockTheme';

const contextSettings: ContextManagementSettings = {
	autoGroomContexts: true,
	maxContextTokens: 100000,
	showMergePreview: true,
	groomingTimeout: 60000,
	preferredGroomingAgent: 'fastest',
	contextWarningsEnabled: true,
	contextWarningYellowThreshold: 60,
	contextWarningRedThreshold: 80,
};

function toolbarVisibility(overrides: Partial<FilePreviewToolbarVisibility> = {}) {
	return FILE_PREVIEW_TOOLBAR_BUTTON_KEYS.reduce((acc, key) => {
		acc[key] = overrides[key] ?? true;
		return acc;
	}, {} as FilePreviewToolbarVisibility);
}

function bionifyState(overrides: Partial<BionifyAlgorithmState> = {}): BionifyAlgorithmState {
	return {
		algorithmDraft: '- 0 1 1 2 0.4',
		setAlgorithmDraft: vi.fn(),
		isAlgorithmValid: true,
		commitAlgorithmDraft: vi.fn(),
		showInfoModal: false,
		openInfoModal: vi.fn(),
		closeInfoModal: vi.fn(),
		...overrides,
	};
}

describe('DisplayTab section components', () => {
	it('wires main header panel toggles', () => {
		const setShowAgentName = vi.fn();
		const setShowSessionIdPill = vi.fn();
		const setShowSessionCostPill = vi.fn();

		render(
			<MainHeaderPanelSection
				theme={mockTheme}
				showAgentName={true}
				setShowAgentName={setShowAgentName}
				showSessionIdPill={false}
				setShowSessionIdPill={setShowSessionIdPill}
				showSessionCostPill={true}
				setShowSessionCostPill={setShowSessionCostPill}
			/>
		);

		fireEvent.click(screen.getByRole('switch', { name: 'Show agent name' }));
		fireEvent.click(screen.getByRole('switch', { name: 'Show session ID pill' }));
		fireEvent.click(screen.getByRole('switch', { name: 'Show session cost pill' }));

		expect(setShowAgentName).toHaveBeenCalledWith(false);
		expect(setShowSessionIdPill).toHaveBeenCalledWith(true);
		expect(setShowSessionCostPill).toHaveBeenCalledWith(false);
	});

	it('wires left side panel toggles and collapsed pills slider', () => {
		const setters = {
			setShowStarredSessionsSection: vi.fn(),
			setShowLeftPanelGroupMemberCount: vi.fn(),
			setLeftPanelCollapsedPillsPerRow: vi.fn(),
			setShowLeftPanelLocationPills: vi.fn(),
			setShowLeftPanelGitIndicator: vi.fn(),
			setShowLeftPanelCueIndicator: vi.fn(),
			setShowLeftPanelStartupCommandIndicator: vi.fn(),
			setShowGroupLabelInBookmarks: vi.fn(),
			setShowFullGroupLabelInBookmarks: vi.fn(),
			setShowWorktreePill: vi.fn(),
			setShowWorktreeBranchName: vi.fn(),
		};

		render(
			<LeftSidePanelSection
				theme={mockTheme}
				maestroCueEnabled={false}
				showStarredSessionsSection={true}
				showLeftPanelGroupMemberCount={false}
				leftPanelCollapsedPillsPerRow={15}
				showLeftPanelLocationPills={true}
				showLeftPanelGitIndicator={false}
				showLeftPanelCueIndicator={true}
				showLeftPanelStartupCommandIndicator={false}
				showGroupLabelInBookmarks={true}
				showFullGroupLabelInBookmarks={false}
				showWorktreePill={false}
				showWorktreeBranchName={true}
				{...setters}
			/>
		);

		expect(screen.queryByText('Show Cue indicator')).not.toBeInTheDocument();

		fireEvent.click(
			screen.getByRole('switch', {
				name: 'Show Starred Sessions section in left side bar',
			})
		);
		fireEvent.click(
			screen.getByRole('switch', { name: 'Show group member count in left side bar' })
		);
		fireEvent.change(screen.getByRole('slider', { name: 'Collapsed group pills per row' }), {
			target: { value: '25' },
		});
		fireEvent.click(screen.getByRole('switch', { name: 'Show location pills in left side bar' }));
		fireEvent.click(
			screen.getByRole('switch', { name: 'Show git change indicator in left side bar' })
		);
		fireEvent.click(
			screen.getByRole('switch', {
				name: 'Show terminal startup-command indicator in left side bar',
			})
		);
		fireEvent.click(
			screen.getByRole('switch', {
				name: 'Show group label on bookmarked agents in left side bar',
			})
		);
		fireEvent.click(
			screen.getByRole('switch', {
				name: 'Show full group label on bookmarked agents in left side bar',
			})
		);
		fireEvent.click(
			screen.getByRole('switch', { name: 'Show worktree pill in left panel agent list' })
		);
		fireEvent.click(
			screen.getByRole('switch', { name: 'Show branch name in left panel agent list' })
		);

		expect(setters.setShowStarredSessionsSection).toHaveBeenCalledWith(false);
		expect(setters.setShowLeftPanelGroupMemberCount).toHaveBeenCalledWith(true);
		expect(setters.setLeftPanelCollapsedPillsPerRow).toHaveBeenCalledWith(25);
		expect(setters.setShowLeftPanelLocationPills).toHaveBeenCalledWith(false);
		expect(setters.setShowLeftPanelGitIndicator).toHaveBeenCalledWith(true);
		expect(setters.setShowLeftPanelStartupCommandIndicator).toHaveBeenCalledWith(true);
		expect(setters.setShowGroupLabelInBookmarks).toHaveBeenCalledWith(false);
		expect(setters.setShowFullGroupLabelInBookmarks).toHaveBeenCalledWith(true);
		expect(setters.setShowWorktreePill).toHaveBeenCalledWith(true);
		expect(setters.setShowWorktreeBranchName).toHaveBeenCalledWith(false);
	});

	it('shows the Cue indicator only when Cue is enabled and disables full group label when hidden', () => {
		const props = {
			theme: mockTheme,
			showStarredSessionsSection: true,
			setShowStarredSessionsSection: vi.fn(),
			showLeftPanelGroupMemberCount: false,
			setShowLeftPanelGroupMemberCount: vi.fn(),
			leftPanelCollapsedPillsPerRow: 15,
			setLeftPanelCollapsedPillsPerRow: vi.fn(),
			showLeftPanelLocationPills: true,
			setShowLeftPanelLocationPills: vi.fn(),
			showLeftPanelGitIndicator: false,
			setShowLeftPanelGitIndicator: vi.fn(),
			showLeftPanelCueIndicator: false,
			setShowLeftPanelCueIndicator: vi.fn(),
			showLeftPanelStartupCommandIndicator: false,
			setShowLeftPanelStartupCommandIndicator: vi.fn(),
			showGroupLabelInBookmarks: false,
			setShowGroupLabelInBookmarks: vi.fn(),
			showFullGroupLabelInBookmarks: true,
			setShowFullGroupLabelInBookmarks: vi.fn(),
			showWorktreePill: false,
			setShowWorktreePill: vi.fn(),
			showWorktreeBranchName: false,
			setShowWorktreeBranchName: vi.fn(),
		};

		render(<LeftSidePanelSection {...props} maestroCueEnabled />);

		fireEvent.click(screen.getByRole('switch', { name: 'Show Cue indicator in left side bar' }));
		expect(props.setShowLeftPanelCueIndicator).toHaveBeenCalledWith(true);

		expect(
			screen.getByRole('switch', {
				name: 'Show full group label on bookmarked agents in left side bar',
			})
		).toBeDisabled();
	});

	it('wires file edit toggles and every file preview toolbar visibility control', () => {
		const setFileEditShowLineNumbers = vi.fn();
		const setFileEditWordWrap = vi.fn();
		const setFilePreviewToolbarButtonVisibility = vi.fn();

		render(
			<FileEditPreviewSection
				theme={mockTheme}
				fileEditShowLineNumbers={true}
				setFileEditShowLineNumbers={setFileEditShowLineNumbers}
				fileEditWordWrap={true}
				setFileEditWordWrap={setFileEditWordWrap}
				filePreviewToolbarVisibility={toolbarVisibility()}
				setFilePreviewToolbarButtonVisibility={setFilePreviewToolbarButtonVisibility}
			/>
		);

		fireEvent.click(screen.getByRole('switch', { name: 'Show line numbers in the editor' }));
		fireEvent.click(screen.getByRole('switch', { name: 'Wrap long lines in the editor' }));
		expect(setFileEditShowLineNumbers).toHaveBeenCalledWith(false);
		expect(setFileEditWordWrap).toHaveBeenCalledWith(false);

		for (const key of FILE_PREVIEW_TOOLBAR_BUTTON_KEYS) {
			fireEvent.click(
				screen.getByRole('switch', { name: `Show ${TOOLBAR_BUTTON_LABELS[key]} button` })
			);
			expect(setFilePreviewToolbarButtonVisibility).toHaveBeenCalledWith(key, false);
		}
	});

	it('wires tab option toggles', () => {
		const setShowStarredInUnreadFilter = vi.fn();
		const setShowFilePreviewsInUnreadFilter = vi.fn();
		const setUseCmd0AsLastTab = vi.fn();
		const setShowBrowserTabDomain = vi.fn();

		render(
			<TabOptionsSection
				theme={mockTheme}
				showStarredInUnreadFilter={false}
				setShowStarredInUnreadFilter={setShowStarredInUnreadFilter}
				showFilePreviewsInUnreadFilter={false}
				setShowFilePreviewsInUnreadFilter={setShowFilePreviewsInUnreadFilter}
				useCmd0AsLastTab={false}
				setUseCmd0AsLastTab={setUseCmd0AsLastTab}
				showBrowserTabDomain={false}
				setShowBrowserTabDomain={setShowBrowserTabDomain}
			/>
		);

		fireEvent.click(
			screen.getByRole('switch', { name: 'Show starred tabs when filtering by unread' })
		);
		fireEvent.click(
			screen.getByRole('switch', { name: 'Show file preview tabs when filtering by unread' })
		);
		fireEvent.click(
			screen.getByRole('switch', { name: /Treat (Command|Ctrl)\+0 as the last tab/ })
		);
		fireEvent.click(screen.getByRole('switch', { name: 'Show domain on browser tabs' }));

		expect(setShowStarredInUnreadFilter).toHaveBeenCalledWith(true);
		expect(setShowFilePreviewsInUnreadFilter).toHaveBeenCalledWith(true);
		expect(setUseCmd0AsLastTab).toHaveBeenCalledWith(true);
		expect(setShowBrowserTabDomain).toHaveBeenCalledWith(true);
	});

	it('labels the Document Graph max nodes slider', () => {
		const setDocumentGraphShowExternalLinks = vi.fn();
		const setDocumentGraphMaxNodes = vi.fn();

		render(
			<DocumentGraphSection
				theme={mockTheme}
				documentGraphShowExternalLinks={true}
				setDocumentGraphShowExternalLinks={setDocumentGraphShowExternalLinks}
				documentGraphMaxNodes={200}
				setDocumentGraphMaxNodes={setDocumentGraphMaxNodes}
			/>
		);

		const slider = screen.getByRole('slider', { name: 'Maximum nodes to display' });
		fireEvent.change(slider, { target: { value: '500' } });

		expect(setDocumentGraphMaxNodes).toHaveBeenCalledWith(500);
	});

	it('wires context warning row, keyboard toggle, and threshold sliders', () => {
		const updateContextManagementSettings = vi.fn();
		render(
			<ContextWarningsSection
				theme={mockTheme}
				contextManagementSettings={contextSettings}
				updateContextManagementSettings={updateContextManagementSettings}
			/>
		);

		const row = screen.getByRole('button', { name: /Show context consumption warnings/ });
		fireEvent.click(row);
		fireEvent.keyDown(row, { key: 'Enter' });
		fireEvent.keyDown(row, { key: ' ' });

		const section = document.querySelector('[data-setting-id="display-context-warnings"]')!;
		const sliders = within(section as HTMLElement).getAllByRole('slider');
		fireEvent.change(sliders[0], { target: { value: '85' } });
		fireEvent.change(sliders[1], { target: { value: '50' } });

		expect(updateContextManagementSettings).toHaveBeenCalledWith({
			contextWarningsEnabled: false,
		});
		expect(updateContextManagementSettings).toHaveBeenCalledWith({
			contextWarningYellowThreshold: 85,
			contextWarningRedThreshold: 95,
		});
		expect(updateContextManagementSettings).toHaveBeenCalledWith({
			contextWarningRedThreshold: 50,
			contextWarningYellowThreshold: 40,
		});
	});

	it('disables context threshold sliders when warnings are off', () => {
		render(
			<ContextWarningsSection
				theme={mockTheme}
				contextManagementSettings={{ ...contextSettings, contextWarningsEnabled: false }}
				updateContextManagementSettings={vi.fn()}
			/>
		);

		const section = document.querySelector('[data-setting-id="display-context-warnings"]')!;
		const sliders = within(section as HTMLElement).getAllByRole('slider');
		expect(sliders[0]).toBeDisabled();
		expect(sliders[1]).toBeDisabled();
	});

	it('wires accessibility and Bionify controls', () => {
		const setColorBlindMode = vi.fn();
		const setBionifyReadingMode = vi.fn();
		const setBionifyIntensity = vi.fn();
		const state = bionifyState({
			isAlgorithmValid: false,
			algorithmDraft: '- 0 1 1',
		});

		render(
			<AccessibilitySection
				theme={mockTheme}
				colorBlindMode={false}
				setColorBlindMode={setColorBlindMode}
				bionifyReadingMode={true}
				setBionifyReadingMode={setBionifyReadingMode}
				bionifyIntensity={1}
				setBionifyIntensity={setBionifyIntensity}
				bionifyAlgorithmState={state}
			/>
		);

		fireEvent.click(screen.getByRole('switch', { name: 'Color blind mode' }));
		fireEvent.click(screen.getByRole('switch', { name: 'Bionify reading mode' }));
		fireEvent.click(screen.getByRole('button', { name: 'Strong' }));
		fireEvent.click(screen.getByRole('button', { name: 'Info' }));

		const input = screen.getByLabelText('Bionify algorithm') as HTMLInputElement;
		const blurSpy = vi.spyOn(input, 'blur');
		fireEvent.change(input, { target: { value: '+ 1 1 2 2 0.55' } });
		fireEvent.keyDown(input, { key: 'Enter' });

		expect(setColorBlindMode).toHaveBeenCalledWith(true);
		expect(setBionifyReadingMode).toHaveBeenCalledWith(false);
		expect(setBionifyIntensity).toHaveBeenCalledWith(1.35);
		expect(state.openInfoModal).toHaveBeenCalled();
		expect(state.setAlgorithmDraft).toHaveBeenCalledWith('+ 1 1 2 2 0.55');
		expect(blurSpy).toHaveBeenCalled();
		expect(screen.getByText(/Enter `\+\|-/)).toBeInTheDocument();
	});

	it('disables Bionify detail controls when Bionify is off', () => {
		render(
			<AccessibilitySection
				theme={mockTheme}
				colorBlindMode={false}
				setColorBlindMode={vi.fn()}
				bionifyReadingMode={false}
				setBionifyReadingMode={vi.fn()}
				bionifyIntensity={1}
				setBionifyIntensity={vi.fn()}
				bionifyAlgorithmState={bionifyState()}
			/>
		);

		expect(screen.getByRole('button', { name: 'Soft' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Default' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Strong' })).toBeDisabled();
		expect(screen.getByLabelText('Bionify algorithm')).toBeDisabled();
	});
});
