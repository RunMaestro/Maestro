/**
 * DisplayTab - Display settings tab for SettingsModal
 *
 * Contains: Font Configuration, Font Size, Max Log Buffer,
 * Max Output Lines, Message Alignment, Window Chrome, Document Graph,
 * Context Window Warnings, Local Ignore Patterns.
 */

import { useState } from 'react';
import {
	Accessibility,
	ALargeSmall,
	AlignHorizontalJustifyCenter,
	AlertTriangle,
	AppWindow,
	Database,
	Eye,
	FileText,
	FolderSearch,
	HelpCircle,
	WrapText,
	ListFilter,
	PanelTop,
	PanelLeft,
	Palette,
	Sparkles,
} from 'lucide-react';
import {
	FILE_PREVIEW_TOOLBAR_BUTTON_KEYS,
	type FilePreviewToolbarButton,
} from '../../../stores/settingsStore';
import { useSettings } from '../../../hooks';
import { useSettingsStore } from '../../../stores/settingsStore';
import type { Theme } from '../../../types';
import { ToggleButtonGroup } from '../../ToggleButtonGroup';
import { WorktreePill } from '../../ui/WorktreePill';
import { FontConfigurationPanel } from '../../FontConfigurationPanel';
import { IgnorePatternsSection } from '../IgnorePatternsSection';
import { FilePanelSettingsSection } from '../FilePanelSettingsSection';
import { SettingsSectionHeading } from '../SettingsSectionHeading';
import { DEFAULT_LOCAL_IGNORE_PATTERNS } from '../../../stores/settingsStore';
import { logger } from '../../../utils/logger';
import { Modal } from '../../ui/Modal';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import { DEFAULT_BIONIFY_ALGORITHM } from '../../../utils/bionifyReadingMode';
import { isMacOSPlatform } from '../../../utils/platformUtils';

const BIONIFY_ALGORITHM_PATTERN = /^[+-](\s+\d+){4}\s+(?:0(?:\.\d+)?|1(?:\.0+)?)$/;

const TOOLBAR_BUTTON_LABELS: Record<FilePreviewToolbarButton, string> = {
	save: 'Save',
	wordWrap: 'Word wrap',
	remoteImages: 'Show remote images',
	htmlRender: 'Render HTML',
	previewTier: 'Preview tier chip',
	editToggle: 'Edit / preview toggle',
	editImage: 'Edit image',
	copyContent: 'Copy content',
	publishGist: 'Publish as gist',
	documentGraph: 'Document graph',
	openInBrowser: 'Open in Maestro browser',
	openInDefault: 'Open in default app',
	copyPath: 'Copy file path',
};

export interface DisplayTabProps {
	theme: Theme;
}

