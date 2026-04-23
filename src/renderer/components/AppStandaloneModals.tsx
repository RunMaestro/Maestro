import { lazy, memo, Suspense } from 'react';
import { useModalActions } from '../stores/modalStore';
import { useFileExplorerStore } from '../stores/fileExplorerStore';
import { useTabStore } from '../stores/tabStore';
import { useMessageGistStore } from '../stores/messageGistStore';
import { useUIStore } from '../stores/uiStore';
import { useActiveSession } from '../hooks/session/useActiveSession';
import { useSessionStore } from '../stores/sessionStore';
import { notifyToast } from '../stores/notificationStore';
import { safeClipboardWrite } from '../utils/clipboard';
import { THEMES } from '../constants/themes';
import { DebugPackageModal } from './DebugPackageModal';
import { DebugApplicationStatsModal } from './DebugApplicationStatsModal';
import { WindowsWarningModal } from './WindowsWarningModal';
import { AppOverlays } from './AppOverlays';
import { PlaygroundPanel } from './PlaygroundPanel';
import { DebugWizardModal } from './DebugWizardModal';
import { GistPublishModal } from './GistPublishModal';
import type { GistInfo } from './GistPublishModal';
import { DeleteAgentConfirmModal } from './DeleteAgentConfirmModal';
import { MaestroWizard, WizardResumeModal } from './Wizard';
import { TourOverlay } from './Wizard/tour';
import type { SymphonyContributionData } from './SymphonyModal';
import type { MindMapLayoutType } from './DocumentGraph/mindMapLayouts';

import type {
	Theme,
	Session,
	Shortcut,
	AutoRunStats,
	EncoreFeatureFlags,
	FilePreviewTab,
} from '../types';
import type { FileTabInfo } from '../hooks/ui/useAppHandlers';
import type { MainPanelHandle } from './MainPanel';
import type { FileNode } from '../types/fileTree';
import { openUrl } from '../utils/openUrl';
import { logger } from '../utils/logger';

// Lazy-loaded components (rarely-used heavy modals)
const SettingsModal = lazy(() =>
	import('./Settings/SettingsModal').then((m) => ({ default: m.SettingsModal }))
);
const MarketplaceModal = lazy(() =>
	import('./MarketplaceModal').then((m) => ({ default: m.MarketplaceModal }))
);
const SymphonyModal = lazy(() =>
	import('./SymphonyModal').then((m) => ({ default: m.SymphonyModal }))
);
const DocumentGraphView = lazy(() =>
	import('./DocumentGraph/DocumentGraphView').then((m) => ({
		default: m.DocumentGraphView,
	}))
);
const DirectorNotesModal = lazy(() =>
	import('./DirectorNotes').then((m) => ({ default: m.DirectorNotesModal }))
);
const CueModal = lazy(() => import('./CueModal').then((m) => ({ default: m.CueModal })));
const CueYamlEditor = lazy(() =>
	import('./CueYamlEditor').then((m) => ({ default: m.CueYamlEditor }))
);

/**
 * Props for the AppStandaloneModals component.
 *
 * Standalone modals self-source open/close state from modalStore, sessionStore,
 * fileExplorerStore, and tabStore. These props cover handlers and computed values
 * that originate in App.tsx hook calls.
 */
export interface AppStandaloneModalsProps {
	theme: Theme;

	// --- Debug / Playground ---
	onCloseDebugPackage: () => void;
	setSuppressWindowsWarning: (value: boolean) => void;
	enableBetaUpdates: boolean;
	setEnableBetaUpdates: (value: boolean) => void;

	// --- AppOverlays ---
	autoRunStats: AutoRunStats;
	onStandingOvationClose: () => void;
	onOpenLeaderboardRegistration: () => void;
	isLeaderboardRegistered: boolean;
	onFirstRunCelebrationClose: () => void;
	onKeyboardMasteryCelebrationClose: () => void;

	// --- Marketplace ---
	onMarketplaceImportComplete: (folderName: string) => Promise<void>;

