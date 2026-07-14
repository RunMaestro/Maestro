/**
 * SymphonyModal
 *
 * Unified modal for Maestro Symphony feature with four tabs:
 * - Projects: Browse repositories with runmaestro.ai labeled issues
 * - Active: Manage in-progress contributions
 * - History: View completed contributions
 * - Stats: View achievements and contributor statistics
 *
 * UI matches the Playbook Marketplace pattern.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { RegisteredRepository, SymphonyIssue } from '../../../shared/symphony-types';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { useResizableModal } from '../../hooks/ui/useResizableModal';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useSymphony } from '../../hooks/symphony';
import { useContributorStats } from '../../hooks/symphony/useContributorStats';
import { AgentCreationDialog, type AgentCreationConfig } from '../AgentCreationDialog';
import type { ModalTab, SymphonyModalProps } from './types';
import {
	useGhCliPreflight,
	usePrStatusSync,
	useDocumentPreview,
	useSymphonyTabCycle,
	useProjectsKeyboardNav,
} from './hooks';
import { RepositoryDetailView, BuildToolsWarningDialog, SymphonyHeader } from './components';
import { ProjectsTab, ActiveTab, HistoryTab, StatsTab } from './tabs';
import { ResizeHandles } from '../ui/ResizeHandles';

// ============================================================================
// Main SymphonyModal
// ============================================================================

export function SymphonyModal({
	theme,
	isOpen,
	onClose,
	onStartContribution,
	onSelectSession,
}: SymphonyModalProps) {
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	const {
		categories,
		isLoading,
		isRefreshing,
		error,
		fromCache,
		cacheAge,
		selectedCategory,
		setSelectedCategory,
		searchQuery,
		setSearchQuery,
		filteredRepositories,
		refresh,
		selectedRepo,
		repoIssues,
		isLoadingIssues,
		selectRepository,
		startContribution,
		activeContributions,
		completedContributions,
		finalizeContribution,
		issueCounts,
		isLoadingIssueCounts,
	} = useSymphony();

	const {
		stats,
		achievements,
		formattedTotalCost,
		formattedTotalTokens,
		formattedTotalTime,
		uniqueRepos,
		currentStreakWeeks,
		longestStreakWeeks,
	} = useContributorStats();

	// UI state
	const [activeTab, setActiveTab] = useState<ModalTab>('projects');
	const [selectedTileIndex, setSelectedTileIndex] = useState(0);
	const [showDetailView, setShowDetailView] = useState(false);
	const [selectedIssue, setSelectedIssue] = useState<SymphonyIssue | null>(null);
	const [isStarting, setIsStarting] = useState(false);
	const [showAgentDialog, setShowAgentDialog] = useState(false);
	const [showHelp, setShowHelp] = useState(false);

	// Hook-managed state
	const ghPreflight = useGhCliPreflight(() => window.maestro.git.checkGhCli());
	const prStatusSync = usePrStatusSync({
		checkPRStatuses: () => window.maestro.symphony.checkPRStatuses(),
		syncContribution: (id) => window.maestro.symphony.syncContribution(id),
	});
	const docPreview = useDocumentPreview({
		selectedRepo,
		fetchDocumentContent: (path) => window.maestro.symphony.fetchDocumentContent(path),
	});

	const searchInputRef = useRef<HTMLInputElement>(null);
	const tileGridRef = useRef<HTMLDivElement>(null);
	const helpButtonRef = useRef<HTMLButtonElement>(null);
	const showDetailViewRef = useRef(showDetailView);
	const showHelpRef = useRef(showHelp);
	showHelpRef.current = showHelp;
	showDetailViewRef.current = showDetailView;

	const handleCategoryChange = useCallback(
		(category: string) => {
			setSelectedCategory(category);
			setSelectedTileIndex(0);
		},
		[setSelectedCategory]
	);

	const handleSearchChange = useCallback(
		(value: string) => {
			setSearchQuery(value);
			setSelectedTileIndex(0);
		},
		[setSearchQuery]
	);

	// Back navigation
	const handleBack = useCallback(() => {
		setShowDetailView(false);
		selectRepository(null);
		setSelectedIssue(null);
		docPreview.resetPreview();
	}, [selectRepository, docPreview]);

	const handleBackRef = useRef(handleBack);
	handleBackRef.current = handleBack;

	// Layer stack
	useModalLayer(
		MODAL_PRIORITIES.SYMPHONY ?? 710,
		'Maestro Symphony',
		() => {
			if (showHelpRef.current) {
				setShowHelp(false);
			} else if (showDetailViewRef.current) {
				handleBackRef.current();
			} else {
				onCloseRef.current();
			}
		},
		{ enabled: isOpen }
	);

	// Focus tile grid for keyboard navigation (keyboard-first design)
	useEffect(() => {
		if (isOpen && activeTab === 'projects' && !showDetailView) {
			const timer = setTimeout(() => tileGridRef.current?.focus(), 50);
			return () => clearTimeout(timer);
		}
	}, [isOpen, activeTab, showDetailView]);

	// Select repo
	const handleSelectRepo = useCallback(
		async (repo: RegisteredRepository) => {
			await selectRepository(repo);
			setShowDetailView(true);
			setSelectedIssue(null);
			docPreview.resetPreview();
		},
		[selectRepository, docPreview]
	);

	// Select issue
	const handleSelectIssue = useCallback(
		async (issue: SymphonyIssue) => {
			setSelectedIssue(issue);
			docPreview.resetPreview();
		},
		[docPreview]
	);

	// Start contribution - kicks off gh CLI pre-flight via useGhCliPreflight
	const handleStartContribution = useCallback(() => {
		if (!selectedRepo || !selectedIssue) return;
		ghPreflight.start();
	}, [selectedRepo, selectedIssue, ghPreflight]);

	const handleBuildWarningConfirm = useCallback(() => {
		ghPreflight.confirm(() => setShowAgentDialog(true));
	}, [ghPreflight]);

	// Handle agent creation from dialog
	const handleCreateAgent = useCallback(
		async (config: AgentCreationConfig): Promise<{ success: boolean; error?: string }> => {
			if (!selectedRepo || !selectedIssue) {
				return { success: false, error: 'No repository or issue selected' };
			}

			setIsStarting(true);
			const result = await startContribution(
				config.repo,
				config.issue,
				config.agentType,
				'', // session ID will be generated by the backend
				config.workingDirectory // Pass the working directory for cloning
			).finally(() => {
				setIsStarting(false);
			});

			if (result.success && result.contributionId) {
				// Close the agent dialog
				setShowAgentDialog(false);
				// Switch to Active tab
				setActiveTab('active');
				handleBack();
				// Notify parent with all data needed to create the session
				onStartContribution({
					contributionId: result.contributionId,
					localPath: config.workingDirectory,
					autoRunPath: result.autoRunPath,
					branchName: result.branchName,
					draftPrNumber: result.draftPrNumber,
					draftPrUrl: result.draftPrUrl,
					agentType: config.agentType,
					sessionName: config.sessionName,
					repo: config.repo,
					issue: config.issue,
					customPath: config.customPath,
					customArgs: config.customArgs,
					customEnvVars: config.customEnvVars,
				});
				return { success: true };
			}

			return { success: false, error: result.error ?? 'Failed to start contribution' };
		},
		[selectedRepo, selectedIssue, startContribution, onStartContribution, handleBack]
	);

	// Contribution actions
	const handleFinalize = useCallback(
		async (contributionId: string) => {
			await finalizeContribution(contributionId);
		},
		[finalizeContribution]
	);

	useSymphonyTabCycle({ isOpen, activeTab, onTabChange: setActiveTab });
	useProjectsKeyboardNav({
		isOpen,
		activeTab,
		showDetailView,
		filteredRepositories,
		selectedTileIndex,
		setSelectedTileIndex,
		onSelectRepo: handleSelectRepo,
		searchInputRef,
		tileGridRef,
	});
	const resizableModal = useResizableModal({
		resizeKey: 'symphony',
		defaultSize: { width: 1200, height: 760 },
		minSize: { width: 760, height: 500 },
		enabled: isOpen,
	});

	if (!isOpen) return null;

	const modalContent = (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center p-8 z-[9999] animate-in fade-in duration-100"
			style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
		>
			<div
				ref={resizableModal.modalRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="symphony-modal-title"
				tabIndex={-1}
				className="relative rounded-xl shadow-2xl border overflow-hidden flex flex-col outline-none select-none"
				style={{
					...resizableModal.style,
					backgroundColor: theme.colors.bgActivity,
					borderColor: theme.colors.border,
				}}
				data-modal-resize-key="symphony"
			>
				<ResizeHandles
					onResizeStart={resizableModal.onResizeStart}
					accentColor={theme.colors.accent}
				/>

				{/* Detail view for projects */}
				{activeTab === 'projects' && showDetailView && selectedRepo ? (
					<RepositoryDetailView
						theme={theme}
						repo={selectedRepo}
						issues={repoIssues}
						isLoadingIssues={isLoadingIssues}
						selectedIssue={selectedIssue}
						documentPreview={docPreview.documentPreview}
						isLoadingDocument={docPreview.isLoadingDocument}
						isStarting={isStarting}
						onBack={handleBack}
						onSelectIssue={handleSelectIssue}
						onStartContribution={handleStartContribution}
						onPreviewDocument={docPreview.previewDocument}
					/>
				) : (
					<>
						<SymphonyHeader
							ref={helpButtonRef}
							theme={theme}
							showCacheStatus={activeTab === 'projects'}
							fromCache={fromCache}
							cacheAge={cacheAge}
							isRefreshing={isRefreshing}
							onRefresh={() => refresh(true)}
							onClose={onClose}
							showHelp={showHelp}
							onToggleHelp={() => setShowHelp((v) => !v)}
							onCloseHelp={() => setShowHelp(false)}
						/>

						{/* Tab navigation */}
						<div
							className="flex items-center gap-1 px-4 py-2 border-b"
							style={{ borderColor: theme.colors.border }}
						>
							{(['projects', 'active', 'history', 'stats'] as ModalTab[]).map((tab) => (
								<button
									key={tab}
									onClick={() => setActiveTab(tab)}
									className={`px-3 py-1.5 rounded text-sm transition-colors ${activeTab === tab ? 'font-semibold' : ''}`}
									style={{
										backgroundColor: activeTab === tab ? theme.colors.accent + '20' : 'transparent',
										color: activeTab === tab ? theme.colors.accent : theme.colors.textDim,
									}}
								>
									{tab === 'projects' && 'Projects'}
									{tab === 'active' &&
										`Active${activeContributions.length > 0 ? ` (${activeContributions.length})` : ''}`}
									{tab === 'history' && 'History'}
									{tab === 'stats' && 'Stats'}
								</button>
							))}
						</div>

						{/* Tab content */}
						<div className="flex-1 overflow-hidden flex flex-col">
							{/* Projects Tab */}
							{activeTab === 'projects' && (
								<ProjectsTab
									theme={theme}
									isLoading={isLoading}
									error={error}
									filteredRepositories={filteredRepositories}
									categories={categories}
									selectedCategory={selectedCategory}
									onCategoryChange={handleCategoryChange}
									searchQuery={searchQuery}
									onSearchChange={handleSearchChange}
									selectedTileIndex={selectedTileIndex}
									onSelectRepo={handleSelectRepo}
									issueCounts={issueCounts}
									isLoadingIssueCounts={isLoadingIssueCounts}
									onRetry={() => refresh(true)}
									searchInputRef={searchInputRef}
									tileGridRef={tileGridRef}
								/>
							)}

							{/* Active Tab */}
							{activeTab === 'active' && (
								<ActiveTab
									theme={theme}
									activeContributions={activeContributions}
									prStatusMessage={prStatusSync.prStatusMessage}
									isCheckingPRStatuses={prStatusSync.isCheckingPRStatuses}
									syncingContributionId={prStatusSync.syncingContributionId}
									onCheckPRStatuses={prStatusSync.checkPRStatuses}
									onSyncContribution={prStatusSync.syncContribution}
									onFinalize={handleFinalize}
									onSwitchToProjects={() => setActiveTab('projects')}
									onSelectSession={onSelectSession}
									onCloseModal={onClose}
								/>
							)}

							{/* History Tab */}
							{activeTab === 'history' && (
								<HistoryTab
									theme={theme}
									stats={stats}
									formattedTotalTokens={formattedTotalTokens}
									formattedTotalCost={formattedTotalCost}
									completedContributions={completedContributions}
								/>
							)}

							{/* Stats Tab */}
							{activeTab === 'stats' && (
								<StatsTab
									theme={theme}
									formattedTotalTokens={formattedTotalTokens}
									formattedTotalCost={formattedTotalCost}
									formattedTotalTime={formattedTotalTime}
									uniqueRepos={uniqueRepos}
									currentStreakWeeks={currentStreakWeeks}
									longestStreakWeeks={longestStreakWeeks}
									achievements={achievements}
								/>
							)}
						</div>
					</>
				)}
			</div>
		</div>
	);

	return (
		<>
			{createPortal(modalContent, document.body)}
			{/* Pre-flight check dialog */}
			<BuildToolsWarningDialog
				theme={theme}
				isOpen={ghPreflight.isOpen}
				isChecking={ghPreflight.isChecking}
				ghCliStatus={ghPreflight.status}
				onConfirm={handleBuildWarningConfirm}
				onClose={ghPreflight.cancel}
			/>
			{/* Agent Creation Dialog */}
			{selectedRepo && selectedIssue && (
				<AgentCreationDialog
					theme={theme}
					isOpen={showAgentDialog}
					onClose={() => setShowAgentDialog(false)}
					repo={selectedRepo}
					issue={selectedIssue}
					onCreateAgent={handleCreateAgent}
				/>
			)}
		</>
	);
}

export default SymphonyModal;