export function DisplayTab({ theme }: DisplayTabProps) {
	const {
		fontFamily,
		setFontFamily,
		fontSize,
		setFontSize,
		maxLogBuffer,
		setMaxLogBuffer,
		maxOutputLines,
		setMaxOutputLines,
		colorBlindMode,
		setColorBlindMode,
		bionifyReadingMode,
		setBionifyReadingMode,
		bionifyIntensity,
		setBionifyIntensity,
		bionifyAlgorithm,
		setBionifyAlgorithm,
		userMessageAlignment,
		setUserMessageAlignment,
		fileExplorerIconTheme,
		setFileExplorerIconTheme,
		showStarredInUnreadFilter,
		setShowStarredInUnreadFilter,
		showFilePreviewsInUnreadFilter,
		setShowFilePreviewsInUnreadFilter,
		useCmd0AsLastTab,
		setUseCmd0AsLastTab,
		showBrowserTabDomain,
		setShowBrowserTabDomain,
		useNativeTitleBar,
		setUseNativeTitleBar,
		autoHideMenuBar,
		setAutoHideMenuBar,
		showAgentName,
		setShowAgentName,
		showSessionIdPill,
		setShowSessionIdPill,
		showSessionCostPill,
		setShowSessionCostPill,
		showWorktreePill,
		setShowWorktreePill,
		showWorktreeBranchName,
		setShowWorktreeBranchName,
		showStarredSessionsSection,
		setShowStarredSessionsSection,
		showLeftPanelGroupMemberCount,
		setShowLeftPanelGroupMemberCount,
		leftPanelCollapsedPillsPerRow,
		setLeftPanelCollapsedPillsPerRow,
		showLeftPanelLocationPills,
		setShowLeftPanelLocationPills,
		showLeftPanelGitIndicator,
		setShowLeftPanelGitIndicator,
		showLeftPanelCueIndicator,
		setShowLeftPanelCueIndicator,
		showLeftPanelStartupCommandIndicator,
		setShowLeftPanelStartupCommandIndicator,
		showGroupLabelInBookmarks,
		setShowGroupLabelInBookmarks,
		showFullGroupLabelInBookmarks,
		setShowFullGroupLabelInBookmarks,
		fileEditWordWrap,
		setFileEditWordWrap,
		fileEditShowLineNumbers,
		setFileEditShowLineNumbers,
		filePreviewToolbarVisibility,
		setFilePreviewToolbarButtonVisibility,
		documentGraphShowExternalLinks,
		setDocumentGraphShowExternalLinks,
		documentGraphMaxNodes,
		setDocumentGraphMaxNodes,
		contextManagementSettings,
		updateContextManagementSettings,
		localIgnorePatterns,
		setLocalIgnorePatterns,
		localHonorGitignore,
		setLocalHonorGitignore,
		fileExplorerMaxDepth,
		setFileExplorerMaxDepth,
		fileExplorerMaxEntries,
		setFileExplorerMaxEntries,
		sshReduceEntryCapEnabled,
		setSshReduceEntryCapEnabled,
		sshReduceEntryCapFraction,
		setSshReduceEntryCapFraction,
	} = useSettings();

	const maestroCueEnabled = useSettingsStore((s) => s.encoreFeatures.maestroCue);

	const [systemFonts, setSystemFonts] = useState<string[]>([]);
	const [customFonts, setCustomFonts] = useState<string[]>([]);
	const [fontLoading, setFontLoading] = useState(false);
	const [fontsLoaded, setFontsLoaded] = useState(false);
	const [showBionifyInfoModal, setShowBionifyInfoModal] = useState(false);
	const [bionifyAlgorithmDraft, setBionifyAlgorithmDraft] = useState(
		bionifyAlgorithm ?? DEFAULT_BIONIFY_ALGORITHM
	);

	const isBionifyAlgorithmValid = BIONIFY_ALGORITHM_PATTERN.test(bionifyAlgorithmDraft.trim());

	const commitBionifyAlgorithmDraft = () => {
		if (
			isBionifyAlgorithmValid &&
			bionifyAlgorithmDraft.trim() !== (bionifyAlgorithm ?? DEFAULT_BIONIFY_ALGORITHM)
		) {
			setBionifyAlgorithm(bionifyAlgorithmDraft.trim());
		}
	};

	const loadFonts = async () => {
		if (fontsLoaded) return; // Don't reload if already loaded

		setFontLoading(true);
		try {
			const detected = await window.maestro.fonts.detect();
			setSystemFonts(detected);

			const savedCustomFonts = (await window.maestro.settings.get('customFonts')) as
				string[] | undefined;
			if (savedCustomFonts && Array.isArray(savedCustomFonts)) {
				setCustomFonts(savedCustomFonts);
			}
			setFontsLoaded(true);
		} catch (error) {
			logger.error('Failed to load fonts:', undefined, error);
		} finally {
			setFontLoading(false);
		}
	};

	const handleFontInteraction = () => {
		if (!fontsLoaded && !fontLoading) {
			loadFonts();
		}
	};

	const addCustomFont = (font: string) => {
		if (font && !customFonts.includes(font)) {
			const newCustomFonts = [...customFonts, font];
			setCustomFonts(newCustomFonts);
			window.maestro.settings.set('customFonts', newCustomFonts);
		}
	};

	const removeCustomFont = (font: string) => {
		const newCustomFonts = customFonts.filter((f) => f !== font);
		setCustomFonts(newCustomFonts);
		window.maestro.settings.set('customFonts', newCustomFonts);
	};

	return (
		<div className="space-y-5">
			{/* Font Family */}
			<div data-setting-id="display-font-family">
				<FontConfigurationPanel
					fontFamily={fontFamily}
					setFontFamily={setFontFamily}
					systemFonts={systemFonts}
					fontsLoaded={fontsLoaded}
					fontLoading={fontLoading}
					customFonts={customFonts}
					onAddCustomFont={addCustomFont}
					onRemoveCustomFont={removeCustomFont}
					onFontInteraction={handleFontInteraction}
					theme={theme}
				/>
			</div>

			{/* Font Size */}
			<div data-setting-id="display-font-size">
				<SettingsSectionHeading icon={ALargeSmall}>Font Size</SettingsSectionHeading>
				<ToggleButtonGroup
					options={[
						{ value: 12, label: 'Small' },
						{ value: 14, label: 'Medium' },
						{ value: 16, label: 'Large' },
						{ value: 18, label: 'X-Large' },
					]}
					value={fontSize}
					onChange={setFontSize}
					theme={theme}
				/>
			</div>

			{/* Max Log Buffer */}
			<div data-setting-id="display-max-log-buffer">
				<SettingsSectionHeading icon={Database}>Maximum Log Buffer</SettingsSectionHeading>
				<ToggleButtonGroup
					options={[1000, 5000, 10000, 25000]}
					value={maxLogBuffer}
					onChange={setMaxLogBuffer}
					theme={theme}
				/>
				<p className="text-xs opacity-50 mt-2">
					Maximum number of entries to retain for history and system log viewer. Older entries are
					automatically discarded as new ones arrive.
				</p>
			</div>

			{/* Max Output Lines */}
			<div data-setting-id="display-max-output-lines">
				<SettingsSectionHeading icon={WrapText}>
					Max Output Lines per Response
				</SettingsSectionHeading>
				<ToggleButtonGroup
					options={[
						{ value: 15 },
						{ value: 25 },
						{ value: 50 },
						{ value: 100 },
						{ value: Infinity, label: 'All' },
					]}
					value={maxOutputLines}
					onChange={setMaxOutputLines}
					theme={theme}
				/>
				<p className="text-xs opacity-50 mt-2">
					Long outputs will be collapsed into a scrollable window. Set to "All" to always show full
					output.
				</p>
			</div>

			{/* Message Alignment */}
			<div data-setting-id="display-message-alignment">
				<SettingsSectionHeading icon={AlignHorizontalJustifyCenter}>
					User Message Alignment
				</SettingsSectionHeading>
				<ToggleButtonGroup
					options={[
						{ value: 'left', label: 'Left' },
						{ value: 'right', label: 'Right' },
					]}
					value={userMessageAlignment ?? 'right'}
					onChange={setUserMessageAlignment}
					theme={theme}
				/>
				<p className="text-xs opacity-50 mt-2">
					Position your messages on the left or right side of the chat. AI responses appear on the
					opposite side.
				</p>
			</div>

			<div data-setting-id="display-icon-theme">
				<SettingsSectionHeading icon={Palette}>Files Pane Icon Theme</SettingsSectionHeading>
				<ToggleButtonGroup
					options={[
						{ value: 'default', label: 'Default' },
						{ value: 'rich', label: 'Rich' },
					]}
					value={fileExplorerIconTheme}
					onChange={setFileExplorerIconTheme}
					theme={theme}
				/>
				<p className="text-xs opacity-50 mt-2">
					Rich uses Material Icon Theme style file and folder SVGs in the Files pane. Default
					preserves Maestro&apos;s current icon behavior.
				</p>
			</div>

			{/* Window Chrome Settings */}
			<div data-setting-id="display-window-chrome">
				<SettingsSectionHeading icon={AppWindow}>Window Chrome</SettingsSectionHeading>
				<div
					className="p-3 rounded border space-y-3"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgMain,
					}}
				>
					{/* Native Title Bar */}
					<div className="flex items-center justify-between">
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Use native title bar
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								Use the OS native title bar instead of Maestro&apos;s custom title bar. Requires
								restart.
							</p>
						</div>
						<button
							onClick={() => setUseNativeTitleBar(!useNativeTitleBar)}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
							tabIndex={0}
							style={{
								backgroundColor: useNativeTitleBar ? theme.colors.accent : theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={useNativeTitleBar}
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									useNativeTitleBar ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Auto-Hide Menu Bar */}
					<div
						className="flex items-center justify-between pt-3 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Auto-hide menu bar
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								Hide the application menu bar. Press Alt to toggle visibility. Applies to Windows
								and Linux. Requires restart.
							</p>
						</div>
						<button
							onClick={() => setAutoHideMenuBar(!autoHideMenuBar)}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
							tabIndex={0}
							style={{
								backgroundColor: autoHideMenuBar ? theme.colors.accent : theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={autoHideMenuBar}
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									autoHideMenuBar ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>
				</div>
			</div>

			{/* Main Header Panel */}
			<div data-setting-id="display-main-header-panel">
				<SettingsSectionHeading icon={PanelTop}>Main Header Panel</SettingsSectionHeading>
				<div
					className="p-3 rounded border space-y-3"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgMain,
					}}
				>
					{/* Show agent name */}
					<div className="flex items-center justify-between">
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Show agent name
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								Display the agent name in the main header.
							</p>
						</div>
						<button
							onClick={() => setShowAgentName(!showAgentName)}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
							tabIndex={0}
							style={{
								backgroundColor: showAgentName ? theme.colors.accent : theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={showAgentName}
							aria-label="Show agent name"
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									showAgentName ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Show session ID pill */}
					<div
						className="flex items-center justify-between pt-3 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Show session ID pill
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								Display the provider session ID pill (short hash, e.g. &quot;B778BF42&quot;) in the
								main header. Click the pill to copy the full ID.
							</p>
						</div>
						<button
							onClick={() => setShowSessionIdPill(!showSessionIdPill)}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
							tabIndex={0}
							style={{
								backgroundColor: showSessionIdPill ? theme.colors.accent : theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={showSessionIdPill}
							aria-label="Show session ID pill"
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									showSessionIdPill ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Show session cost pill */}
					<div
						className="flex items-center justify-between pt-3 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Show session cost pill
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								Display the per-session running cost (e.g. &quot;$21.33&quot;) in the main header.
							</p>
						</div>
						<button
							onClick={() => setShowSessionCostPill(!showSessionCostPill)}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
							tabIndex={0}
							style={{
								backgroundColor: showSessionCostPill
									? theme.colors.accent
									: theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={showSessionCostPill}
							aria-label="Show session cost pill"
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									showSessionCostPill ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>
				</div>
			</div>

			{/* Left Side Panel */}
			<div data-setting-id="display-left-side-panel">
				<SettingsSectionHeading icon={PanelLeft}>Left Side Panel</SettingsSectionHeading>
				<div
					className="p-3 rounded border space-y-3"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgMain,
					}}
				>
					{/* Show Starred Sessions section */}
					<div
						className="flex items-center justify-between"
						data-setting-id="display-left-panel-starred-sessions"
					>
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Show Starred Sessions section
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								Display a Starred Sessions section at the top of the left side bar listing every
								starred AI tab across all agents.
							</p>
						</div>
						<button
							onClick={() => setShowStarredSessionsSection(!showStarredSessionsSection)}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
							tabIndex={0}
							style={{
								backgroundColor: showStarredSessionsSection
									? theme.colors.accent
									: theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={showStarredSessionsSection}
							aria-label="Show Starred Sessions section in left side bar"
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									showStarredSessionsSection ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Show group member count */}
					<div
						className="flex items-center justify-between pt-3 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Show group member count
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								Display the number of agents in parentheses after each group name in the left side
								bar (e.g. &quot;UNGROUPED AGENTS (24)&quot;).
							</p>
						</div>
						<button
							onClick={() => setShowLeftPanelGroupMemberCount(!showLeftPanelGroupMemberCount)}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
							tabIndex={0}
							style={{
								backgroundColor: showLeftPanelGroupMemberCount
									? theme.colors.accent
									: theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={showLeftPanelGroupMemberCount}
							aria-label="Show group member count in left side bar"
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									showLeftPanelGroupMemberCount ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Collapsed pills per row */}
					<div className="pt-3 border-t" style={{ borderColor: theme.colors.border }}>
						<p className="text-sm" style={{ color: theme.colors.textMain }}>
							Collapsed group pills per row
						</p>
						<p className="text-xs opacity-50 mt-0.5 mb-2">
							When a group is collapsed, its agents render as a row of activity pills. Pills wrap to
							a new row once this many are shown, so large groups stay readable instead of
							condensing into invisible slivers.
						</p>
						<div className="flex items-center gap-3">
							<input
								type="range"
								min={5}
								max={50}
								step={5}
								value={leftPanelCollapsedPillsPerRow}
								onChange={(e) => setLeftPanelCollapsedPillsPerRow(Number(e.target.value))}
								className="flex-1 h-2 rounded-lg appearance-none cursor-pointer"
								style={{
									background: `linear-gradient(to right, ${theme.colors.accent} 0%, ${theme.colors.accent} ${((leftPanelCollapsedPillsPerRow - 5) / 45) * 100}%, ${theme.colors.bgActivity} ${((leftPanelCollapsedPillsPerRow - 5) / 45) * 100}%, ${theme.colors.bgActivity} 100%)`,
								}}
								aria-label="Collapsed group pills per row"
							/>
							<span
								className="text-sm font-mono w-8 text-right"
								style={{ color: theme.colors.textMain }}
							>
								{leftPanelCollapsedPillsPerRow}
							</span>
						</div>
					</div>

					{/* Show location pills */}
					<div
						className="flex items-center justify-between pt-3 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Show location pills
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								Display the REMOTE / LOCAL / GIT badges next to each agent in the left side bar.
								Turn off to simplify the agent rows.
							</p>
						</div>
						<button
							onClick={() => setShowLeftPanelLocationPills(!showLeftPanelLocationPills)}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
							tabIndex={0}
							style={{
								backgroundColor: showLeftPanelLocationPills
									? theme.colors.accent
									: theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={showLeftPanelLocationPills}
							aria-label="Show location pills in left side bar"
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									showLeftPanelLocationPills ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Show git change indicator */}
					<div
						className="flex items-center justify-between pt-3 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Show git change indicator
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								Display the branch icon and dirty file count next to git repository agents.
							</p>
						</div>
						<button
							onClick={() => setShowLeftPanelGitIndicator(!showLeftPanelGitIndicator)}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
							tabIndex={0}
							style={{
								backgroundColor: showLeftPanelGitIndicator
									? theme.colors.accent
									: theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={showLeftPanelGitIndicator}
							aria-label="Show git change indicator in left side bar"
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									showLeftPanelGitIndicator ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Show Cue indicator - hidden entirely when the Cue Encore Feature is off */}
					{maestroCueEnabled && (
						<div
							className="flex items-center justify-between pt-3 border-t"
							style={{ borderColor: theme.colors.border }}
						>
							<div>
								<p className="text-sm" style={{ color: theme.colors.textMain }}>
									Show Cue indicator
								</p>
								<p className="text-xs opacity-50 mt-0.5">
									Display the lightning-bolt indicator next to agents with active Maestro Cue
									subscriptions.
								</p>
							</div>
							<button
								onClick={() => setShowLeftPanelCueIndicator(!showLeftPanelCueIndicator)}
								className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
								tabIndex={0}
								style={{
									backgroundColor: showLeftPanelCueIndicator
										? theme.colors.accent
										: theme.colors.bgActivity,
								}}
								role="switch"
								aria-checked={showLeftPanelCueIndicator}
								aria-label="Show Cue indicator in left side bar"
							>
								<span
									className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
										showLeftPanelCueIndicator ? 'translate-x-5' : 'translate-x-0.5'
									}`}
								/>
							</button>
						</div>
					)}

					{/* Show terminal startup-command indicator */}
					<div
						className="flex items-center justify-between pt-3 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Show terminal startup-command indicator
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								Display the <span className="font-mono">{'>_'}</span> glyph next to agents that have
								at least one terminal tab with a saved startup command.
							</p>
						</div>
						<button
							onClick={() =>
								setShowLeftPanelStartupCommandIndicator(!showLeftPanelStartupCommandIndicator)
							}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
							tabIndex={0}
							style={{
								backgroundColor: showLeftPanelStartupCommandIndicator
									? theme.colors.accent
									: theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={showLeftPanelStartupCommandIndicator}
							aria-label="Show terminal startup-command indicator in left side bar"
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									showLeftPanelStartupCommandIndicator ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Show group label on bookmarked agents */}
					<div
						className="flex items-center justify-between pt-3 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Show group label on bookmarked agents
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								Display the group badge (e.g. <span className="font-mono">CCS</span>) next to
								bookmarked agents. Turn off to hide the group pill entirely.
							</p>
						</div>
						<button
							onClick={() => setShowGroupLabelInBookmarks(!showGroupLabelInBookmarks)}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
							tabIndex={0}
							style={{
								backgroundColor: showGroupLabelInBookmarks
									? theme.colors.accent
									: theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={showGroupLabelInBookmarks}
							aria-label="Show group label on bookmarked agents in left side bar"
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									showGroupLabelInBookmarks ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Show full group label on bookmarked agents (sub-option of the group
					    label toggle above; dimmed and disabled when the pill is hidden). */}
					<div
						className={`flex items-center justify-between pt-2 pl-4 transition-opacity ${
							showGroupLabelInBookmarks ? '' : 'opacity-40'
						}`}
					>
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Show full group label on bookmarked agents
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								Display the full group name (e.g.{' '}
								<span className="font-mono">[2] CASE/CONTENT-SYSTEM</span>) instead of the
								abbreviated badge (e.g. <span className="font-mono">CCS</span>) next to bookmarked
								agents. Long names are truncated with the full value on hover.
							</p>
						</div>
						<button
							onClick={() => setShowFullGroupLabelInBookmarks(!showFullGroupLabelInBookmarks)}
							disabled={!showGroupLabelInBookmarks}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none disabled:cursor-not-allowed"
							tabIndex={showGroupLabelInBookmarks ? 0 : -1}
							style={{
								backgroundColor: showFullGroupLabelInBookmarks
									? theme.colors.accent
									: theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={showFullGroupLabelInBookmarks}
							aria-label="Show full group label on bookmarked agents in left side bar"
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									showFullGroupLabelInBookmarks ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Show WORKTREE pill */}
					<div
						className="flex items-center justify-between pt-3 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						<div>
							<p
								className="text-sm flex items-center gap-2"
								style={{ color: theme.colors.textMain }}
							>
								Show <WorktreePill theme={theme} /> pill in subagent list
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								Display the worktree badge next to worktree child agents in the left panel.
							</p>
						</div>
						<button
							onClick={() => setShowWorktreePill(!showWorktreePill)}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
							tabIndex={0}
							style={{
								backgroundColor: showWorktreePill ? theme.colors.accent : theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={showWorktreePill}
							aria-label="Show worktree pill in left panel agent list"
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									showWorktreePill ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Show branch name */}
					<div
						className="flex items-center justify-between pt-3 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Show worktree branch name in subagent list
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								Display the worktree branch name beneath the agent name in the left panel.
							</p>
						</div>
						<button
							onClick={() => setShowWorktreeBranchName(!showWorktreeBranchName)}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
							tabIndex={0}
							style={{
								backgroundColor: showWorktreeBranchName
									? theme.colors.accent
									: theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={showWorktreeBranchName}
							aria-label="Show branch name in left panel agent list"
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									showWorktreeBranchName ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>
				</div>
			</div>

			{/* File Edit & Preview */}
			<div data-setting-id="display-file-edit-preview">
				<SettingsSectionHeading icon={FileText}>File Edit & Preview</SettingsSectionHeading>
				<div
					className="p-3 rounded border space-y-3"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgMain,
					}}
				>
					{/* Line numbers */}
					<div className="flex items-center justify-between">
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Show line numbers in the editor
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								Render a line-number gutter on the left edge of the file editor. Right-clicking a
								line copies a maestro:// deep link to that line.
							</p>
						</div>
						<button
							onClick={() => setFileEditShowLineNumbers(!fileEditShowLineNumbers)}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
							tabIndex={0}
							style={{
								backgroundColor: fileEditShowLineNumbers
									? theme.colors.accent
									: theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={fileEditShowLineNumbers}
							aria-label="Show line numbers in the editor"
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									fileEditShowLineNumbers ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Word wrap default */}
					<div
						className="flex items-center justify-between pt-3 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Wrap long lines in the editor
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								When on, long lines wrap at whitespace. When off, the editor scrolls horizontally.
								Toggle live from the editor toolbar.
							</p>
						</div>
						<button
							onClick={() => setFileEditWordWrap(!fileEditWordWrap)}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
							tabIndex={0}
							style={{
								backgroundColor: fileEditWordWrap ? theme.colors.accent : theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={fileEditWordWrap}
							aria-label="Wrap long lines in the editor"
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									fileEditWordWrap ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Toolbar button visibility */}
					<div className="pt-3 border-t" style={{ borderColor: theme.colors.border }}>
						<p className="text-sm" style={{ color: theme.colors.textMain }}>
							Toolbar buttons
						</p>
						<p className="text-xs opacity-50 mt-0.5">
							Hide buttons you never use. Hidden actions stay reachable via command palette and
							keyboard shortcuts.
						</p>
						<div className="grid grid-cols-2 gap-2 mt-3">
							{FILE_PREVIEW_TOOLBAR_BUTTON_KEYS.map((key) => {
								const label = TOOLBAR_BUTTON_LABELS[key];
								const enabled = filePreviewToolbarVisibility[key];
								return (
									<label
										key={key}
										className="flex items-center justify-between gap-2 px-2 py-1 rounded cursor-pointer hover:bg-white/5 transition-colors"
									>
										<span className="text-xs" style={{ color: theme.colors.textMain }}>
											{label}
										</span>
										<button
											type="button"
											onClick={() =>
												setFilePreviewToolbarButtonVisibility(
													key as FilePreviewToolbarButton,
													!enabled
												)
											}
											className="relative w-8 h-4 rounded-full transition-colors flex-shrink-0 outline-none"
											tabIndex={0}
											style={{
												backgroundColor: enabled ? theme.colors.accent : theme.colors.bgActivity,
											}}
											role="switch"
											aria-checked={enabled}
											aria-label={`Show ${label} button`}
										>
											<span
												className={`absolute left-0 top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
													enabled ? 'translate-x-4' : 'translate-x-0.5'
												}`}
											/>
										</button>
									</label>
								);
							})}
						</div>
					</div>
				</div>
			</div>

			{/* Starred Tabs in Unread Filter */}
			<div data-setting-id="display-tab-filtering">
				<SettingsSectionHeading icon={ListFilter}>Tab Options</SettingsSectionHeading>
				<div
					className="p-3 rounded border space-y-3"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgMain,
					}}
				>
					<div className="flex items-center justify-between">
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Show starred tabs when filtering by unread
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								When the unread filter is active, starred tabs remain visible even if they have no
								unread messages.
							</p>
						</div>
						<button
							onClick={() => setShowStarredInUnreadFilter(!showStarredInUnreadFilter)}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
							tabIndex={0}
							style={{
								backgroundColor: showStarredInUnreadFilter
									? theme.colors.accent
									: theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={showStarredInUnreadFilter}
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									showStarredInUnreadFilter ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Show File Preview Tabs in Unread Filter */}
					<div
						className="flex items-center justify-between pt-3 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Show file preview tabs when filtering by unread
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								When the unread filter is active, file preview tabs remain visible instead of being
								hidden.
							</p>
						</div>
						<button
							onClick={() => setShowFilePreviewsInUnreadFilter(!showFilePreviewsInUnreadFilter)}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
							tabIndex={0}
							style={{
								backgroundColor: showFilePreviewsInUnreadFilter
									? theme.colors.accent
									: theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={showFilePreviewsInUnreadFilter}
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									showFilePreviewsInUnreadFilter ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Treat Command+0 as Last Tab */}
					<div
						className="flex items-center justify-between pt-3 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Treat {isMacOSPlatform() ? 'Command' : 'Ctrl'}+0 as the last tab
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								Maestro-style: {isMacOSPlatform() ? 'Command' : 'Ctrl'}+1-9 jump to tabs 1-9, and{' '}
								{isMacOSPlatform() ? 'Command' : 'Ctrl'}+0 jumps to the last tab. Disable to use
								browser-style: {isMacOSPlatform() ? 'Command' : 'Ctrl'}+1-8 jump to tabs 1-8, and{' '}
								{isMacOSPlatform() ? 'Command' : 'Ctrl'}+9 jumps to the last tab.
							</p>
						</div>
						<button
							onClick={() => setUseCmd0AsLastTab(!useCmd0AsLastTab)}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
							tabIndex={0}
							style={{
								backgroundColor: useCmd0AsLastTab ? theme.colors.accent : theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={useCmd0AsLastTab}
							aria-label="Treat Command+0 as the last tab"
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									useCmd0AsLastTab ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Show Domain Pill on Browser Tabs */}
					<div
						className="flex items-center justify-between pt-3 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Show domain on browser tabs
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								Display a small domain pill (e.g. www.google.com) next to the page title on browser
								tabs. Disable to hide it.
							</p>
						</div>
						<button
							onClick={() => setShowBrowserTabDomain(!showBrowserTabDomain)}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
							tabIndex={0}
							style={{
								backgroundColor: showBrowserTabDomain
									? theme.colors.accent
									: theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={showBrowserTabDomain}
							aria-label="Show domain on browser tabs"
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									showBrowserTabDomain ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>
				</div>
			</div>

			{/* Document Graph Settings */}
			<div data-setting-id="display-document-graph">
				<SettingsSectionHeading icon={Sparkles}>Document Graph</SettingsSectionHeading>
				<div
					className="p-3 rounded border space-y-3"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					{/* Show External Links */}
					<div className="flex items-center justify-between">
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Show external links by default
							</p>
							<p className="text-xs opacity-50 mt-0.5">
								Display external website links as nodes. Can be toggled in the graph view.
							</p>
						</div>
						<button
							onClick={() => setDocumentGraphShowExternalLinks(!documentGraphShowExternalLinks)}
							className="relative w-10 h-5 rounded-full transition-colors"
							style={{
								backgroundColor: documentGraphShowExternalLinks
									? theme.colors.accent
									: theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={documentGraphShowExternalLinks}
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									documentGraphShowExternalLinks ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Max Nodes */}
					<div>
						<div className="block text-xs opacity-60 mb-2">Maximum nodes to display</div>
						<div className="flex items-center gap-3">
							<input
								type="range"
								min={50}
								max={1000}
								step={50}
								value={documentGraphMaxNodes}
								onChange={(e) => setDocumentGraphMaxNodes(Number(e.target.value))}
								aria-label="Maximum nodes to display"
								className="flex-1 h-2 rounded-lg appearance-none cursor-pointer"
								style={{
									background: `linear-gradient(to right, ${theme.colors.accent} 0%, ${theme.colors.accent} ${((documentGraphMaxNodes - 50) / 950) * 100}%, ${theme.colors.bgActivity} ${((documentGraphMaxNodes - 50) / 950) * 100}%, ${theme.colors.bgActivity} 100%)`,
								}}
							/>
							<span
								className="text-sm font-mono w-12 text-right"
								style={{ color: theme.colors.textMain }}
							>
								{documentGraphMaxNodes}
							</span>
						</div>
						<p className="text-xs opacity-50 mt-1">
							Limits initial graph size for performance. Use &quot;Load more&quot; to show
							additional nodes.
						</p>
					</div>
				</div>
			</div>

			{/* Context Window Warnings */}
			<div data-setting-id="display-context-warnings">
				<SettingsSectionHeading icon={AlertTriangle}>
					Context Window Warnings
				</SettingsSectionHeading>
				<div
					className="p-3 rounded border space-y-3"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					{/* Enable/Disable Toggle */}
					<div
						className="flex items-center justify-between cursor-pointer"
						onClick={() =>
							updateContextManagementSettings({
								contextWarningsEnabled: !contextManagementSettings.contextWarningsEnabled,
							})
						}
						role="button"
						tabIndex={0}
						onKeyDown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								updateContextManagementSettings({
									contextWarningsEnabled: !contextManagementSettings.contextWarningsEnabled,
								});
							}
						}}
					>
						<div className="flex-1 pr-3">
							<div className="font-medium" style={{ color: theme.colors.textMain }}>
								Show context consumption warnings
							</div>
							<div className="text-xs opacity-50 mt-0.5" style={{ color: theme.colors.textDim }}>
								Display warning banners when context window usage reaches configurable thresholds
							</div>
						</div>
						<button
							onClick={(e) => {
								e.stopPropagation();
								updateContextManagementSettings({
									contextWarningsEnabled: !contextManagementSettings.contextWarningsEnabled,
								});
							}}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0"
							style={{
								backgroundColor: contextManagementSettings.contextWarningsEnabled
									? theme.colors.accent
									: theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={contextManagementSettings.contextWarningsEnabled}
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									contextManagementSettings.contextWarningsEnabled
										? 'translate-x-5'
										: 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Threshold Sliders (ghosted when disabled) */}
					<div
						className="space-y-4 pt-3 border-t"
						style={{
							borderColor: theme.colors.border,
							opacity: contextManagementSettings.contextWarningsEnabled ? 1 : 0.4,
							pointerEvents: contextManagementSettings.contextWarningsEnabled ? 'auto' : 'none',
						}}
					>
						{/* Yellow Warning Threshold */}
						<div>
							<div className="flex items-center justify-between mb-2">
								<div
									className="text-xs font-medium flex items-center gap-2"
									style={{ color: theme.colors.textMain }}
								>
									<div
										className="w-2.5 h-2.5 rounded-full"
										style={{ backgroundColor: '#eab308' }}
									/>
									Yellow warning threshold
								</div>
								<span
									className="text-xs font-mono px-2 py-0.5 rounded"
									style={{ backgroundColor: 'rgba(234, 179, 8, 0.2)', color: '#fde047' }}
								>
									{contextManagementSettings.contextWarningYellowThreshold}%
								</span>
							</div>
							<input
								type="range"
								min={0}
								max={100}
								step={5}
								value={contextManagementSettings.contextWarningYellowThreshold}
								aria-label="Yellow warning threshold"
								onChange={(e) => {
									const newYellow = Number(e.target.value);
									// Validation: ensure yellow < red by at least 10%
									if (newYellow >= contextManagementSettings.contextWarningRedThreshold) {
										// Bump red threshold up
										updateContextManagementSettings({
											contextWarningYellowThreshold: newYellow,
											contextWarningRedThreshold: Math.min(100, newYellow + 10),
										});
									} else {
										updateContextManagementSettings({
											contextWarningYellowThreshold: newYellow,
										});
									}
								}}
								className="w-full h-2 rounded-lg appearance-none cursor-pointer"
								style={{
									background: `linear-gradient(to right, #eab308 0%, #eab308 ${contextManagementSettings.contextWarningYellowThreshold}%, ${theme.colors.bgActivity} ${contextManagementSettings.contextWarningYellowThreshold}%, ${theme.colors.bgActivity} 100%)`,
								}}
							/>
						</div>

						{/* Red Warning Threshold */}
						<div>
							<div className="flex items-center justify-between mb-2">
								<div
									className="text-xs font-medium flex items-center gap-2"
									style={{ color: theme.colors.textMain }}
								>
									<div
										className="w-2.5 h-2.5 rounded-full"
										style={{ backgroundColor: '#ef4444' }}
									/>
									Red warning threshold
								</div>
								<span
									className="text-xs font-mono px-2 py-0.5 rounded"
									style={{ backgroundColor: 'rgba(239, 68, 68, 0.2)', color: '#fca5a5' }}
								>
									{contextManagementSettings.contextWarningRedThreshold}%
								</span>
							</div>
							<input
								type="range"
								min={0}
								max={100}
								step={5}
								value={contextManagementSettings.contextWarningRedThreshold}
								aria-label="Red warning threshold"
								onChange={(e) => {
									const newRed = Number(e.target.value);
									// Validation: ensure red > yellow by at least 10%
									if (newRed <= contextManagementSettings.contextWarningYellowThreshold) {
										// Bump yellow threshold down
										updateContextManagementSettings({
											contextWarningRedThreshold: newRed,
											contextWarningYellowThreshold: Math.max(0, newRed - 10),
										});
									} else {
										updateContextManagementSettings({ contextWarningRedThreshold: newRed });
									}
								}}
								className="w-full h-2 rounded-lg appearance-none cursor-pointer"
								style={{
									background: `linear-gradient(to right, #ef4444 0%, #ef4444 ${contextManagementSettings.contextWarningRedThreshold}%, ${theme.colors.bgActivity} ${contextManagementSettings.contextWarningRedThreshold}%, ${theme.colors.bgActivity} 100%)`,
								}}
							/>
						</div>
					</div>
				</div>
			</div>

			<div>
				<SettingsSectionHeading icon={Accessibility}>Accessibility</SettingsSectionHeading>
				<p className="text-xs opacity-50 mb-2">
					Visual options that adapt the interface for color vision deficiencies and long-form
					reading.
				</p>

				<div
					data-setting-id="display-colorblind-mode"
					className="p-3 rounded border space-y-3 mb-3"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					<div
						className="flex items-center justify-between cursor-pointer"
						onClick={() => setColorBlindMode(!colorBlindMode)}
						role="button"
						tabIndex={0}
						onKeyDown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								setColorBlindMode(!colorBlindMode);
							}
						}}
					>
						<div className="flex-1 pr-3">
							<div
								className="font-medium flex items-center gap-2"
								style={{ color: theme.colors.textMain }}
							>
								<Eye className="w-4 h-4" />
								<span>Color Blind Mode</span>
							</div>
							<p className="text-xs opacity-60 mt-1" style={{ color: theme.colors.textDim }}>
								Swap red/green/yellow semantics for Wong&apos;s colorblind-safe palette across agent
								status dots, diff add/remove, git status, the activity graph, Usage Dashboard
								charts, and file extension badges.
							</p>
						</div>
						<button
							onClick={(e) => {
								e.stopPropagation();
								setColorBlindMode(!colorBlindMode);
							}}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0"
							style={{
								backgroundColor: colorBlindMode ? theme.colors.accent : theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={colorBlindMode}
							aria-label="Color blind mode"
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									colorBlindMode ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>
				</div>

				<div
					data-setting-id="display-bionify-reading-mode"
					className="p-3 rounded border space-y-3"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					<div
						className="flex items-center justify-between cursor-pointer"
						onClick={() => setBionifyReadingMode(!bionifyReadingMode)}
						role="button"
						tabIndex={0}
						onKeyDown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								setBionifyReadingMode(!bionifyReadingMode);
							}
						}}
					>
						<div className="flex-1 pr-3">
							<div
								className="font-medium flex items-center gap-2"
								style={{ color: theme.colors.textMain }}
							>
								<span>Bionify Emphasis</span>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										setShowBionifyInfoModal(true);
									}}
									className="inline-flex items-center justify-center rounded transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
									style={{ width: '20px', height: '20px', color: theme.colors.textDim }}
									aria-label="Info"
									title="Bionify algorithm info"
								>
									<HelpCircle className="w-3.5 h-3.5" />
								</button>
							</div>
						</div>
						<button
							onClick={(e) => {
								e.stopPropagation();
								setBionifyReadingMode(!bionifyReadingMode);
							}}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0"
							style={{
								backgroundColor: bionifyReadingMode ? theme.colors.accent : theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={bionifyReadingMode}
							aria-label="Bionify reading mode"
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									bionifyReadingMode ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					<div
						className="space-y-4 pt-3 border-t"
						style={{
							borderColor: theme.colors.border,
							opacity: bionifyReadingMode ? 1 : 0.4,
							pointerEvents: bionifyReadingMode ? 'auto' : 'none',
						}}
					>
						<div>
							<div
								className="block text-xs font-bold opacity-70 uppercase mb-2"
								style={{ color: theme.colors.textDim }}
							>
								Intensity
							</div>
							<ToggleButtonGroup
								options={[
									{ value: 0.85, label: 'Soft' },
									{ value: 1, label: 'Default' },
									{ value: 1.35, label: 'Strong' },
								]}
								value={bionifyIntensity}
								onChange={setBionifyIntensity}
								theme={theme}
							/>
							<p className="text-xs opacity-50 mt-2">
								Controls how hard the emphasis hits. Strong increases emphasis weight and fades the
								remaining characters more aggressively.
							</p>
						</div>

						<div>
							<label
								htmlFor="bionify-algorithm-input"
								className="block text-xs font-bold opacity-70 uppercase mb-2"
							>
								Bionify Algorithm
							</label>
							<input
								id="bionify-algorithm-input"
								aria-label="Bionify algorithm"
								type="text"
								value={bionifyAlgorithmDraft}
								onChange={(event) => setBionifyAlgorithmDraft(event.target.value)}
								onBlur={commitBionifyAlgorithmDraft}
								onKeyDown={(event) => {
									if (event.key === 'Enter') {
										event.currentTarget.blur();
									}
								}}
								className="w-full px-3 py-2 rounded text-sm outline-none focus-visible:ring-1 focus-visible:ring-white/30"
								style={{
									backgroundColor: theme.colors.bgMain,
									color: theme.colors.textMain,
									border: `1px solid ${isBionifyAlgorithmValid ? theme.colors.border : theme.colors.warning}`,
								}}
								placeholder="- 0 1 1 2 0.4"
								spellCheck={false}
							/>
							<p className="text-xs opacity-50 mt-2">
								Format: sign, four fixed word-length rules, then a fallback fraction. Example: `- 0
								1 1 2 0.4`
							</p>
							{!isBionifyAlgorithmValid && (
								<p className="text-xs mt-2" style={{ color: theme.colors.warning }}>
									Enter `+|- len1 len2 len3 len4 fraction`, for example `- 0 1 1 2 0.4`.
								</p>
							)}
						</div>
					</div>
				</div>
			</div>

			{/* File Indexing - groups ignore patterns + file panel limits */}
			<div data-setting-id="display-file-indexing">
				<SettingsSectionHeading icon={FolderSearch}>File Indexing</SettingsSectionHeading>
				<div className="space-y-3">
					<IgnorePatternsSection
						theme={theme}
						title="Local Ignore Patterns"
						description="Configure glob patterns for folders to exclude when indexing local files in the file explorer. Excluding large directories (like .git) reduces memory usage and speeds up file tree loading."
						ignorePatterns={localIgnorePatterns}
						onIgnorePatternsChange={setLocalIgnorePatterns}
						defaultPatterns={DEFAULT_LOCAL_IGNORE_PATTERNS}
						showHonorGitignore
						honorGitignore={localHonorGitignore}
						onHonorGitignoreChange={setLocalHonorGitignore}
						onReset={() => setLocalHonorGitignore(true)}
						hideEyebrow
					/>
					<FilePanelSettingsSection
						theme={theme}
						maxDepth={fileExplorerMaxDepth}
						onMaxDepthChange={setFileExplorerMaxDepth}
						maxEntries={fileExplorerMaxEntries}
						onMaxEntriesChange={setFileExplorerMaxEntries}
						sshReduceEntryCapEnabled={sshReduceEntryCapEnabled}
						onSshReduceEntryCapEnabledChange={setSshReduceEntryCapEnabled}
						sshReduceEntryCapFraction={sshReduceEntryCapFraction}
						onSshReduceEntryCapFractionChange={setSshReduceEntryCapFraction}
					/>
				</div>
			</div>

			{showBionifyInfoModal && (
				<Modal
					theme={theme}
					title="Bionify Algorithm Reference"
					priority={MODAL_PRIORITIES.GROUP_CHAT_INFO}
					onClose={() => setShowBionifyInfoModal(false)}
					width={520}
					maxHeight="70vh"
					closeOnBackdropClick
				>
					<div className="space-y-4 text-sm" style={{ color: theme.colors.textMain }}>
						<div
							className="rounded border px-3 py-2 font-mono text-sm"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
							}}
						>
							- 0 1 1 2 0.4
						</div>
						<p style={{ color: theme.colors.textDim }}>
							The first character is `-` or `+`. `-` skips common english words like `a`, `and`, and
							`the`. `+` highlights every word.
						</p>
						<ul className="list-disc pl-5 space-y-2" style={{ color: theme.colors.textDim }}>
							<li>The next four numbers control highlighted characters for words of length 1-4.</li>
							<li>
								The final value is a fraction of each word&apos;s characters to emphasize (for
								example, `0.4` highlights the first 40% of characters in words longer than 4
								letters).
							</li>
							<li>
								Current default: `- 0 1 1 2 0.4`, which skips common words and highlights the first
								40% of longer words.
							</li>
						</ul>
					</div>
				</Modal>
			)}
		</div>
	);
}