	// --- Symphony ---
	sessions: Session[];
	setActiveSessionId: (id: string) => void;
	onStartContribution: (data: SymphonyContributionData) => Promise<void>;
	encoreFeatures: EncoreFeatureFlags;

	// --- Director's Notes ---
	onDirectorNotesResumeSession: (sourceSessionId: string, agentSessionId: string) => void;
	onFileClick: (node: FileNode, path: string) => void;

	// --- Cue ---
	shortcuts: Record<string, Shortcut>;

	// --- GistPublish ---
	gistPublishModalOpen: boolean;
	setGistPublishModalOpen: (open: boolean) => void;
	activeFileTab: FilePreviewTab | null;
	saveFileGistUrl: (filePath: string, gistInfo: GistInfo) => void;
	fileGistUrls: Record<string, GistInfo>;

	// --- DocumentGraph ---
	onOpenFileTab: (info: FileTabInfo) => void;
	mainPanelRef: React.RefObject<MainPanelHandle | null>;
	documentGraphShowExternalLinks: boolean;
	onExternalLinksChange: (value: boolean) => void;
	documentGraphMaxNodes: number;
	documentGraphPreviewCharLimit: number;
	onPreviewCharLimitChange: (value: number) => void;
	documentGraphLayoutType: MindMapLayoutType;
	onLayoutTypeChange: (type: MindMapLayoutType) => void;

	// --- DeleteAgent ---
	onPerformDeleteSession: (session: Session, eraseData: boolean) => void;
	onCloseDeleteAgentModal: () => void;

	// --- Settings ---
	onCloseSettings: () => void;
	hasNoAgents: boolean;
	setFlashNotification: (msg: string | null) => void;

	// --- Wizard ---
	wizardIsOpen: boolean;
	onWizardLaunchSession: (wantsTour: boolean) => Promise<void>;
	recordWizardStart: () => void;
	recordWizardResume: () => void;
	recordWizardAbandon: () => void;
	recordWizardComplete: (
		durationMs: number,
		conversationExchanges: number,
		phasesGenerated: number,
		tasksGenerated: number
	) => void;
	onWizardResume: () => void;
	onWizardStartFresh: () => void;
	onWizardResumeClose: () => void;

	// --- Tour ---
	setTourCompleted: (value: boolean) => void;
	tabShortcuts: Record<string, Shortcut>;
	recordTourStart: () => void;
	recordTourComplete: (stepsViewed: number) => void;
	recordTourSkip: (stepsViewed: number) => void;
}

