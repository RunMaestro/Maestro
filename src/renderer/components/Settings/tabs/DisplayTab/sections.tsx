/**
 * Display tab sections, in display order. Each one reads its own settings so
 * the tab and the Settings search can mount it independently (see
 * settingsSections.ts).
 */

import { useSettingsValues } from '../../../../hooks';
import type { SettingsSectionDef, SettingsSectionProps } from '../../settingsSections';
import {
	AccessibilitySection,
	AgentTaskListSection,
	BionifyInfoModal,
	ContextWarningsSection,
	DocumentGraphSection,
	FileEditPreviewSection,
	FileIndexingSection,
	FontsSection,
	FontZoomSection,
	GroupChatSection,
	IconThemeSection,
	ProviderModePillSection,
	LeftSidePanelSection,
	MainHeaderPanelSection,
	MaxLogBufferSection,
	MaxOutputLinesSection,
	MessageAlignmentSection,
	ModalLayoutSection,
	SavedTypographySection,
	TabOptionsSection,
	TypographyResetSection,
	WindowChromeSection,
} from './components';
import { typographySnapshotMatches } from '../../../../../shared/typographySnapshot';
import { useBionifyAlgorithmState, useFontConfigurationState } from './hooks';

/** The store read as a plain record, which the snapshot check and font pickers take. */
function asRecord(settings: object): Record<string, unknown> {
	return settings as unknown as Record<string, unknown>;
}

function TypographyReset({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<TypographyResetSection
			theme={theme}
			fonts={{
				fontFamily: settings.fontFamily,
				chatFontFamily: settings.chatFontFamily,
				terminalFontFamily: settings.terminalFontFamily,
				filePreviewFontFamily: settings.filePreviewFontFamily,
				fileEditorFontFamily: settings.fileEditorFontFamily,
				documentGraphFontFamily: settings.documentGraphFontFamily,
			}}
			sizes={{
				fontSize: settings.fontSize,
				chatFontSize: settings.chatFontSize,
				terminalFontSize: settings.terminalFontSize,
				filePreviewFontSize: settings.filePreviewFontSize,
				fileEditorFontSize: settings.fileEditorFontSize,
				documentGraphFontSize: settings.documentGraphFontSize,
			}}
			onReset={settings.resetTypography}
		/>
	);
}

function SavedTypography({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<SavedTypographySection
			theme={theme}
			snapshot={settings.typographySnapshot ?? null}
			isCurrent={typographySnapshotMatches(settings.typographySnapshot ?? null, asRecord(settings))}
			onSave={settings.saveTypographySnapshot}
			onRestore={settings.restoreTypographySnapshot}
		/>
	);
}

