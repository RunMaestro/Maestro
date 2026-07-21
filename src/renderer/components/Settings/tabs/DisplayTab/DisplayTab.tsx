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
	FontSizeSection,
	GroupChatSection,
	IconThemeSection,
	LeftSidePanelSection,
	MainHeaderPanelSection,
	MaxLogBufferSection,
	MaxOutputLinesSection,
	MessageAlignmentSection,
	ModalLayoutSection,
	TabOptionsSection,
	WindowChromeSection,
} from './components';
import { useBionifyAlgorithmState, useFontConfigurationState } from './hooks';
import type { DisplayTabProps } from './types';
import { PluginPanelSlot } from '../../../plugins/PluginPanelSlot';
import { PluginUiItemsSlot } from '../../../plugins/PluginUiItemsSlot';

export type { DisplayTabProps } from './types';

export function DisplayTab({ theme }: DisplayTabProps) {
	const settings = useSettings();
	const maestroCueEnabled = useSettingsStore((s) => s.encoreFeatures.maestroCue);
	const fontConfiguration = useFontConfigurationState();
	const bionifyAlgorithmState = useBionifyAlgorithmState({
		bionifyAlgorithm: settings.bionifyAlgorithm,
		setBionifyAlgorithm: settings.setBionifyAlgorithm,
	});

	return (
		<div className="space-y-5">
			<FontFamilySection
				theme={theme}
				fontFamily={settings.fontFamily}
				setFontFamily={settings.setFontFamily}
				fontConfiguration={fontConfiguration}
			/>
			<FontSizeSection
				theme={theme}
				fontSize={settings.fontSize}
				setFontSize={settings.setFontSize}
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
				useCmd0AsLastTab={settings.useCmd0AsLastTab}
				setUseCmd0AsLastTab={settings.setUseCmd0AsLastTab}
				showBrowserTabDomain={settings.showBrowserTabDomain}
				setShowBrowserTabDomain={settings.setShowBrowserTabDomain}
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