function AppStandaloneModalsInner({
	theme,
	// Debug / Playground
	onCloseDebugPackage,
	setSuppressWindowsWarning,
	enableBetaUpdates,
	setEnableBetaUpdates,
	// AppOverlays
	autoRunStats,
	onStandingOvationClose,
	onOpenLeaderboardRegistration,
	isLeaderboardRegistered,
	onFirstRunCelebrationClose,
	onKeyboardMasteryCelebrationClose,
	// Marketplace
	onMarketplaceImportComplete,
	// Symphony
	sessions,
	setActiveSessionId,
	onStartContribution,
	encoreFeatures,
	// Director's Notes
	onDirectorNotesResumeSession,
	onFileClick,
	// Cue
	shortcuts,
	// GistPublish
	gistPublishModalOpen,
	setGistPublishModalOpen,
	activeFileTab,
	saveFileGistUrl,
	fileGistUrls,
	// DocumentGraph
	onOpenFileTab,
	mainPanelRef,
	documentGraphShowExternalLinks,
	onExternalLinksChange,
	documentGraphMaxNodes,
	documentGraphPreviewCharLimit,
	onPreviewCharLimitChange,
	documentGraphLayoutType,
	onLayoutTypeChange,
	// DeleteAgent
	onPerformDeleteSession,
	onCloseDeleteAgentModal,
	// Settings
	onCloseSettings,
	hasNoAgents,
	setFlashNotification,
	// Wizard
	wizardIsOpen,
	onWizardLaunchSession,
	recordWizardStart,
	recordWizardResume,
	recordWizardAbandon,
	recordWizardComplete,
	onWizardResume,
	onWizardStartFresh,
	onWizardResumeClose,
	// Tour
	setTourCompleted,
	tabShortcuts,
	recordTourStart,
	recordTourComplete,
	recordTourSkip,
}: AppStandaloneModalsProps) {
	// Self-source flash notifications from UI store
	const flashNotification = useUIStore((s) => s.flashNotification);
	const successFlashNotification = useUIStore((s) => s.successFlashNotification);

	// Self-source modal open states from stores
	const {
		debugPackageModalOpen,
		windowsWarningModalOpen,
		setWindowsWarningModalOpen,
		setDebugPackageModalOpen,
		debugApplicationStatsOpen,
		setDebugApplicationStatsOpen,
		playgroundOpen,
		setPlaygroundOpen,
		debugWizardModalOpen,
		setDebugWizardModalOpen,
		marketplaceModalOpen,
		setMarketplaceModalOpen,
		symphonyModalOpen,
		setSymphonyModalOpen,
		directorNotesOpen,
		setDirectorNotesOpen,
		cueModalOpen,
		setCueModalOpen,
		cueYamlEditorOpen,
		cueYamlEditorSessionId,
		cueYamlEditorProjectRoot,
		closeCueYamlEditor,
		deleteAgentModalOpen,
		deleteAgentSession,
		settingsModalOpen,
		settingsTab,
		settingsPromptId,
		wizardResumeModalOpen,
		wizardResumeState,
		tourOpen,
		setTourOpen,
		tourFromWizard,
	} = useModalActions();

	// Self-source file explorer state
	const isGraphViewOpen = useFileExplorerStore((s) => s.isGraphViewOpen);
	const graphFocusFilePath = useFileExplorerStore((s) => s.graphFocusFilePath);

	// Self-source tab gist content
	const tabGistContent = useTabStore((s) => s.tabGistContent);

	// Self-source active session
	const activeSession = useActiveSession();

	return (
		<>
			{/* --- DEBUG PACKAGE MODAL --- */}
			<DebugPackageModal
				theme={theme}
				isOpen={debugPackageModalOpen}
				onClose={onCloseDebugPackage}
			/>

			{/* --- WINDOWS WARNING MODAL --- */}
			<WindowsWarningModal
				theme={theme}
				isOpen={windowsWarningModalOpen}
				onClose={() => setWindowsWarningModalOpen(false)}
				onSuppressFuture={setSuppressWindowsWarning}
				onOpenDebugPackage={() => setDebugPackageModalOpen(true)}
				useBetaChannel={enableBetaUpdates}
				onSetUseBetaChannel={setEnableBetaUpdates}
			/>

			{/* --- CELEBRATION OVERLAYS --- */}
			<AppOverlays
				theme={theme}
				cumulativeTimeMs={autoRunStats.cumulativeTimeMs}
				onCloseStandingOvation={onStandingOvationClose}
				onOpenLeaderboardRegistration={onOpenLeaderboardRegistration}
				isLeaderboardRegistered={isLeaderboardRegistered}
				onCloseFirstRun={onFirstRunCelebrationClose}
				onCloseKeyboardMastery={onKeyboardMasteryCelebrationClose}
			/>

			{/* --- DEVELOPER PLAYGROUND --- */}
			{playgroundOpen && (
				<PlaygroundPanel
					theme={theme}
					themeMode={theme.mode}
					onClose={() => setPlaygroundOpen(false)}
				/>
			)}

			{/* --- DEBUG WIZARD MODAL --- */}
			<DebugWizardModal
				theme={theme}
				isOpen={debugWizardModalOpen}
				onClose={() => setDebugWizardModalOpen(false)}
			/>

			{/* --- DEBUG: VIEW APPLICATION STATS --- */}
			{debugApplicationStatsOpen && (
				<DebugApplicationStatsModal
					theme={theme}
					onClose={() => setDebugApplicationStatsOpen(false)}
				/>
			)}

			{/* --- MARKETPLACE MODAL (lazy-loaded) --- */}
			{activeSession && activeSession.autoRunFolderPath && marketplaceModalOpen && (
				<Suspense fallback={null}>
					<MarketplaceModal
						theme={theme}
						isOpen={marketplaceModalOpen}
						onClose={() => setMarketplaceModalOpen(false)}
						autoRunFolderPath={activeSession.autoRunFolderPath}
						sessionId={activeSession.id}
						sshRemoteId={
							activeSession.sshRemoteId ||
							activeSession.sessionSshRemoteConfig?.remoteId ||
							undefined
						}
						onImportComplete={onMarketplaceImportComplete}
					/>
				</Suspense>
			)}

			{/* --- SYMPHONY MODAL (lazy-loaded) --- */}
			{encoreFeatures.symphony && symphonyModalOpen && (
				<Suspense fallback={null}>
					<SymphonyModal
						theme={theme}
						isOpen={symphonyModalOpen}
						onClose={() => setSymphonyModalOpen(false)}
						sessions={sessions}
						onSelectSession={(sessionId) => {
							setActiveSessionId(sessionId);
							setSymphonyModalOpen(false);
						}}
						onStartContribution={onStartContribution}
					/>
				</Suspense>
			)}

			{/* --- DIRECTOR'S NOTES MODAL (lazy-loaded, Encore Feature) --- */}
			{encoreFeatures.directorNotes && directorNotesOpen && (
				<Suspense fallback={null}>
					<DirectorNotesModal
						theme={theme}
						onClose={() => setDirectorNotesOpen(false)}
						onResumeSession={onDirectorNotesResumeSession}
						fileTree={activeSession?.fileTree}
						onFileClick={(path: string) =>
							onFileClick({ name: path.split('/').pop() || path, type: 'file' }, path)
						}
					/>
				</Suspense>
			)}

			{/* --- MAESTRO CUE MODAL (lazy-loaded, Encore Feature) --- */}
			{encoreFeatures.maestroCue && cueModalOpen && (
				<Suspense fallback={null}>
					<CueModal
						theme={theme}
						onClose={() => setCueModalOpen(false)}
						cueShortcutKeys={shortcuts.maestroCue?.keys}
					/>
				</Suspense>
			)}

			{/* --- MAESTRO CUE YAML EDITOR (standalone, lazy-loaded) --- */}
			{encoreFeatures.maestroCue &&
				cueYamlEditorOpen &&
				cueYamlEditorSessionId &&
				cueYamlEditorProjectRoot && (
					<Suspense fallback={null}>
						<CueYamlEditor
							key={cueYamlEditorSessionId}
							isOpen={true}
							onClose={closeCueYamlEditor}
							projectRoot={cueYamlEditorProjectRoot}
							sessionId={cueYamlEditorSessionId}
							theme={theme}
						/>
					</Suspense>
				)}

			{/* --- GIST PUBLISH MODAL --- */}
			{/* Supports both file preview tabs and tab context gist publishing */}
			{gistPublishModalOpen && (activeFileTab || tabGistContent) && (
				<GistPublishModal
					theme={theme}
					filename={
						tabGistContent?.filename ??
						(activeFileTab ? activeFileTab.name + activeFileTab.extension : 'conversation.md')
					}
					content={tabGistContent?.content ?? activeFileTab?.content ?? ''}
					onClose={() => {
						setGistPublishModalOpen(false);
						useTabStore.getState().setTabGistContent(null);
					}}
					onSuccess={(gistUrl, isPublic) => {
						const publishedAt = Date.now();
						// Save gist URL for the file if it's from file preview tab (not tab context)
						if (activeFileTab && !tabGistContent) {
							saveFileGistUrl(activeFileTab.path, {
								gistUrl,
								isPublic,
								publishedAt,
							});
						}
						// Save gist URL for the individual message, if the publish originated from one.
						// In-memory only — intentionally not persisted across app restarts.
						if (tabGistContent?.messageId) {
							useMessageGistStore.getState().setMessageGist(tabGistContent.messageId, {
								gistUrl,
								isPublic,
								publishedAt,
							});
						}
						// Copy the gist URL to clipboard
						safeClipboardWrite(gistUrl);
						// Show a toast notification
						notifyToast({
							type: 'success',
							title: 'Gist Published',
							message: `${isPublic ? 'Public' : 'Secret'} gist created! URL copied to clipboard.`,
							duration: 5000,
							actionUrl: gistUrl,
							actionLabel: 'Open Gist',
						});
						// Clear tab gist content after success
						useTabStore.getState().setTabGistContent(null);
					}}
					existingGist={
						tabGistContent?.messageId
							? useMessageGistStore.getState().published[tabGistContent.messageId]
							: activeFileTab && !tabGistContent
								? fileGistUrls[activeFileTab.path]
								: undefined
					}
				/>
			)}

			{/* --- DOCUMENT GRAPH VIEW (Mind Map, lazy-loaded) --- */}
			{/* Only render when a focus file is provided - mind map requires a center document */}
			{graphFocusFilePath && (
				<Suspense fallback={null}>
					<DocumentGraphView
						isOpen={isGraphViewOpen}
						onClose={() => {
							useFileExplorerStore.getState().closeGraphView();
							// Return focus to file preview if it was open
							requestAnimationFrame(() => {
								mainPanelRef.current?.focusFilePreview();
							});
						}}
						theme={theme}
						rootPath={activeSession?.projectRoot || activeSession?.cwd || ''}
						onDocumentOpen={async (filePath) => {
							// Open the document in a file tab (migrated from legacy setPreviewFile overlay)
							const treeRoot = activeSession?.projectRoot || activeSession?.cwd || '';
							const fullPath = `${treeRoot}/${filePath}`;
							const filename = filePath.split('/').pop() || filePath;
							// Note: sshRemoteId is only set after AI agent spawns. For terminal-only SSH sessions,
							// use sessionSshRemoteConfig.remoteId as fallback (see CLAUDE.md SSH Remote Sessions)
							const sshRemoteId =
								activeSession?.sshRemoteId ||
								activeSession?.sessionSshRemoteConfig?.remoteId ||
								undefined;
							try {
								// Fetch content and stat in parallel for efficiency
								const [content, stat] = await Promise.all([
									window.maestro.fs.readFile(fullPath, sshRemoteId),
									window.maestro.fs.stat(fullPath, sshRemoteId).catch(() => null), // stat is optional
								]);
								if (content !== null) {
									const lastModified = stat?.modifiedAt
										? new Date(stat.modifiedAt).getTime()
										: undefined;
									onOpenFileTab({
										path: fullPath,
										name: filename,
										content,
										sshRemoteId,
										lastModified,
									});
								}
							} catch (error) {
								logger.error('[DocumentGraph] Failed to open file:', undefined, error);
							}
							useFileExplorerStore.getState().setIsGraphViewOpen(false);
						}}
						onExternalLinkOpen={(url) => {
							// Open external URL in default browser
							openUrl(url);
						}}
						focusFilePath={graphFocusFilePath}
						defaultShowExternalLinks={documentGraphShowExternalLinks}
						onExternalLinksChange={onExternalLinksChange}
						defaultMaxNodes={documentGraphMaxNodes}
						defaultPreviewCharLimit={documentGraphPreviewCharLimit}
						onPreviewCharLimitChange={onPreviewCharLimitChange}
						defaultLayoutType={activeSession?.documentGraphLayout ?? documentGraphLayoutType}
						onLayoutTypeChange={(type) => {
							// Persist to the active session for per-agent recall
							if (activeSession) {
								const { sessions, setSessions } = useSessionStore.getState();
								setSessions(
									sessions.map((s) =>
										s.id === activeSession.id ? { ...s, documentGraphLayout: type } : s
									)
								);
							}
							// Also update the global default for new agents
							onLayoutTypeChange(type);
						}}
						// Note: sshRemoteId is only set after AI agent spawns. For terminal-only SSH sessions,
						// use sessionSshRemoteConfig.remoteId as fallback (see CLAUDE.md SSH Remote Sessions)
						sshRemoteId={
							activeSession?.sshRemoteId ||
							activeSession?.sessionSshRemoteConfig?.remoteId ||
							undefined
						}
					/>
				</Suspense>
			)}

			{/* Delete Agent Confirmation Modal */}
			{deleteAgentModalOpen && deleteAgentSession && (
				<DeleteAgentConfirmModal
					theme={theme}
					agentName={deleteAgentSession.name}
					workingDirectory={deleteAgentSession.cwd}
					onConfirm={() => onPerformDeleteSession(deleteAgentSession, false)}
					onConfirmAndErase={() => onPerformDeleteSession(deleteAgentSession, true)}
					onClose={onCloseDeleteAgentModal}
				/>
			)}

			{/* --- SETTINGS MODAL (Lazy-loaded for performance) --- */}
			{settingsModalOpen && (
				<Suspense fallback={null}>
					<SettingsModal
						isOpen={settingsModalOpen}
						onClose={onCloseSettings}
						theme={theme}
						themes={THEMES}
						initialTab={settingsTab}
						initialSelectedPromptId={settingsPromptId}
						hasNoAgents={hasNoAgents}
						onThemeImportError={(msg) => setFlashNotification(msg)}
						onThemeImportSuccess={(msg) => setFlashNotification(msg)}
					/>
				</Suspense>
			)}

			{/* --- WIZARD RESUME MODAL (asks if user wants to resume incomplete wizard) --- */}
			{wizardResumeModalOpen && wizardResumeState && (
				<WizardResumeModal
					theme={theme}
					resumeState={wizardResumeState}
					onResume={onWizardResume}
					onStartFresh={onWizardStartFresh}
					onClose={onWizardResumeClose}
				/>
			)}

			{/* --- MAESTRO WIZARD (onboarding wizard for new users) --- */}
			{/* PERF: Only mount wizard component when open to avoid running hooks/effects */}
			{wizardIsOpen && (
				<MaestroWizard
					theme={theme}
					onLaunchSession={onWizardLaunchSession}
					onWizardStart={recordWizardStart}
					onWizardResume={recordWizardResume}
					onWizardAbandon={recordWizardAbandon}
					onWizardComplete={recordWizardComplete}
				/>
			)}

			{/* --- TOUR OVERLAY (onboarding tour for interface guidance) --- */}
			{/* PERF: Only mount tour component when open to avoid running hooks/effects */}
			{tourOpen && (
				<TourOverlay
					theme={theme}
					isOpen={tourOpen}
					fromWizard={tourFromWizard}
					shortcuts={{ ...shortcuts, ...tabShortcuts }}
					onClose={() => {
						setTourOpen(false);
						setTourCompleted(true);
					}}
					onTourStart={recordTourStart}
					onTourComplete={recordTourComplete}
					onTourSkip={recordTourSkip}
				/>
			)}

			{/* --- FLASH NOTIFICATION (centered, auto-dismiss) --- */}
			{flashNotification && (
				<div
					className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 px-6 py-4 rounded-lg shadow-2xl text-base font-bold animate-in fade-in zoom-in-95 duration-200 z-[9999]"
					style={{
						backgroundColor: theme.colors.warning,
						color: '#000000',
						textShadow: '0 1px 2px rgba(255, 255, 255, 0.3)',
					}}
				>
					{flashNotification}
				</div>
			)}

			{/* --- SUCCESS FLASH NOTIFICATION (centered, auto-dismiss) --- */}
			{successFlashNotification && (
				<div
					className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 px-6 py-4 rounded-lg shadow-2xl text-base font-bold animate-in fade-in zoom-in-95 duration-200 z-[9999]"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
						textShadow: '0 1px 2px rgba(0, 0, 0, 0.3)',
					}}
				>
					{successFlashNotification}
				</div>
			)}
		</>
	);
}

export const AppStandaloneModals = memo(AppStandaloneModalsInner);