function Fonts({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	const fontConfiguration = useFontConfigurationState();
	return (
		<FontsSection
			theme={theme}
			settings={asRecord(settings)}
			fontConfiguration={fontConfiguration}
			setSurfaceFontFamily={settings.setSurfaceFontFamily}
			setSurfaceFontSize={settings.setSurfaceFontSize}
		/>
	);
}

function FontZoom({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<FontZoomSection
			theme={theme}
			fontZoom={settings.fontZoom}
			setFontZoom={settings.setFontZoom}
		/>
	);
}

function MaxLogBuffer({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<MaxLogBufferSection
			theme={theme}
			maxLogBuffer={settings.maxLogBuffer}
			setMaxLogBuffer={settings.setMaxLogBuffer}
		/>
	);
}

function MaxOutputLines({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<MaxOutputLinesSection
			theme={theme}
			maxOutputLines={settings.maxOutputLines}
			setMaxOutputLines={settings.setMaxOutputLines}
		/>
	);
}

function MessageAlignment({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<MessageAlignmentSection
			theme={theme}
			userMessageAlignment={settings.userMessageAlignment}
			setUserMessageAlignment={settings.setUserMessageAlignment}
		/>
	);
}

function GroupChat({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<GroupChatSection
			theme={theme}
			groupChatAutoScroll={settings.groupChatAutoScroll}
			setGroupChatAutoScroll={settings.setGroupChatAutoScroll}
		/>
	);
}

function ProviderModePill({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<ProviderModePillSection
			theme={theme}
			showProviderModePill={settings.showProviderModePill}
			setShowProviderModePill={settings.setShowProviderModePill}
		/>
	);
}

function AgentTaskList({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<AgentTaskListSection
			theme={theme}
			showAgentTaskListBar={settings.showAgentTaskListBar}
			setShowAgentTaskListBar={settings.setShowAgentTaskListBar}
			autoExpandAgentTaskListBar={settings.autoExpandAgentTaskListBar}
			setAutoExpandAgentTaskListBar={settings.setAutoExpandAgentTaskListBar}
		/>
	);
}

function IconTheme({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<IconThemeSection
			theme={theme}
			fileExplorerIconTheme={settings.fileExplorerIconTheme}
			setFileExplorerIconTheme={settings.setFileExplorerIconTheme}
		/>
	);
}

function WindowChrome({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<WindowChromeSection
			theme={theme}
			useNativeTitleBar={settings.useNativeTitleBar}
			setUseNativeTitleBar={settings.setUseNativeTitleBar}
			autoHideMenuBar={settings.autoHideMenuBar}
			setAutoHideMenuBar={settings.setAutoHideMenuBar}
		/>
	);
}

function MainHeaderPanel({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<MainHeaderPanelSection
			theme={theme}
			showAgentName={settings.showAgentName}
			setShowAgentName={settings.setShowAgentName}
			showSessionIdPill={settings.showSessionIdPill}
			setShowSessionIdPill={settings.setShowSessionIdPill}
			showSessionCostPill={settings.showSessionCostPill}
			setShowSessionCostPill={settings.setShowSessionCostPill}
		/>
	);
}

function LeftSidePanel({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<LeftSidePanelSection
			theme={theme}
			maestroCueEnabled={settings.encoreFeatures.maestroCue}
			showStarredSessionsSection={settings.showStarredSessionsSection}
			setShowStarredSessionsSection={settings.setShowStarredSessionsSection}
			showLeftPanelGroupMemberCount={settings.showLeftPanelGroupMemberCount}
			setShowLeftPanelGroupMemberCount={settings.setShowLeftPanelGroupMemberCount}
			showLeftPanelCollapsedInitials={settings.showLeftPanelCollapsedInitials}
			setShowLeftPanelCollapsedInitials={settings.setShowLeftPanelCollapsedInitials}
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
			showWorktreeProvider={settings.showWorktreeProvider}
			setShowWorktreeProvider={settings.setShowWorktreeProvider}
		/>
	);
}

function ModalLayout({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return <ModalLayoutSection theme={theme} resetModalSizes={settings.resetModalSizes} />;
}

function FileEditPreview({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<FileEditPreviewSection
			theme={theme}
			fileEditShowLineNumbers={settings.fileEditShowLineNumbers}
			setFileEditShowLineNumbers={settings.setFileEditShowLineNumbers}
			fileEditWordWrap={settings.fileEditWordWrap}
			setFileEditWordWrap={settings.setFileEditWordWrap}
			fileEditVimMode={settings.fileEditVimMode}
			setFileEditVimMode={settings.setFileEditVimMode}
			filePreviewToolbarVisibility={settings.filePreviewToolbarVisibility}
			setFilePreviewToolbarButtonVisibility={settings.setFilePreviewToolbarButtonVisibility}
		/>
	);
}

function TabOptions({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
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
	);
}

function DocumentGraph({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<DocumentGraphSection
			theme={theme}
			documentGraphShowExternalLinks={settings.documentGraphShowExternalLinks}
			setDocumentGraphShowExternalLinks={settings.setDocumentGraphShowExternalLinks}
			documentGraphConfirmClose={settings.documentGraphConfirmClose}
			setDocumentGraphConfirmClose={settings.setDocumentGraphConfirmClose}
			documentGraphMaxNodes={settings.documentGraphMaxNodes}
			setDocumentGraphMaxNodes={settings.setDocumentGraphMaxNodes}
		/>
	);
}

function ContextWarnings({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<ContextWarningsSection
			theme={theme}
			contextManagementSettings={settings.contextManagementSettings}
			updateContextManagementSettings={settings.updateContextManagementSettings}
		/>
	);
}

function Accessibility({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	const bionifyAlgorithmState = useBionifyAlgorithmState({
		bionifyAlgorithm: settings.bionifyAlgorithm,
		setBionifyAlgorithm: settings.setBionifyAlgorithm,
	});
	return (
		<>
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
			{bionifyAlgorithmState.showInfoModal && (
				<BionifyInfoModal theme={theme} onClose={bionifyAlgorithmState.closeInfoModal} />
			)}
		</>
	);
}

function FileIndexing({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
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
	);
}

export const DISPLAY_SECTIONS: readonly SettingsSectionDef[] = [
	{ key: 'typographyReset', settingIds: ['display-typography-reset'], Component: TypographyReset },
	{
		key: 'savedTypography',
		settingIds: ['display-typography-snapshot'],
		Component: SavedTypography,
	},
	{ key: 'fonts', settingIds: ['display-fonts', 'display-custom-fonts'], Component: Fonts },
	{ key: 'fontZoom', settingIds: ['display-font-zoom'], Component: FontZoom },
	{ key: 'maxLogBuffer', settingIds: ['display-max-log-buffer'], Component: MaxLogBuffer },
	{ key: 'maxOutputLines', settingIds: ['display-max-output-lines'], Component: MaxOutputLines },
	{
		key: 'messageAlignment',
		settingIds: ['display-message-alignment'],
		Component: MessageAlignment,
	},
	{ key: 'groupChat', settingIds: ['display-group-chat-auto-scroll'], Component: GroupChat },
	{
		key: 'providerModePill',
		settingIds: ['display-provider-mode-pill'],
		Component: ProviderModePill,
	},
	{
		key: 'agentTaskList',
		settingIds: ['display-agent-task-list-bar', 'display-agent-task-list-auto-expand'],
		Component: AgentTaskList,
	},
	{ key: 'iconTheme', settingIds: ['display-icon-theme'], Component: IconTheme },
	{ key: 'windowChrome', settingIds: ['display-window-chrome'], Component: WindowChrome },
	{ key: 'mainHeaderPanel', settingIds: ['display-main-header-panel'], Component: MainHeaderPanel },
	{
		key: 'leftSidePanel',
		settingIds: [
			'display-left-side-panel',
			'display-left-panel-starred-sessions',
			'display-left-panel-collapsed-initials',
			'display-left-panel-group-label',
		],
		Component: LeftSidePanel,
	},
	{ key: 'modalLayout', settingIds: ['display-modal-layout'], Component: ModalLayout },
	{ key: 'fileEditPreview', settingIds: ['display-file-edit-preview'], Component: FileEditPreview },
	{ key: 'tabOptions', settingIds: ['display-tab-filtering'], Component: TabOptions },
	{ key: 'documentGraph', settingIds: ['display-document-graph'], Component: DocumentGraph },
	{ key: 'contextWarnings', settingIds: ['display-context-warnings'], Component: ContextWarnings },
	{
		key: 'accessibility',
		settingIds: ['display-colorblind-mode', 'display-bionify-reading-mode'],
		Component: Accessibility,
	},
	{ key: 'fileIndexing', settingIds: ['display-file-indexing'], Component: FileIndexing },
];
