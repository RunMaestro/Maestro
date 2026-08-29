import { useSettings } from '../../../../hooks';
import { useSettingsStore } from '../../../../stores/settingsStore';
import {
	AccessibilitySection,
	BionifyInfoModal,
	ContextWarningsSection,
	DocumentGraphSection,
	FileEditPreviewSection,
	FileIndexingSection,
	FontFamilySection,
	FontZoomSection,
	GroupChatSection,
	IconThemeSection,
	LeftSidePanelSection,
	MainHeaderPanelSection,
	MaxLogBufferSection,
	MaxOutputLinesSection,
	MessageAlignmentSection,
	ModalLayoutSection,
	TabOptionsSection,
	TypographyResetSection,
	WindowChromeSection,
} from './components';
import { FontSizeStepper } from '../../../ui/FontSizeStepper';
import { TYPOGRAPHY_SURFACE_SPECS, type TypographySurface } from '../../../../../shared/typography';
import type { FontConfigurationState } from './types';
import { useBionifyAlgorithmState, useFontConfigurationState } from './hooks';
import type { DisplayTabProps } from './types';
import { PluginPanelSlot } from '../../../plugins/PluginPanelSlot';
import { PluginUiItemsSlot } from '../../../plugins/PluginUiItemsSlot';

export type { DisplayTabProps } from './types';

/** Section headings. Longer than the registry labels, which the CLI also uses. */
const SURFACE_HEADINGS: Record<TypographySurface, string> = {
	interface: 'Interface Font',
	chat: 'AI Chat Font',
	terminal: 'Terminal Font',
	filePreview: 'File Preview Font',
	fileEditor: 'File Editor Font',
};

/**
 * One surface's font picker plus its size stepper.
 *
 * The prop forwarding lives here rather than in five copies, but each setting
 * id stays a literal attribute at the CALL SITEs below. The searchableSettings
 * parity guard is a STATIC scan of the source for that attribute, so building
 * it from a lookup table would make every one of these controls invisible to
 * the guard - and that guard is what stops a settings entry from silently
 * becoming unfindable by search.
 */
function SurfaceFontSection({
	theme,
	settings,
	fontConfiguration,
	surface,
}: {
	theme: DisplayTabProps['theme'];
	settings: ReturnType<typeof useSettings>;
	fontConfiguration: FontConfigurationState;
	surface: TypographySurface;
}) {
	const spec = TYPOGRAPHY_SURFACE_SPECS[surface];
	const store = settings as unknown as Record<string, number | string | undefined>;
	const baseSize = settings.fontSize;
	const storedSize = Number(store[spec.sizeKey] ?? 0);

	return (
		<FontFamilySection
			theme={theme}
			heading={SURFACE_HEADINGS[surface]}
			description={spec.description}
			fontFamily={String(store[spec.fontKey] ?? '')}
			setFontFamily={(value) => settings.setSurfaceFontFamily(surface, value)}
			fontConfiguration={fontConfiguration}
			inheritOption={spec.inheritable ? { value: '', label: 'Same as interface font' } : undefined}
			sizeControl={
				<FontSizeStepper
					theme={theme}
					value={spec.inheritable ? storedSize : baseSize}
					inheritedSize={baseSize}
					allowInherit={spec.inheritable}
					testId={`font-size-${surface}`}
					onChange={(value) => settings.setSurfaceFontSize(surface, value)}
				/>
			}
		/>
	);
}

