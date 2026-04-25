/**
 * DisplayTab - Display settings tab for SettingsModal
 *
 * Contains: Font Configuration, Font Size, Max Log Buffer,
 * Max Output Lines, Message Alignment, Window Chrome, Document Graph,
 * Context Window Warnings, Local Ignore Patterns.
 */

import { useState } from 'react';
import {
	ALargeSmall,
	AlignHorizontalJustifyCenter,
	AlertTriangle,
	AppWindow,
	BookOpen,
	Database,
	FolderSearch,
	HelpCircle,
	WrapText,
	ListFilter,
	Palette,
	Sparkles,
} from 'lucide-react';
import { useSettings } from '../../../hooks';
import type { Theme } from '../../../types';
import { ToggleButtonGroup } from '../../ToggleButtonGroup';
import { FontConfigurationPanel } from '../../FontConfigurationPanel';
import { IgnorePatternsSection } from '../IgnorePatternsSection';
import { FilePanelSettingsSection } from '../FilePanelSettingsSection';
import { SettingsSectionHeading } from '../SettingsSectionHeading';
import { DEFAULT_LOCAL_IGNORE_PATTERNS } from '../../../stores/settingsStore';
import { logger } from '../../../utils/logger';
import { Modal } from '../../ui/Modal';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import { DEFAULT_BIONIFY_ALGORITHM } from '../../../utils/bionifyReadingMode';

const BIONIFY_ALGORITHM_PATTERN = /^[+-](\s+\d+){4}\s+(?:0(?:\.\d+)?|1(?:\.0+)?)$/;

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
		useNativeTitleBar,
		setUseNativeTitleBar,
		autoHideMenuBar,
		setAutoHideMenuBar,
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
				| string[]
				| undefined;
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

			{/* Starred Tabs in Unread Filter */}
			<div data-setting-id="display-tab-filtering">
				<SettingsSectionHeading icon={ListFilter}>Tab Filtering</SettingsSectionHeading>
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

			<div data-setting-id="display-bionify-reading-mode">
				<SettingsSectionHeading icon={BookOpen}>Reading Mode</SettingsSectionHeading>
				<p className="text-xs opacity-50 mb-2">
					Applies Bionify-style emphasis only to opted-in long-form readers like File Preview and
					Auto Run. Terminals, logs, and chat input stay unchanged.
				</p>
				<div
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

			{/* File Indexing — groups ignore patterns + file panel limits */}
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