export function DisplayTab({ theme }: DisplayTabProps) {
	const settings = useSettings();
	const maestroCueEnabled = useSettingsStore((s) => s.encoreFeatures.maestroCue);
	const fontConfiguration = useFontConfigurationState();
	const bionifyAlgorithmState = useBionifyAlgorithmState({
		bionifyAlgorithm: settings.bionifyAlgorithm,
		setBionifyAlgorithm: settings.setBionifyAlgorithm,
	});

	// Shared by the five pickers below, so their prop wiring cannot drift.
	const surfaceProps = { theme, settings, fontConfiguration };

	return (
		<div className="space-y-5">
			<TypographyResetSection
				theme={theme}
				fonts={{
					fontFamily: settings.fontFamily,
					chatFontFamily: settings.chatFontFamily,
					terminalFontFamily: settings.terminalFontFamily,
					filePreviewFontFamily: settings.filePreviewFontFamily,
					fileEditorFontFamily: settings.fileEditorFontFamily,
				}}
				sizes={{
					fontSize: settings.fontSize,
					chatFontSize: settings.chatFontSize,
					terminalFontSize: settings.terminalFontSize,
					filePreviewFontSize: settings.filePreviewFontSize,
					fileEditorFontSize: settings.fileEditorFontSize,
				}}
				onReset={settings.resetTypography}
			/>
			<div data-setting-id="display-font-family">
				<SurfaceFontSection {...surfaceProps} surface="interface" />
			</div>
			<div data-setting-id="display-chat-font-family">
				<SurfaceFontSection {...surfaceProps} surface="chat" />
			</div>
			<div data-setting-id="display-terminal-font-family">
				<SurfaceFontSection {...surfaceProps} surface="terminal" />
			</div>
			<div data-setting-id="display-file-preview-font-family">
				<SurfaceFontSection {...surfaceProps} surface="filePreview" />
			</div>
			<div data-setting-id="display-file-editor-font-family">
				<SurfaceFontSection {...surfaceProps} surface="fileEditor" />
			</div>
			<FontZoomSection
				theme={theme}
				fontZoom={settings.fontZoom}
				setFontZoom={settings.setFontZoom}
			/>
			<MaxLogBufferSection
				theme={theme}
				maxLogBuffer={settings.maxLogBuffer}
				setMaxLogBuffer={settings.setMaxLogBuffer}
			/>
			<MaxOutputLinesSection
				theme={theme}
				maxOutputLines={settings.maxOutputLines}
				setMaxOutputLines={settings.setMaxOutputLines}
			/>
			<MessageAlignmentSection
				theme={theme}
				userMessageAlignment={settings.userMessageAlignment}
				setUserMessageAlignment={settings.setUserMessageAlignment}
			/>
			<GroupChatSection
				theme={theme}
				groupChatAutoScroll={settings.groupChatAutoScroll}
				setGroupChatAutoScroll={settings.setGroupChatAutoScroll}
			/>
			<IconThemeSection
				theme={theme}
				fileExplorerIconTheme={settings.fileExplorerIconTheme}
				setFileExplorerIconTheme={settings.setFileExplorerIconTheme}
			/>
			<WindowChromeSection
				theme={theme}
				useNativeTitleBar={settings.useNativeTitleBar}
				setUseNativeTitleBar={settings.setUseNativeTitleBar}
				autoHideMenuBar={settings.autoHideMenuBar}
				setAutoHideMenuBar={settings.setAutoHideMenuBar}
			/>
			<MainHeaderPanelSection
				theme={theme}
				showAgentName={settings.showAgentName}
				setShowAgentName={settings.setShowAgentName}
				showSessionIdPill={settings.showSessionIdPill}
				setShowSessionIdPill={settings.setShowSessionIdPill}
				showSessionCostPill={settings.showSessionCostPill}
				setShowSessionCostPill={settings.setShowSessionCostPill}
			/>
			<LeftSidePanelSection
				theme={theme}
				maestroCueEnabled={maestroCueEnabled}
				showStarredSessionsSection={settings.showStarredSessionsSection}
				setShowStarredSessionsSection={settings.setShowStarredSessionsSection}
				showLeftPanelGroupMemberCount={settings.showLeftPanelGroupMemberCount}
				setShowLeftPanelGroupMemberCount={settings.setShowLeftPanelGroupMemberCount}
				leftPanelCollapsedPillsPerRow={settings.leftPanelCollapsedPillsPerRow}
				setLeftPanelCollapsedPillsPerRow={settings.setLeftPanelCollapsedPillsPerRow}
				showLeftPanelLocationPills={settings.showLeftPanelLocationPills}
				setShowLeftPanelLocationPills={settings.setShowLeftPanelLocationPills}
				showLeftPanelGitIndicator={settings.showLeftPanelGitIndicator}
				setShowLeftPanelGitIndicator={settings.setShowLeftPanelGitIndicator}
				showLeftPanelCueIndicator={settings.showLeftPanelCueIndicator}
				setShowLeftPanelCueIndicator={settings.setShowLeftPanelCueIndicator}
				showLeftPanelStartupCommandIndicator={settings.showLeftPanelStartupCommandIndicator}
				setShowLeftPanelStartupCommandIndicator={settings.setShowLeftPanelStartupCommandIndicator}
				showGroupLabelInBookmarks={settings.showGroupLabelInBookmarks}
				setShowGroupLabelInBookmarks={settings.setShowGroupLabelInBookmarks}
				showFullGroupLabelInBookmarks={settings.showFullGroupLabelInBookmarks}
				setShowFullGroupLabelInBookmarks={settings.setShowFullGroupLabelInBookmarks}
				showWorktreePill={settings.showWorktreePill}
				setShowWorktreePill={settings.setShowWorktreePill}
				showWorktreeBranchName={settings.showWorktreeBranchName}
				setShowWorktreeBranchName={settings.setShowWorktreeBranchName}
			/>
			<ModalLayoutSection theme={theme} resetModalSizes={settings.resetModalSizes} />
			<FileEditPreviewSection
				theme={theme}
				fileEditShowLineNumbers={settings.fileEditShowLineNumbers}
				setFileEditShowLineNumbers={settings.setFileEditShowLineNumbers}
				fileEditWordWrap={settings.fileEditWordWrap}
				setFileEditWordWrap={settings.setFileEditWordWrap}
				filePreviewToolbarVisibility={settings.filePreviewToolbarVisibility}
				setFilePreviewToolbarButtonVisibility={settings.setFilePreviewToolbarButtonVisibility}
			/>
			<TabOptionsSection
				theme={theme}
				showStarredInUnreadFilter={settings.showStarredInUnreadFilter}
				setShowStarredInUnreadFilter={settings.setShowStarredInUnreadFilter}
				showFilePreviewsInUnreadFilter={settings.showFilePreviewsInUnreadFilter}
				setShowFilePreviewsInUnreadFilter={settings.setShowFilePreviewsInUnreadFilter}
				showTerminalTabsInUnreadFilter={settings.showTerminalTabsInUnreadFilter}
				setShowTerminalTabsInUnreadFilter={settings.setShowTerminalTabsInUnreadFilter}
				showBrowserTabsInUnreadFilter={settings.showBrowserTabsInUnreadFilter}
				setShowBrowserTabsInUnreadFilter={settings.setShowBrowserTabsInUnreadFilter}
				useCmd0AsLastTab={settings.useCmd0AsLastTab}
				setUseCmd0AsLastTab={settings.setUseCmd0AsLastTab}
				showBrowserTabDomain={settings.showBrowserTabDomain}
				setShowBrowserTabDomain={settings.setShowBrowserTabDomain}
				showTabCountBadge={settings.showTabCountBadge}
				setShowTabCountBadge={settings.setShowTabCountBadge}
				tabBarWheelScroll={settings.tabBarWheelScroll}
				setTabBarWheelScroll={settings.setTabBarWheelScroll}
			/>
			<DocumentGraphSection
				theme={theme}
				documentGraphShowExternalLinks={settings.documentGraphShowExternalLinks}
				setDocumentGraphShowExternalLinks={settings.setDocumentGraphShowExternalLinks}
				documentGraphMaxNodes={settings.documentGraphMaxNodes}
				setDocumentGraphMaxNodes={settings.setDocumentGraphMaxNodes}
			/>
			<ContextWarningsSection
				theme={theme}
				contextManagementSettings={settings.contextManagementSettings}
				updateContextManagementSettings={settings.updateContextManagementSettings}
			/>
			<AccessibilitySection
				theme={theme}
				colorBlindMode={settings.colorBlindMode}
				setColorBlindMode={settings.setColorBlindMode}
				bionifyReadingMode={settings.bionifyReadingMode}
				setBionifyReadingMode={settings.setBionifyReadingMode}
				bionifyIntensity={settings.bionifyIntensity}
				setBionifyIntensity={settings.setBionifyIntensity}
				bionifyAlgorithmState={bionifyAlgorithmState}
			/>
			<FileIndexingSection
				theme={theme}
				localIgnorePatterns={settings.localIgnorePatterns}
				setLocalIgnorePatterns={settings.setLocalIgnorePatterns}
				localHonorGitignore={settings.localHonorGitignore}
				setLocalHonorGitignore={settings.setLocalHonorGitignore}
				fileExplorerMaxDepth={settings.fileExplorerMaxDepth}
				setFileExplorerMaxDepth={settings.setFileExplorerMaxDepth}
				fileExplorerMaxEntries={settings.fileExplorerMaxEntries}
				setFileExplorerMaxEntries={settings.setFileExplorerMaxEntries}
				sshReduceEntryCapEnabled={settings.sshReduceEntryCapEnabled}
				setSshReduceEntryCapEnabled={settings.setSshReduceEntryCapEnabled}
				sshReduceEntryCapFraction={settings.sshReduceEntryCapFraction}
				setSshReduceEntryCapFraction={settings.setSshReduceEntryCapFraction}
			/>

			{/* This neutral display-settings slot is deliberately outside plugin
			    management, consent, uninstall, and grant/revoke flows. */}
			<PluginUiItemsSlot surface="settingsSection" className="rounded-lg border p-3" />
			<PluginPanelSlot
				theme={theme}
				placement="settings"
				className="flex flex-col overflow-hidden rounded-lg border h-[440px]"
			/>

			{bionifyAlgorithmState.showInfoModal && (
				<BionifyInfoModal theme={theme} onClose={bionifyAlgorithmState.closeInfoModal} />
			)}
		</div>
	);
}
