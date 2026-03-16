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

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
	Music,
	RefreshCw,
	X,
	Search,
	Loader2,
	ArrowLeft,
	ExternalLink,
	GitBranch,
	GitPullRequest,
	GitMerge,
	Clock,
	Zap,
	Play,
	Pause,
	AlertCircle,
	CheckCircle,
	Trophy,
	Flame,
	FileText,
	Hash,
	ChevronDown,
	HelpCircle,
	Github,
	Terminal,
	Lock,
	Star,
} from 'lucide-react';
import type { Theme, Session } from '../types';
import type {
	RegisteredRepository,
	SymphonyIssue,
	ActiveContribution,
	CompletedContribution,
	ContributionStatus,
} from '../../shared/symphony-types';
import { SYMPHONY_CATEGORIES, SYMPHONY_BLOCKING_LABEL } from '../../shared/symphony-constants';
import { COLORBLIND_AGENT_PALETTE } from '../constants/colorblindPalettes';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useSymphony } from '../hooks/symphony';
import { useContributorStats, type Achievement } from '../hooks/symphony/useContributorStats';
import { AgentCreationDialog, type AgentCreationConfig } from './AgentCreationDialog';
import { generateProseStyles, createMarkdownComponents } from '../utils/markdownConfig';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { formatCost, getActiveLocale } from '../utils/formatters';

// ============================================================================
// Types
// ============================================================================

export interface SymphonyContributionData {
	contributionId: string;
	localPath: string;
	autoRunPath?: string;
	branchName?: string;
	draftPrNumber?: number;
	draftPrUrl?: string;
	agentType: string;
	sessionName: string;
	repo: RegisteredRepository;
	issue: SymphonyIssue;
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
}

export interface SymphonyModalProps {
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
	onStartContribution: (data: SymphonyContributionData) => void;
	sessions: Session[];
	onSelectSession: (sessionId: string) => void;
}

type ModalTab = 'projects' | 'active' | 'history' | 'stats';

// ============================================================================
// Status Colors (Colorblind-Accessible)
// ============================================================================

const STATUS_COLORS: Record<string, string> = {
	cloning: COLORBLIND_AGENT_PALETTE[0], // #0077BB (Strong Blue)
	creating_pr: COLORBLIND_AGENT_PALETTE[0], // #0077BB
	running: COLORBLIND_AGENT_PALETTE[2], // #009988 (Teal - success)
	paused: COLORBLIND_AGENT_PALETTE[1], // #EE7733 (Orange - warning)
	completed: COLORBLIND_AGENT_PALETTE[2], // #009988 (Teal - success)
	completing: COLORBLIND_AGENT_PALETTE[0], // #0077BB
	ready_for_review: COLORBLIND_AGENT_PALETTE[8], // #AA4499 (Purple)
	failed: COLORBLIND_AGENT_PALETTE[3], // #CC3311 (Vermillion - error)
	cancelled: COLORBLIND_AGENT_PALETTE[6], // #BBBBBB (Gray)
};

// ============================================================================
// Helper Functions
// ============================================================================

function formatCacheAge(cacheAgeMs: number | null, t: (key: any, opts?: any) => string): string {
	if (cacheAgeMs === null || cacheAgeMs === 0) return t('symphony.cache_just_now');
	const seconds = Math.floor(cacheAgeMs / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	if (hours > 0) return t('symphony.cache_hours_ago', { count: hours });
	if (minutes > 0) return t('symphony.cache_minutes_ago', { count: minutes });
	return t('symphony.cache_just_now');
}

function formatDurationMs(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)}m`;
	return `${Math.floor(totalSeconds / 3600)}h ${Math.floor((totalSeconds % 3600) / 60)}m`;
}

function formatDate(isoString: string): string {
	return new Date(isoString).toLocaleDateString(getActiveLocale(), {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	});
}

function getStatusInfo(
	status: ContributionStatus,
	t: (key: any) => string
): {
	label: string;
	color: string;
	icon: React.ReactNode;
} {
	const icons: Record<string, React.ReactNode> = {
		cloning: <Loader2 className="w-3 h-3 animate-spin" />,
		creating_pr: <Loader2 className="w-3 h-3 animate-spin" />,
		running: <Play className="w-3 h-3" />,
		paused: <Pause className="w-3 h-3" />,
		completed: <CheckCircle className="w-3 h-3" />,
		completing: <Loader2 className="w-3 h-3 animate-spin" />,
		ready_for_review: <GitPullRequest className="w-3 h-3" />,
		failed: <AlertCircle className="w-3 h-3" />,
		cancelled: <X className="w-3 h-3" />,
	};
	const labelKeys: Record<string, string> = {
		cloning: 'symphony.status.cloning',
		creating_pr: 'symphony.status.creating_pr',
		running: 'symphony.status.running',
		paused: 'symphony.status.paused',
		completed: 'symphony.status.completed',
		completing: 'symphony.status.completing',
		ready_for_review: 'symphony.status.ready_for_review',
		failed: 'symphony.status.failed',
		cancelled: 'symphony.status.cancelled',
	};
	return {
		label: labelKeys[status] ? t(labelKeys[status]) : status,
		color: STATUS_COLORS[status] ?? '#6b7280',
		icon: icons[status] ?? null,
	};
}

// ============================================================================
// Skeleton Components
// ============================================================================

function RepositoryTileSkeleton({ theme }: { theme: Theme }) {
	return (
		<div
			className="p-4 rounded-lg border animate-pulse"
			style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
		>
			<div className="flex items-center gap-2 mb-2">
				<div className="w-16 h-5 rounded" style={{ backgroundColor: theme.colors.bgMain }} />
			</div>
			<div className="h-5 w-3/4 rounded mb-1" style={{ backgroundColor: theme.colors.bgMain }} />
			<div className="h-4 w-full rounded mb-1" style={{ backgroundColor: theme.colors.bgMain }} />
			<div className="h-4 w-2/3 rounded mb-3" style={{ backgroundColor: theme.colors.bgMain }} />
			<div className="flex justify-between">
				<div className="h-3 w-20 rounded" style={{ backgroundColor: theme.colors.bgMain }} />
				<div className="h-3 w-12 rounded" style={{ backgroundColor: theme.colors.bgMain }} />
			</div>
		</div>
	);
}

// ============================================================================
// Helpers
// ============================================================================

const compactNumber = new Intl.NumberFormat('en', {
	notation: 'compact',
	maximumFractionDigits: 1,
});

// ============================================================================
// Repository Tile
// ============================================================================

function RepositoryTile({
	repo,
	theme,
	isSelected,
	onSelect,
	issueCount,
}: {
	repo: RegisteredRepository;
	theme: Theme;
	isSelected: boolean;
	onSelect: () => void;
	issueCount: number | null;
}) {
	const { t } = useTranslation('modals');
	const tileRef = useRef<HTMLButtonElement>(null);
	const categoryInfo = SYMPHONY_CATEGORIES[repo.category] ?? { label: repo.category, emoji: '📦' };
	const hasNoIssues = issueCount !== null && issueCount === 0;

	useEffect(() => {
		if (isSelected && tileRef.current) {
			tileRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		}
	}, [isSelected]);

	return (
		<button
			ref={tileRef}
			onClick={onSelect}
			className={`p-4 rounded-lg border text-left transition-all hover:scale-[1.02] ${isSelected ? 'ring-2' : ''}`}
			style={{
				backgroundColor: theme.colors.bgActivity,
				borderColor: isSelected ? theme.colors.accent : theme.colors.border,
				opacity: hasNoIssues ? 0.45 : 1,
				...(isSelected && { boxShadow: `0 0 0 2px ${theme.colors.accent}` }),
			}}
		>
			<div className="flex items-center justify-between mb-2">
				<span
					className="px-2 py-0.5 rounded text-xs flex items-center gap-1"
					style={{ backgroundColor: `${theme.colors.accent}20`, color: theme.colors.accent }}
				>
					<span>{categoryInfo.emoji}</span>
					<span>{categoryInfo.label}</span>
				</span>
				{repo.stars != null && (
					<span
						className="flex items-center gap-1 text-xs tabular-nums"
						style={{ color: theme.colors.textDim }}
					>
						<Star className="w-3 h-3" style={{ fill: 'currentColor' }} />
						{compactNumber.format(repo.stars)}
					</span>
				)}
			</div>

			<h3
				className="font-semibold mb-1 line-clamp-1"
				style={{ color: theme.colors.textMain }}
				title={repo.name}
			>
				{repo.name}
			</h3>

			<p className="text-sm line-clamp-2 mb-3" style={{ color: theme.colors.textDim }}>
				{repo.description}
			</p>

			<div
				className="flex items-center justify-between text-xs"
				style={{ color: theme.colors.textDim }}
			>
				<span>{repo.maintainer.name}</span>
				{issueCount === null ? (
					<span className="flex items-center gap-1" style={{ color: theme.colors.accent }}>
						<Hash className="w-3 h-3" />
						{t('symphony.projects.view_issues')}
					</span>
				) : issueCount > 0 ? (
					<span className="flex items-center gap-1" style={{ color: theme.colors.accent }}>
						<Hash className="w-3 h-3" />
						{t('symphony.projects.view_issues_count', { count: issueCount })}
					</span>
				) : (
					<span className="flex items-center gap-1" style={{ color: theme.colors.textDim }}>
						{t('symphony.projects.no_issues')}
					</span>
				)}
			</div>
		</button>
	);
}

// ============================================================================
// Issue Card (for Projects Tab detail view)
// ============================================================================

function IssueCard({
	issue,
	theme,
	isSelected,
	onSelect,
}: {
	issue: SymphonyIssue;
	theme: Theme;
	isSelected: boolean;
	onSelect: () => void;
}) {
	const { t } = useTranslation('modals');
	const isBlocked = issue.labels?.some(
		(l) => l.name.toLowerCase() === SYMPHONY_BLOCKING_LABEL.toLowerCase()
	);
	const isAvailable = issue.status === 'available' && !isBlocked;
	const isClaimed = issue.status === 'in_progress';
	const isSelectable = isAvailable || isBlocked;

	return (
		<div
			role="button"
			tabIndex={isSelectable ? 0 : -1}
			onClick={isSelectable ? onSelect : undefined}
			onKeyDown={
				isSelectable
					? (e) => {
							if (e.target !== e.currentTarget) return;
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								onSelect();
							}
						}
					: undefined
			}
			className={`w-full p-3 rounded-lg border text-left transition-all outline-none focus-visible:ring-2 ${
				isBlocked
					? 'opacity-75 hover:bg-white/5 cursor-pointer'
					: !isAvailable
						? 'opacity-60'
						: 'hover:bg-white/5 cursor-pointer'
			} ${isSelected ? 'ring-2' : ''}`}
			style={{
				backgroundColor: isSelected ? theme.colors.bgActivity : theme.colors.bgMain,
				borderColor: isSelected ? theme.colors.accent : theme.colors.border,
				...(isSelected && { boxShadow: `0 0 0 2px ${theme.colors.accent}` }),
			}}
		>
			<div className="flex items-start justify-between gap-2 mb-1">
				<h4
					className="font-medium text-sm flex items-center gap-2"
					style={{ color: isBlocked ? theme.colors.textDim : theme.colors.textMain }}
				>
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						#{issue.number}
					</span>
					{issue.title}
				</h4>
				<div className="flex items-center gap-1.5 shrink-0">
					{isBlocked && (
						<span
							className="px-1.5 py-0.5 rounded text-xs flex items-center gap-1"
							style={{
								backgroundColor: `${STATUS_COLORS.cancelled}20`,
								color: STATUS_COLORS.cancelled,
							}}
						>
							<Lock className="w-3 h-3" />
							{t('symphony.projects.blocked_label')}
						</span>
					)}
					{isClaimed && (
						<span
							className="px-1.5 py-0.5 rounded text-xs flex items-center gap-1"
							style={{
								backgroundColor: `${STATUS_COLORS.running}20`,
								color: STATUS_COLORS.running,
							}}
						>
							<GitPullRequest className="w-3 h-3" />
							{t('symphony.projects.claimed_label')}
						</span>
					)}
				</div>
			</div>

			<div
				className="flex flex-wrap items-center gap-3 text-xs"
				style={{ color: theme.colors.textDim }}
			>
				<span className="flex items-center gap-1">
					<FileText className="w-3 h-3" />
					{t('symphony.projects.document_count', { count: issue.documentPaths.length })}
				</span>
				{isClaimed && issue.claimedByPr && (
					<button
						type="button"
						className="flex items-center gap-1 cursor-pointer hover:underline"
						style={{ color: theme.colors.accent, pointerEvents: 'auto' }}
						onClick={(e) => {
							e.stopPropagation();
							window.maestro.shell.openExternal(issue.claimedByPr!.url);
						}}
					>
						<GitPullRequest className="w-3 h-3" />
						{issue.claimedByPr.isDraft
							? t('symphony.projects.draft_pr_by', {
									number: issue.claimedByPr.number,
									author: issue.claimedByPr.author,
								})
							: t('symphony.projects.pr_by', {
									number: issue.claimedByPr.number,
									author: issue.claimedByPr.author,
								})}
						<ExternalLink className="w-2.5 h-2.5" />
					</button>
				)}
			</div>

			{issue.documentPaths.length > 0 && (
				<div className="mt-2 text-xs" style={{ color: theme.colors.textDim }}>
					{issue.documentPaths.slice(0, 2).map((doc) => (
						<div key={doc.path} className="truncate">
							• {doc.name}
						</div>
					))}
					{issue.documentPaths.length > 2 && (
						<div>{t('symphony.projects.and_more', { count: issue.documentPaths.length - 2 })}</div>
					)}
				</div>
			)}
		</div>
	);
}

// ============================================================================
// Repository Detail View (Projects Tab)
// ============================================================================

function RepositoryDetailView({
	theme,
	repo,
	issues,
	isLoadingIssues,
	selectedIssue,
	documentPreview,
	isLoadingDocument,
	isStarting,
	onBack,
	onSelectIssue,
	onStartContribution,
	onPreviewDocument,
}: {
	theme: Theme;
	repo: RegisteredRepository;
	issues: SymphonyIssue[];
	isLoadingIssues: boolean;
	selectedIssue: SymphonyIssue | null;
	documentPreview: string | null;
	isLoadingDocument: boolean;
	isStarting: boolean;
	onBack: () => void;
	onSelectIssue: (issue: SymphonyIssue) => void;
	onStartContribution: () => void;
	onPreviewDocument: (path: string, isExternal: boolean) => void;
}) {
	const { t } = useTranslation('modals');
	const categoryInfo = SYMPHONY_CATEGORIES[repo.category] ?? { label: repo.category, emoji: '📦' };
	const isIssueBlocked = (i: SymphonyIssue) =>
		i.labels?.some((l) => l.name.toLowerCase() === SYMPHONY_BLOCKING_LABEL.toLowerCase());
	const availableIssues = issues.filter((i) => i.status === 'available' && !isIssueBlocked(i));
	const blockedIssues = issues.filter((i) => i.status === 'available' && isIssueBlocked(i));
	const inProgressIssues = issues.filter((i) => i.status === 'in_progress');
	const [selectedDocIndex, setSelectedDocIndex] = useState<number>(0);
	const [showDocDropdown, setShowDocDropdown] = useState(false);
	const dropdownRef = useRef<HTMLDivElement>(null);

	// Generate prose styles scoped to symphony preview panel
	const proseStyles = useMemo(
		() =>
			generateProseStyles({
				theme,
				coloredHeadings: true,
				compactSpacing: false,
				includeCheckboxStyles: true,
				scopeSelector: '.symphony-preview',
			}),
		[theme]
	);

	// Create markdown components with link handling
	const markdownComponents = useMemo(
		() =>
			createMarkdownComponents({
				theme,
				onExternalLinkClick: (href) => window.maestro.shell.openExternal(href),
			}),
		[theme]
	);

	// Close dropdown when clicking outside
	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
				setShowDocDropdown(false);
			}
		};
		document.addEventListener('mousedown', handleClickOutside);
		return () => document.removeEventListener('mousedown', handleClickOutside);
	}, []);

	// Auto-load first document when issue is selected
	useEffect(() => {
		if (selectedIssue && selectedIssue.documentPaths.length > 0) {
			const firstDoc = selectedIssue.documentPaths[0];
			setSelectedDocIndex(0);
			onPreviewDocument(firstDoc.path, firstDoc.isExternal);
		}
	}, [selectedIssue, onPreviewDocument]);

	// Keyboard shortcuts for document navigation: Cmd+Shift+[ and Cmd+Shift+]
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (!selectedIssue || selectedIssue.documentPaths.length === 0) return;

			if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '[' || e.key === ']')) {
				e.preventDefault();

				const docCount = selectedIssue.documentPaths.length;
				let newIndex: number;

				if (e.key === '[') {
					// Go backwards, wrap around
					newIndex = selectedDocIndex <= 0 ? docCount - 1 : selectedDocIndex - 1;
				} else {
					// Go forwards, wrap around
					newIndex = selectedDocIndex >= docCount - 1 ? 0 : selectedDocIndex + 1;
				}

				const doc = selectedIssue.documentPaths[newIndex];
				setSelectedDocIndex(newIndex);
				onPreviewDocument(doc.path, doc.isExternal);
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [selectedIssue, selectedDocIndex, onPreviewDocument]);

	const handleSelectDoc = (index: number) => {
		if (!selectedIssue) return;
		const doc = selectedIssue.documentPaths[index];
		setSelectedDocIndex(index);
		setShowDocDropdown(false);
		onPreviewDocument(doc.path, doc.isExternal);
	};

	const handleOpenExternal = useCallback((url: string) => {
		window.maestro.shell.openExternal(url);
	}, []);

	return (
		<div className="flex flex-col h-full overflow-hidden">
			{/* Header */}
			<div
				className="flex items-center justify-between px-4 py-3 border-b shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-3">
					<button
						onClick={onBack}
						className="p-1.5 rounded hover:bg-white/10 transition-colors"
						title={t('symphony.projects.back_tooltip')}
					>
						<ArrowLeft className="w-5 h-5" style={{ color: theme.colors.textDim }} />
					</button>
					<div className="flex items-center gap-2">
						<Music className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h2 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
							{t('symphony.projects.detail_title', { name: repo.name })}
						</h2>
					</div>
				</div>
				<div className="flex items-center gap-3">
					<span
						className="px-2 py-0.5 rounded text-xs flex items-center gap-1"
						style={{ backgroundColor: `${theme.colors.accent}20`, color: theme.colors.accent }}
					>
						<span>{categoryInfo.emoji}</span>
						<span>{categoryInfo.label}</span>
					</span>
					<button
						type="button"
						className="p-1.5 rounded hover:bg-white/10 transition-colors"
						title={t('symphony.projects.view_repo_tooltip')}
						onClick={() => handleOpenExternal(repo.url)}
					>
						<ExternalLink className="w-5 h-5" style={{ color: theme.colors.textDim }} />
					</button>
				</div>
			</div>

			{/* Content */}
			<div className="flex-1 flex min-h-0 overflow-hidden">
				{/* Left: Repository info + Issue list */}
				<div
					className="w-80 shrink-0 p-4 border-r overflow-y-auto"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="mb-4">
						<h4
							className="text-xs font-semibold mb-1 uppercase tracking-wide"
							style={{ color: theme.colors.textDim }}
						>
							{t('symphony.projects.about_label')}
						</h4>
						<p className="text-sm" style={{ color: theme.colors.textMain }}>
							{repo.description}
						</p>
					</div>

					<div className="mb-4">
						<h4
							className="text-xs font-semibold mb-1 uppercase tracking-wide"
							style={{ color: theme.colors.textDim }}
						>
							{t('symphony.projects.maintainer_label')}
						</h4>
						{repo.maintainer.url ? (
							<button
								type="button"
								className="text-sm hover:underline inline-flex items-center gap-1"
								style={{ color: theme.colors.accent }}
								onClick={() => handleOpenExternal(repo.maintainer.url!)}
							>
								{repo.maintainer.name}
								<ExternalLink className="w-3 h-3" />
							</button>
						) : (
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								{repo.maintainer.name}
							</p>
						)}
					</div>

					{repo.tags && repo.tags.length > 0 && (
						<div className="mb-4">
							<h4
								className="text-xs font-semibold mb-1 uppercase tracking-wide"
								style={{ color: theme.colors.textDim }}
							>
								{t('symphony.projects.tags_label')}
							</h4>
							<div className="flex flex-wrap gap-1">
								{repo.tags.map((tag) => (
									<span
										key={tag}
										className="px-2 py-0.5 rounded text-xs"
										style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}
									>
										{tag}
									</span>
								))}
							</div>
						</div>
					)}

					<div className="border-t my-4" style={{ borderColor: theme.colors.border }} />

					{isLoadingIssues ? (
						<div className="space-y-2">
							{['issue-skeleton-1', 'issue-skeleton-2', 'issue-skeleton-3'].map((skeletonId) => (
								<div
									key={skeletonId}
									className="h-20 rounded animate-pulse"
									style={{ backgroundColor: theme.colors.bgMain }}
								/>
							))}
						</div>
					) : issues.length === 0 ? (
						<p className="text-sm text-center py-4" style={{ color: theme.colors.textDim }}>
							{t('symphony.projects.no_labeled_issues')}
						</p>
					) : (
						<>
							{/* In-Progress Issues Section */}
							{inProgressIssues.length > 0 && (
								<div className="mb-4">
									<h4
										className="text-xs font-semibold mb-2 uppercase tracking-wide flex items-center gap-2"
										style={{ color: STATUS_COLORS.running }}
									>
										<GitPullRequest className="w-3 h-3" />
										<span>
											{t('symphony.projects.in_progress_label', { count: inProgressIssues.length })}
										</span>
									</h4>
									<div className="space-y-2">
										{inProgressIssues.map((issue) => (
											<IssueCard
												key={issue.number}
												issue={issue}
												theme={theme}
												isSelected={selectedIssue?.number === issue.number}
												onSelect={() => onSelectIssue(issue)}
											/>
										))}
									</div>
								</div>
							)}

							{/* Available Issues Section */}
							<div>
								<h4
									className="text-xs font-semibold mb-2 uppercase tracking-wide flex items-center justify-between"
									style={{ color: theme.colors.textDim }}
								>
									<span>
										{t('symphony.projects.available_issues_label', {
											count: availableIssues.length,
										})}
									</span>
									{isLoadingIssues && (
										<Loader2
											className="w-3 h-3 animate-spin"
											style={{ color: theme.colors.accent }}
										/>
									)}
								</h4>
								{availableIssues.length === 0 && blockedIssues.length === 0 ? (
									<p className="text-sm text-center py-4" style={{ color: theme.colors.textDim }}>
										{t('symphony.projects.all_issues_in_progress')}
									</p>
								) : (
									<div className="space-y-2">
										{availableIssues.map((issue) => (
											<IssueCard
												key={issue.number}
												issue={issue}
												theme={theme}
												isSelected={selectedIssue?.number === issue.number}
												onSelect={() => onSelectIssue(issue)}
											/>
										))}
									</div>
								)}
							</div>

							{/* Blocked Issues Section */}
							{blockedIssues.length > 0 && (
								<div className="mt-4">
									<h4
										className="text-xs font-semibold mb-2 uppercase tracking-wide flex items-center gap-2"
										style={{ color: STATUS_COLORS.cancelled }}
									>
										<Lock className="w-3 h-3" />
										<span>
											{t('symphony.projects.blocked_issues_label', { count: blockedIssues.length })}
										</span>
									</h4>
									<div className="space-y-2">
										{blockedIssues.map((issue) => (
											<IssueCard
												key={issue.number}
												issue={issue}
												theme={theme}
												isSelected={selectedIssue?.number === issue.number}
												onSelect={() => onSelectIssue(issue)}
											/>
										))}
									</div>
								</div>
							)}
						</>
					)}
				</div>

				{/* Right: Issue preview */}
				<div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
					{selectedIssue ? (
						<>
							<div
								className="px-4 py-3 border-b shrink-0"
								style={{ borderColor: theme.colors.border }}
							>
								<div className="flex items-center justify-between mb-1">
									<div className="flex items-center gap-2">
										<span className="text-sm" style={{ color: theme.colors.textDim }}>
											#{selectedIssue.number}
										</span>
										<h3 className="font-semibold" style={{ color: theme.colors.textMain }}>
											{selectedIssue.title}
										</h3>
									</div>
									<button
										type="button"
										className="text-xs hover:underline flex items-center gap-1"
										style={{ color: theme.colors.accent }}
										onClick={() => handleOpenExternal(selectedIssue.htmlUrl)}
										title={t('symphony.projects.view_issue_tooltip')}
									>
										{t('symphony.projects.view_issue_button')}
										<ExternalLink className="w-3 h-3" />
									</button>
								</div>
								<div
									className="flex items-center gap-2 text-xs"
									style={{ color: theme.colors.textDim }}
								>
									<FileText className="w-3 h-3" />
									<span>
										{t('symphony.projects.documents_to_process', {
											count: selectedIssue.documentPaths.length,
										})}
									</span>
								</div>
							</div>

							{/* Document selector dropdown */}
							<div
								className="px-4 py-3 border-b shrink-0"
								style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
							>
								<div className="relative" ref={dropdownRef}>
									<button
										onClick={() => setShowDocDropdown(!showDocDropdown)}
										className="w-full flex items-center justify-between px-3 py-2 rounded text-sm"
										style={{
											backgroundColor: theme.colors.bgActivity,
											color: theme.colors.textMain,
											border: `1px solid ${theme.colors.border}`,
										}}
									>
										<span>
											{selectedIssue.documentPaths[selectedDocIndex]?.name ||
												t('symphony.projects.select_document')}
										</span>
										<ChevronDown
											className={`w-4 h-4 transition-transform ${showDocDropdown ? 'rotate-180' : ''}`}
										/>
									</button>

									{showDocDropdown && (
										<div
											className="absolute top-full left-0 right-0 mt-1 rounded shadow-lg z-10 overflow-hidden max-h-64 overflow-y-auto"
											style={{
												backgroundColor: theme.colors.bgSidebar,
												border: `1px solid ${theme.colors.border}`,
											}}
										>
											{selectedIssue.documentPaths.map((doc, index) => (
												<button
													key={doc.name}
													onClick={() => handleSelectDoc(index)}
													className="w-full px-3 py-2 text-sm text-left hover:bg-white/5 transition-colors"
													style={{
														color:
															selectedDocIndex === index
																? theme.colors.accent
																: theme.colors.textMain,
														backgroundColor:
															selectedDocIndex === index ? theme.colors.bgActivity : 'transparent',
													}}
												>
													{doc.name}
												</button>
											))}
										</div>
									)}
								</div>
							</div>

							{/* Document preview - Markdown preview scrollable container with prose styles */}
							<div
								className="symphony-preview flex-1 min-h-0 p-4"
								style={{ backgroundColor: theme.colors.bgMain, overflowY: 'auto' }}
							>
								<style>{proseStyles}</style>
								{isLoadingDocument ? (
									<div className="flex items-center justify-center h-32">
										<Loader2
											className="w-6 h-6 animate-spin"
											style={{ color: theme.colors.accent }}
										/>
									</div>
								) : documentPreview ? (
									<div
										className="prose prose-sm max-w-none"
										style={{ color: theme.colors.textMain }}
									>
										<ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
											{documentPreview}
										</ReactMarkdown>
									</div>
								) : (
									<div className="flex flex-col items-center justify-center h-full">
										<FileText className="w-12 h-12 mb-3" style={{ color: theme.colors.textDim }} />
										<p style={{ color: theme.colors.textDim }}>
											{t('symphony.projects.select_document_preview')}
										</p>
									</div>
								)}
							</div>
						</>
					) : (
						<div
							className="flex-1 flex items-center justify-center"
							style={{ backgroundColor: theme.colors.bgMain }}
						>
							<div className="text-center">
								{!isLoadingIssues && issues.length === 0 ? (
									<>
										<CheckCircle
											className="w-12 h-12 mx-auto mb-3"
											style={{ color: theme.colors.textDim }}
										/>
										<p className="text-sm" style={{ color: theme.colors.textMain }}>
											{t('symphony.projects.no_outstanding_work')}
										</p>
										<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
											{t('symphony.projects.no_labeled_issues')}
										</p>
									</>
								) : (
									<>
										<Music
											className="w-12 h-12 mx-auto mb-3"
											style={{ color: theme.colors.textDim }}
										/>
										<p style={{ color: theme.colors.textDim }}>
											{t('symphony.projects.select_issue_details')}
										</p>
									</>
								)}
							</div>
						</div>
					)}
				</div>
			</div>

			{/* Footer */}
			{selectedIssue && selectedIssue.status === 'available' && (
				<div
					className="shrink-0 px-4 py-3 border-t flex items-center justify-between"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
				>
					<div className="flex items-center gap-2 text-sm" style={{ color: theme.colors.textDim }}>
						{isIssueBlocked(selectedIssue) ? (
							<>
								<Lock className="w-4 h-4" />
								<span>{t('symphony.projects.blocked_dependency_message')}</span>
							</>
						) : (
							<>
								<GitBranch className="w-4 h-4" />
								<span>{t('symphony.projects.will_clone_message')}</span>
							</>
						)}
					</div>
					<button
						onClick={isIssueBlocked(selectedIssue) ? undefined : onStartContribution}
						disabled={isStarting || isIssueBlocked(selectedIssue)}
						className="px-4 py-2 rounded font-semibold text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
					>
						{isStarting ? (
							<>
								<Loader2 className="w-4 h-4 animate-spin" />
								{t('symphony.projects.starting_button')}
							</>
						) : (
							<>
								<Play className="w-4 h-4" />
								{t('symphony.projects.start_symphony_button')}
							</>
						)}
					</button>
				</div>
			)}
		</div>
	);
}

// ============================================================================
// Active Contribution Card
// ============================================================================

function ActiveContributionCard({
	contribution,
	theme,
	onFinalize,
	onSync,
	isSyncing,
	sessionName,
	onNavigateToSession,
}: {
	contribution: ActiveContribution;
	theme: Theme;
	onFinalize: () => void;
	onSync: () => void;
	isSyncing: boolean;
	sessionName: string | null;
	onNavigateToSession: () => void;
}) {
	const { t } = useTranslation('modals');
	const statusInfo = getStatusInfo(contribution.status, t);
	const docProgress =
		contribution.progress.totalDocuments > 0
			? Math.round(
					(contribution.progress.completedDocuments / contribution.progress.totalDocuments) * 100
				)
			: 0;

	const canFinalize = contribution.status === 'ready_for_review';

	const handleOpenExternal = useCallback((url: string) => {
		window.maestro.shell.openExternal(url);
	}, []);

	return (
		<div
			className="p-4 rounded-lg border"
			style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
		>
			<div className="flex items-start justify-between mb-2">
				<div className="flex-1 min-w-0">
					<h4
						className="font-medium text-sm truncate flex items-center gap-2"
						style={{ color: theme.colors.textMain }}
					>
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							#{contribution.issueNumber}
						</span>
						{contribution.issueTitle}
					</h4>
					<p className="text-xs truncate" style={{ color: theme.colors.textDim }}>
						{contribution.repoSlug}
					</p>
					{sessionName && (
						<button
							onClick={onNavigateToSession}
							className="flex items-center gap-1 text-xs mt-0.5 hover:underline cursor-pointer"
							style={{ color: theme.colors.accent }}
							title={`Go to session: ${sessionName}`}
						>
							<Terminal className="w-3 h-3" />
							<span className="truncate">{sessionName}</span>
						</button>
					)}
				</div>
				<div className="flex items-center gap-2 shrink-0">
					<button
						onClick={onSync}
						disabled={isSyncing}
						className="p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
						title={t('symphony.active.sync_tooltip')}
					>
						<RefreshCw
							className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`}
							style={{ color: theme.colors.textDim }}
						/>
					</button>
					<div
						className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs"
						style={{ backgroundColor: statusInfo.color + '20', color: statusInfo.color }}
					>
						{statusInfo.icon}
						<span>{statusInfo.label}</span>
					</div>
				</div>
			</div>

			{contribution.draftPrUrl ? (
				<button
					type="button"
					className="flex items-center gap-1 text-xs mb-2 hover:underline"
					style={{ color: theme.colors.accent }}
					onClick={() => handleOpenExternal(contribution.draftPrUrl!)}
				>
					<GitPullRequest className="w-3 h-3" />
					{t('symphony.active.draft_pr', { number: contribution.draftPrNumber })}
					<ExternalLink className="w-3 h-3" />
				</button>
			) : (
				<div
					className="flex items-center gap-1 text-xs mb-2"
					style={{ color: theme.colors.textDim }}
				>
					<GitBranch className="w-3 h-3" />
					<span>{t('symphony.active.pr_on_first_commit')}</span>
				</div>
			)}

			<div className="mb-2">
				<div className="flex items-center justify-between text-xs mb-1">
					<span style={{ color: theme.colors.textDim }}>
						{t('symphony.active.documents_progress', {
							completed: contribution.progress.completedDocuments,
							total: contribution.progress.totalDocuments,
						})}
					</span>
					<span style={{ color: theme.colors.textDim }}>
						<Clock className="w-3 h-3 inline mr-1" />
						{formatDurationMs(contribution.timeSpent)}
					</span>
				</div>
				<div
					className="h-1.5 rounded-full overflow-hidden"
					style={{ backgroundColor: theme.colors.bgMain }}
				>
					<div
						className="h-full rounded-full transition-all duration-300"
						style={{ width: `${docProgress}%`, backgroundColor: theme.colors.accent }}
					/>
				</div>
				{contribution.progress.currentDocument && (
					<p className="text-xs mt-1 truncate" style={{ color: theme.colors.textDim }}>
						{t('symphony.active.current_document', {
							document: contribution.progress.currentDocument,
						})}
					</p>
				)}
			</div>

			{contribution.tokenUsage && (
				<div
					className="flex items-center gap-4 text-xs mb-2"
					style={{ color: theme.colors.textDim }}
				>
					<span>
						{t('symphony.active.tokens_in', {
							count: Math.round(contribution.tokenUsage.inputTokens / 1000),
						})}
					</span>
					<span>
						{t('symphony.active.tokens_out', {
							count: Math.round(contribution.tokenUsage.outputTokens / 1000),
						})}
					</span>
					<span>{formatCost(contribution.tokenUsage.estimatedCost)}</span>
				</div>
			)}

			{contribution.error && (
				<p
					className="text-xs mb-2 p-2 rounded"
					style={{ backgroundColor: `${STATUS_COLORS.failed}20`, color: STATUS_COLORS.failed }}
				>
					{contribution.error}
				</p>
			)}

			{canFinalize && (
				<button
					onClick={onFinalize}
					className="w-full py-1.5 rounded text-xs flex items-center justify-center gap-1"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
				>
					<GitPullRequest className="w-3 h-3" /> {t('symphony.active.finalize_pr_button')}
				</button>
			)}
		</div>
	);
}

// ============================================================================
// Completed Contribution Card
// ============================================================================

function CompletedContributionCard({
	contribution,
	theme,
}: {
	contribution: CompletedContribution;
	theme: Theme;
}) {
	const { t } = useTranslation('modals');
	const handleOpenPR = useCallback(() => {
		window.maestro.shell.openExternal(contribution.prUrl);
	}, [contribution.prUrl]);

	// Check both wasMerged (preferred) and merged (legacy) for backward compatibility
	const isMerged = contribution.wasMerged ?? contribution.merged ?? false;
	const isClosed = contribution.wasClosed ?? false;

	// Format token count (e.g., 666.0K)
	const totalTokens = contribution.tokenUsage.inputTokens + contribution.tokenUsage.outputTokens;
	const formattedTokens =
		totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}K` : String(totalTokens);

	return (
		<div
			className="p-4 rounded-lg border"
			style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
		>
			<div className="flex items-start justify-between mb-2">
				<div className="flex-1 min-w-0">
					<h4
						className="font-medium text-sm truncate flex items-center gap-2"
						style={{ color: theme.colors.textMain }}
					>
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							#{contribution.issueNumber}
						</span>
						{contribution.issueTitle}
					</h4>
					<p className="text-xs truncate" style={{ color: theme.colors.textDim }}>
						{contribution.repoSlug}
					</p>
				</div>
				{isMerged ? (
					<span
						className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs"
						style={{
							backgroundColor: `${STATUS_COLORS.ready_for_review}20`,
							color: STATUS_COLORS.ready_for_review,
						}}
					>
						<GitMerge className="w-3 h-3" /> {t('symphony.history.merged_label')}
					</span>
				) : isClosed ? (
					<span
						className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs"
						style={{
							backgroundColor: `${STATUS_COLORS.cancelled}20`,
							color: STATUS_COLORS.cancelled,
						}}
					>
						<X className="w-3 h-3" /> {t('symphony.history.closed_label')}
					</span>
				) : (
					<span
						className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs"
						style={{ backgroundColor: `${STATUS_COLORS.running}20`, color: STATUS_COLORS.running }}
					>
						<GitPullRequest className="w-3 h-3" /> {t('symphony.history.open_label')}
					</span>
				)}
			</div>

			<div className="flex items-center gap-3 text-xs mb-2">
				<span style={{ color: theme.colors.textDim }}>
					{t('symphony.history.completed_date', { date: formatDate(contribution.completedAt) })}
				</span>
				<button
					onClick={handleOpenPR}
					className="flex items-center gap-1 hover:underline"
					style={{ color: theme.colors.accent }}
				>
					<GitPullRequest className="w-3 h-3" />
					{t('symphony.history.pr_number', { number: contribution.prNumber })}
					<ExternalLink className="w-2.5 h-2.5" />
				</button>
			</div>

			<div className="grid grid-cols-4 gap-2 text-xs">
				<div>
					<span style={{ color: theme.colors.textDim }}>
						{t('symphony.history.documents_label')}
					</span>
					<p style={{ color: theme.colors.textMain }}>{contribution.documentsProcessed}</p>
				</div>
				<div>
					<span style={{ color: theme.colors.textDim }}>{t('symphony.history.tasks_label')}</span>
					<p style={{ color: theme.colors.textMain }}>{contribution.tasksCompleted}</p>
				</div>
				<div>
					<span style={{ color: theme.colors.textDim }}>{t('symphony.history.tokens_label')}</span>
					<p style={{ color: theme.colors.textMain }}>{formattedTokens}</p>
				</div>
				<div>
					<span style={{ color: theme.colors.textDim }}>{t('symphony.history.cost_label')}</span>
					<p style={{ color: theme.colors.accent }}>
						{formatCost(contribution.tokenUsage.totalCost)}
					</p>
				</div>
			</div>
		</div>
	);
}

// ============================================================================
// Achievement Card
// ============================================================================

function AchievementCard({ achievement, theme }: { achievement: Achievement; theme: Theme }) {
	return (
		<div
			className="p-3 rounded-lg border"
			style={{
				backgroundColor: theme.colors.bgActivity,
				borderColor: achievement.earned ? theme.colors.accent : theme.colors.border,
				opacity: achievement.earned ? 1 : 0.5,
			}}
		>
			<div className="flex items-center gap-3">
				<div className="text-2xl" style={{ opacity: achievement.earned ? 1 : 0.7 }}>
					{achievement.icon}
				</div>
				<div className="flex-1 min-w-0">
					<h4 className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
						{achievement.title}
					</h4>
					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						{achievement.description}
					</p>
					{!achievement.earned && achievement.progress !== undefined && (
						<div className="mt-1">
							<div
								className="h-1 rounded-full overflow-hidden"
								style={{ backgroundColor: theme.colors.bgMain }}
							>
								<div
									className="h-full rounded-full"
									style={{
										width: `${achievement.progress}%`,
										backgroundColor: theme.colors.accent,
									}}
								/>
							</div>
						</div>
					)}
				</div>
				{achievement.earned && (
					<CheckCircle className="w-5 h-5 shrink-0" style={{ color: STATUS_COLORS.running }} />
				)}
			</div>
		</div>
	);
}

// ============================================================================
// Main SymphonyModal
// ============================================================================

export function SymphonyModal({
	theme,
	isOpen,
	onClose,
	onStartContribution,
	sessions,
	onSelectSession,
}: SymphonyModalProps) {
	const { t } = useTranslation('modals');
	const { t: tA } = useTranslation('accessibility');
	const { registerLayer, unregisterLayer } = useLayerStack();
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
	const [documentPreview, setDocumentPreview] = useState<string | null>(null);
	const [isLoadingDocument, setIsLoadingDocument] = useState(false);
	const [isStarting, setIsStarting] = useState(false);
	const [showAgentDialog, setShowAgentDialog] = useState(false);
	const [showBuildWarning, setShowBuildWarning] = useState(false);
	const [ghCliStatus, setGhCliStatus] = useState<{
		installed: boolean;
		authenticated: boolean;
	} | null>(null);
	const [isCheckingGh, setIsCheckingGh] = useState(false);
	const [showHelp, setShowHelp] = useState(false);
	const [isCheckingPRStatuses, setIsCheckingPRStatuses] = useState(false);
	const [prStatusMessage, setPrStatusMessage] = useState<string | null>(null);
	const [syncingContributionId, setSyncingContributionId] = useState<string | null>(null);

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
		setDocumentPreview(null);
	}, [selectRepository]);

	const handleBackRef = useRef(handleBack);
	handleBackRef.current = handleBack;

	// Layer stack
	useEffect(() => {
		if (isOpen) {
			const id = registerLayer({
				type: 'modal',
				priority: MODAL_PRIORITIES.SYMPHONY ?? 710,
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'strict',
				ariaLabel: 'Maestro Symphony',
				onEscape: () => {
					if (showHelpRef.current) {
						setShowHelp(false);
					} else if (showDetailViewRef.current) {
						handleBackRef.current();
					} else {
						onCloseRef.current();
					}
				},
			});
			return () => unregisterLayer(id);
		}
	}, [isOpen, registerLayer, unregisterLayer]);

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
			setDocumentPreview(null);
		},
		[selectRepository]
	);

	// Select issue
	const handleSelectIssue = useCallback(async (issue: SymphonyIssue) => {
		setSelectedIssue(issue);
		setDocumentPreview(null);
	}, []);

	// Preview document - fetches content from external URLs (GitHub attachments)
	const handlePreviewDocument = useCallback(
		async (path: string, isExternal: boolean) => {
			if (!selectedRepo) return;
			setIsLoadingDocument(true);
			setDocumentPreview(null);

			try {
				if (isExternal && path.startsWith('http')) {
					// Fetch content from external URL via main process (to avoid CORS)
					const result = await window.maestro.symphony.fetchDocumentContent(path);
					if (result.success && result.content) {
						setDocumentPreview(result.content);
					} else {
						setDocumentPreview(`*Failed to load document: ${result.error || 'Unknown error'}*`);
					}
				} else {
					// For repo-relative paths, we can't preview until contribution starts
					setDocumentPreview(
						`*This document is located at \`${path}\` in the repository and will be available when you start the contribution.*`
					);
				}
			} catch (error) {
				console.error('Failed to fetch document:', error);
				setDocumentPreview(
					`*Failed to load document: ${error instanceof Error ? error.message : 'Unknown error'}*`
				);
			} finally {
				setIsLoadingDocument(false);
			}
		},
		[selectedRepo]
	);

	// Start contribution - check gh CLI and show build warning
	const handleStartContribution = useCallback(() => {
		if (!selectedRepo || !selectedIssue) return;
		setGhCliStatus(null);
		setIsCheckingGh(true);
		setShowBuildWarning(true);
		window.maestro.git
			.checkGhCli()
			.then((status) => setGhCliStatus(status))
			.catch(() => setGhCliStatus({ installed: false, authenticated: false }))
			.finally(() => setIsCheckingGh(false));
	}, [selectedRepo, selectedIssue]);

	const handleBuildWarningConfirm = useCallback(() => {
		setShowBuildWarning(false);
		setShowAgentDialog(true);
	}, []);

	// Handle agent creation from dialog
	const handleCreateAgent = useCallback(
		async (config: AgentCreationConfig): Promise<{ success: boolean; error?: string }> => {
			if (!selectedRepo || !selectedIssue) {
				return { success: false, error: t('symphony.error.no_repo_or_issue') };
			}

			setIsStarting(true);
			const result = await startContribution(
				config.repo,
				config.issue,
				config.agentType,
				'', // session ID will be generated by the backend
				config.workingDirectory // Pass the working directory for cloning
			);
			setIsStarting(false);

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

			return { success: false, error: result.error ?? t('symphony.error.failed_to_start') };
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

	// Sync individual contribution status with GitHub
	const handleSyncContribution = useCallback(async (contributionId: string) => {
		setSyncingContributionId(contributionId);
		try {
			const result = await window.maestro.symphony.syncContribution(contributionId);
			if (result.message) {
				setPrStatusMessage(result.message);
				setTimeout(() => setPrStatusMessage(null), 5000);
			}
		} catch (err) {
			console.error('Failed to sync contribution:', err);
			setPrStatusMessage(t('symphony.active.sync_failed'));
			setTimeout(() => setPrStatusMessage(null), 5000);
		} finally {
			setSyncingContributionId(null);
		}
	}, []);

	// Check PR statuses (merged/closed) and update history
	const handleCheckPRStatuses = useCallback(async () => {
		setIsCheckingPRStatuses(true);
		setPrStatusMessage(null);
		try {
			const result = await window.maestro.symphony.checkPRStatuses();
			const messages: string[] = [];
			if ((result.merged ?? 0) > 0) {
				messages.push(t('symphony.active.prs_merged', { count: result.merged ?? 0 }));
			}
			if ((result.closed ?? 0) > 0) {
				messages.push(t('symphony.active.prs_closed', { count: result.closed ?? 0 }));
			}
			if (messages.length > 0) {
				setPrStatusMessage(messages.join(', '));
			} else if ((result.checked ?? 0) > 0) {
				setPrStatusMessage(t('symphony.active.all_prs_up_to_date'));
			} else {
				setPrStatusMessage(t('symphony.active.no_prs_to_check'));
			}
			// Clear message after 5 seconds
			setTimeout(() => setPrStatusMessage(null), 5000);
		} catch (err) {
			console.error('Failed to check PR statuses:', err);
			setPrStatusMessage(t('symphony.active.failed_to_check_statuses'));
			setTimeout(() => setPrStatusMessage(null), 5000);
		} finally {
			setIsCheckingPRStatuses(false);
		}
	}, []);

	// Tab cycling with Cmd+Shift+[ and Cmd+Shift+]
	const tabs: ModalTab[] = useMemo(() => ['projects', 'active', 'history', 'stats'], []);

	useEffect(() => {
		const handleTabCycle = (e: KeyboardEvent) => {
			// Cmd+Shift+[ or Cmd+Shift+] to cycle tabs
			if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '[' || e.key === ']')) {
				e.preventDefault();
				e.stopPropagation();

				const currentIndex = tabs.indexOf(activeTab);
				let newIndex: number;

				if (e.key === '[') {
					// Go backwards, wrap around
					newIndex = currentIndex <= 0 ? tabs.length - 1 : currentIndex - 1;
				} else {
					// Go forwards, wrap around
					newIndex = currentIndex >= tabs.length - 1 ? 0 : currentIndex + 1;
				}

				setActiveTab(tabs[newIndex]);
			}
		};

		if (isOpen) {
			window.addEventListener('keydown', handleTabCycle);
			return () => window.removeEventListener('keydown', handleTabCycle);
		}
	}, [isOpen, activeTab, tabs]);

	// Keyboard navigation
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (activeTab !== 'projects' || showDetailView) return;

			// "/" to focus search (vim-style)
			if (e.key === '/' && !(e.target instanceof HTMLInputElement)) {
				e.preventDefault();
				searchInputRef.current?.focus();
				return;
			}

			// Escape from search returns focus to grid
			if (e.key === 'Escape' && e.target instanceof HTMLInputElement) {
				e.preventDefault();
				(e.target as HTMLInputElement).blur();
				tileGridRef.current?.focus();
				return;
			}

			const total = filteredRepositories.length;
			if (total === 0) return;
			if (e.target instanceof HTMLInputElement && !['ArrowDown', 'ArrowUp'].includes(e.key)) return;

			const gridColumns = 3;
			switch (e.key) {
				case 'ArrowRight':
					e.preventDefault();
					setSelectedTileIndex((i) => Math.min(total - 1, i + 1));
					break;
				case 'ArrowLeft':
					e.preventDefault();
					setSelectedTileIndex((i) => Math.max(0, i - 1));
					break;
				case 'ArrowDown':
					e.preventDefault();
					setSelectedTileIndex((i) => Math.min(total - 1, i + gridColumns));
					// If we're in the search box, move focus to grid
					if (e.target instanceof HTMLInputElement) {
						tileGridRef.current?.focus();
					}
					break;
				case 'ArrowUp':
					e.preventDefault();
					setSelectedTileIndex((i) => Math.max(0, i - gridColumns));
					break;
				case 'Enter': {
					e.preventDefault();
					const repo = filteredRepositories[selectedTileIndex];
					if (repo) {
						handleSelectRepo(repo);
					}
					break;
				}
			}
		};

		if (isOpen) {
			window.addEventListener('keydown', handleKeyDown);
			return () => window.removeEventListener('keydown', handleKeyDown);
		}
	}, [
		isOpen,
		activeTab,
		showDetailView,
		filteredRepositories,
		selectedTileIndex,
		handleSelectRepo,
	]);

	if (!isOpen) return null;

	const modalContent = (
		<div
			className="fixed inset-0 modal-overlay flex items-start justify-center pt-16 z-[9999] animate-in fade-in duration-100"
			style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="symphony-modal-title"
				tabIndex={-1}
				className="w-[1200px] max-w-[95vw] rounded-xl shadow-2xl border overflow-hidden flex flex-col max-h-[85vh] outline-none"
				style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
			>
				{/* Detail view for projects */}
				{activeTab === 'projects' && showDetailView && selectedRepo ? (
					<RepositoryDetailView
						theme={theme}
						repo={selectedRepo}
						issues={repoIssues}
						isLoadingIssues={isLoadingIssues}
						selectedIssue={selectedIssue}
						documentPreview={documentPreview}
						isLoadingDocument={isLoadingDocument}
						isStarting={isStarting}
						onBack={handleBack}
						onSelectIssue={handleSelectIssue}
						onStartContribution={handleStartContribution}
						onPreviewDocument={handlePreviewDocument}
					/>
				) : (
					<>
						{/* Header */}
						<div
							className="flex items-center justify-between px-4 py-3 border-b"
							style={{ borderColor: theme.colors.border }}
						>
							<div className="flex items-center gap-2">
								<Music className="w-5 h-5" style={{ color: theme.colors.accent }} />
								<h2
									id="symphony-modal-title"
									className="text-lg font-semibold"
									style={{ color: theme.colors.textMain }}
								>
									{t('symphony.title')}
								</h2>
								{/* Help button */}
								<div className="relative">
									<button
										ref={helpButtonRef}
										onClick={() => setShowHelp(!showHelp)}
										className="p-1 rounded hover:bg-white/10 transition-colors"
										title={t('symphony.help.about_tooltip')}
										aria-label={tA('modal.help')}
									>
										<HelpCircle className="w-4 h-4" style={{ color: theme.colors.textDim }} />
									</button>
									{showHelp && (
										<div
											className="absolute top-full left-0 mt-2 w-80 p-4 rounded-lg shadow-xl z-50"
											style={{
												backgroundColor: theme.colors.bgSidebar,
												border: `1px solid ${theme.colors.border}`,
											}}
										>
											<h3
												className="text-sm font-semibold mb-2"
												style={{ color: theme.colors.textMain }}
											>
												{t('symphony.help.about_title')}
											</h3>
											<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
												{t('symphony.help.about_description_part1')}{' '}
												<code
													className="px-1 py-0.5 rounded text-xs"
													style={{ backgroundColor: theme.colors.bgActivity }}
												>
													runmaestro.ai
												</code>
												{t('symphony.help.about_description_part2')}
											</p>
											<h4
												className="text-xs font-semibold mb-1"
												style={{ color: theme.colors.textMain }}
											>
												{t('symphony.help.register_project_title')}
											</h4>
											<p className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
												{t('symphony.help.register_project_description')}
											</p>
											<button
												onClick={() => {
													window.maestro.shell.openExternal('https://docs.runmaestro.ai/symphony');
													setShowHelp(false);
												}}
												className="text-xs hover:opacity-80 transition-colors"
												style={{ color: theme.colors.accent }}
											>
												docs.runmaestro.ai/symphony
											</button>
											<div
												className="mt-3 pt-3 border-t"
												style={{ borderColor: theme.colors.border }}
											>
												<button
													onClick={() => setShowHelp(false)}
													className="text-xs px-2 py-1 rounded hover:bg-white/10 transition-colors"
													style={{ color: theme.colors.textDim }}
												>
													{t('symphony.help.close_button')}
												</button>
											</div>
										</div>
									)}
								</div>
								{/* Register Project link */}
								<button
									onClick={() => {
										window.maestro.shell.openExternal('https://docs.runmaestro.ai/symphony');
									}}
									className="px-2 py-1 rounded hover:bg-white/10 transition-colors flex items-center gap-1.5 text-xs"
									title={t('symphony.help.register_project_tooltip')}
									style={{ color: theme.colors.textDim }}
								>
									<Github className="w-3.5 h-3.5" />
									<span>{t('symphony.help.register_project_button')}</span>
								</button>
							</div>
							<div className="flex items-center gap-3">
								{activeTab === 'projects' && (
									<span className="text-xs" style={{ color: theme.colors.textDim }}>
										{fromCache
											? t('symphony.cache_status', { age: formatCacheAge(cacheAge, t) })
											: t('symphony.live_status')}
									</span>
								)}
								<button
									onClick={() => refresh(true)}
									disabled={isRefreshing}
									className="p-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
									title={t('symphony.refresh_tooltip')}
								>
									<RefreshCw
										className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`}
										style={{ color: theme.colors.textDim }}
									/>
								</button>
								<button
									onClick={onClose}
									className="p-1.5 rounded hover:bg-white/10 transition-colors"
									title={t('symphony.close_tooltip')}
								>
									<X className="w-4 h-4" style={{ color: theme.colors.textDim }} />
								</button>
							</div>
						</div>

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
									{tab === 'projects' && t('symphony.tabs.projects')}
									{tab === 'active' &&
										(activeContributions.length > 0
											? t('symphony.tabs.active_count', { count: activeContributions.length })
											: t('symphony.tabs.active'))}
									{tab === 'history' && t('symphony.tabs.history')}
									{tab === 'stats' && t('symphony.tabs.stats')}
								</button>
							))}
						</div>

						{/* Tab content */}
						<div className="flex-1 overflow-hidden flex flex-col">
							{/* Projects Tab */}
							{activeTab === 'projects' && (
								<>
									{/* Search + Category tabs */}
									<div
										className="px-4 py-3 border-b"
										style={{
											borderColor: theme.colors.border,
											backgroundColor: theme.colors.bgMain,
										}}
									>
										<div className="flex items-center gap-4">
											<div className="relative flex-1 max-w-xs">
												<Search
													className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
													style={{ color: theme.colors.textDim }}
												/>
												<input
													ref={searchInputRef}
													type="text"
													value={searchQuery}
													onChange={(e) => handleSearchChange(e.target.value)}
													placeholder={t('symphony.projects.search_placeholder')}
													className="w-full pl-9 pr-3 py-2 rounded border outline-none text-sm focus:ring-1"
													style={{
														borderColor: theme.colors.border,
														color: theme.colors.textMain,
														backgroundColor: theme.colors.bgActivity,
													}}
												/>
											</div>

											<div className="flex items-center gap-1 flex-wrap">
												<button
													onClick={() => handleCategoryChange('all')}
													className={`px-3 py-1.5 rounded text-sm transition-colors ${selectedCategory === 'all' ? 'font-semibold' : ''}`}
													style={{
														backgroundColor:
															selectedCategory === 'all' ? theme.colors.bgActivity : 'transparent',
														color:
															selectedCategory === 'all'
																? theme.colors.accent
																: theme.colors.textDim,
														border:
															selectedCategory === 'all'
																? `1px solid ${theme.colors.accent}`
																: '1px solid transparent',
													}}
												>
													{t('symphony.projects.all_category')}
												</button>
												{categories.map((cat) => {
													const info = SYMPHONY_CATEGORIES[cat];
													return (
														<button
															key={cat}
															onClick={() => handleCategoryChange(cat)}
															className={`px-3 py-1.5 rounded text-sm transition-colors flex items-center gap-1 ${
																selectedCategory === cat ? 'font-semibold' : ''
															}`}
															style={{
																backgroundColor:
																	selectedCategory === cat
																		? theme.colors.bgActivity
																		: 'transparent',
																color:
																	selectedCategory === cat
																		? theme.colors.accent
																		: theme.colors.textDim,
																border:
																	selectedCategory === cat
																		? `1px solid ${theme.colors.accent}`
																		: '1px solid transparent',
															}}
														>
															<span>{info?.emoji ?? '📦'}</span>
															<span>{info?.label ?? cat}</span>
														</button>
													);
												})}
											</div>
										</div>
									</div>

									{/* Repository grid */}
									<div
										className="flex-1 overflow-y-auto p-4"
										style={{ backgroundColor: theme.colors.bgMain }}
									>
										{isLoading ? (
											<div className="grid grid-cols-3 gap-4">
												{[
													'repo-skeleton-1',
													'repo-skeleton-2',
													'repo-skeleton-3',
													'repo-skeleton-4',
													'repo-skeleton-5',
													'repo-skeleton-6',
												].map((skeletonId) => (
													<RepositoryTileSkeleton key={skeletonId} theme={theme} />
												))}
											</div>
										) : error ? (
											<div className="flex flex-col items-center justify-center h-48">
												<AlertCircle
													className="w-8 h-8 mb-2"
													style={{ color: STATUS_COLORS.failed }}
												/>
												<p style={{ color: theme.colors.textDim }}>{error}</p>
												<button
													onClick={() => refresh(true)}
													className="mt-3 px-3 py-1.5 rounded text-sm"
													style={{
														backgroundColor: theme.colors.accent,
														color: theme.colors.accentForeground,
													}}
												>
													{t('symphony.projects.retry_button')}
												</button>
											</div>
										) : filteredRepositories.length === 0 ? (
											<div className="flex flex-col items-center justify-center h-48">
												<Music className="w-8 h-8 mb-2" style={{ color: theme.colors.textDim }} />
												<p style={{ color: theme.colors.textDim }}>
													{searchQuery
														? t('symphony.projects.no_search_results')
														: t('symphony.projects.no_repositories')}
												</p>
											</div>
										) : (
											<div
												ref={tileGridRef}
												tabIndex={0}
												className="grid grid-cols-3 gap-4 outline-none"
												role="grid"
												aria-label={tA('navigation.repository_tiles')}
											>
												{filteredRepositories.map((repo, index) => (
													<RepositoryTile
														key={repo.slug}
														repo={repo}
														theme={theme}
														isSelected={index === selectedTileIndex}
														onSelect={() => handleSelectRepo(repo)}
														issueCount={issueCounts?.[repo.slug] ?? null}
													/>
												))}
											</div>
										)}
									</div>

									{/* Footer */}
									<div
										className="px-4 py-2 border-t flex items-center justify-between text-xs"
										style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
									>
										<span className="flex items-center gap-1">
											{t('symphony.projects.footer_count', { count: filteredRepositories.length })}
											{isLoadingIssueCounts && <Loader2 className="w-3 h-3 animate-spin ml-1" />}
										</span>
										<span>
											{t('symphony.projects.footer_shortcuts', {
												shortcutKeys: formatShortcutKeys(['Meta', 'Shift']),
											})}
										</span>
									</div>
								</>
							)}

							{/* Active Tab */}
							{activeTab === 'active' && (
								<div className="flex-1 flex flex-col overflow-hidden">
									{/* Header with refresh button */}
									<div
										className="px-4 py-2 border-b flex items-center justify-between"
										style={{ borderColor: theme.colors.border }}
									>
										<span className="text-sm" style={{ color: theme.colors.textMain }}>
											{t('symphony.active.contribution_count', {
												count: activeContributions.length,
											})}
										</span>
										<div className="flex items-center gap-2">
											{prStatusMessage && (
												<span className="text-xs" style={{ color: theme.colors.textDim }}>
													{prStatusMessage}
												</span>
											)}
											<button
												onClick={handleCheckPRStatuses}
												disabled={isCheckingPRStatuses}
												className="flex items-center gap-1.5 px-2 py-1 rounded text-xs hover:opacity-80 transition-opacity disabled:opacity-50"
												style={{
													backgroundColor: theme.colors.bgActivity,
													color: theme.colors.textMain,
												}}
												title={t('symphony.active.check_pr_tooltip')}
											>
												<RefreshCw
													className={`w-3 h-3 ${isCheckingPRStatuses ? 'animate-spin' : ''}`}
												/>
												{t('symphony.active.check_pr_button')}
											</button>
										</div>
									</div>

									{/* Content */}
									<div className="flex-1 overflow-y-auto p-4">
										{activeContributions.length === 0 ? (
											<div className="flex flex-col items-center justify-center h-64">
												<Music className="w-12 h-12 mb-3" style={{ color: theme.colors.textDim }} />
												<p className="text-sm mb-1" style={{ color: theme.colors.textMain }}>
													{t('symphony.active.no_contributions_title')}
												</p>
												<p className="text-xs mb-4" style={{ color: theme.colors.textDim }}>
													{t('symphony.active.no_contributions_description')}
												</p>
												<button
													onClick={() => setActiveTab('projects')}
													className="px-3 py-1.5 rounded text-sm"
													style={{
														backgroundColor: theme.colors.accent,
														color: theme.colors.accentForeground,
													}}
												>
													{t('symphony.active.browse_projects_button')}
												</button>
											</div>
										) : (
											<div className="grid grid-cols-2 gap-4">
												{activeContributions.map((contribution) => {
													const session = sessions.find((s) => s.id === contribution.sessionId);
													return (
														<ActiveContributionCard
															key={contribution.id}
															contribution={contribution}
															theme={theme}
															onFinalize={() => handleFinalize(contribution.id)}
															onSync={() => handleSyncContribution(contribution.id)}
															isSyncing={syncingContributionId === contribution.id}
															sessionName={session?.name ?? null}
															onNavigateToSession={() => {
																if (session) {
																	onSelectSession(session.id);
																	onClose();
																}
															}}
														/>
													);
												})}
											</div>
										)}
									</div>
								</div>
							)}

							{/* History Tab */}
							{activeTab === 'history' && (
								<div className="flex-1 overflow-y-auto">
									{/* Stats summary */}
									{stats && stats.totalContributions > 0 && (
										<div
											className="grid grid-cols-5 gap-4 p-4 border-b"
											style={{ borderColor: theme.colors.border }}
										>
											<div className="text-center">
												<p
													className="text-2xl font-semibold"
													style={{ color: theme.colors.textMain }}
												>
													{stats.totalContributions}
												</p>
												<p className="text-xs" style={{ color: theme.colors.textDim }}>
													{t('symphony.history.prs_created_label')}
												</p>
											</div>
											<div className="text-center">
												<p
													className="text-2xl font-semibold"
													style={{ color: STATUS_COLORS.running }}
												>
													{stats.totalMerged}
												</p>
												<p className="text-xs" style={{ color: theme.colors.textDim }}>
													{t('symphony.history.merged_label')}
												</p>
											</div>
											<div className="text-center">
												<p
													className="text-2xl font-semibold"
													style={{ color: theme.colors.textMain }}
												>
													{stats.totalTasksCompleted}
												</p>
												<p className="text-xs" style={{ color: theme.colors.textDim }}>
													{t('symphony.history.tasks_label')}
												</p>
											</div>
											<div className="text-center">
												<p
													className="text-2xl font-semibold"
													style={{ color: theme.colors.textMain }}
												>
													{formattedTotalTokens}
												</p>
												<p className="text-xs" style={{ color: theme.colors.textDim }}>
													{t('symphony.history.tokens_label')}
												</p>
											</div>
											<div className="text-center">
												<p
													className="text-2xl font-semibold"
													style={{ color: theme.colors.accent }}
												>
													{formattedTotalCost}
												</p>
												<p className="text-xs" style={{ color: theme.colors.textDim }}>
													{t('symphony.history.value_label')}
												</p>
											</div>
										</div>
									)}

									{/* Completed contributions */}
									<div className="p-4">
										{completedContributions.length === 0 ? (
											<div className="flex flex-col items-center justify-center h-48">
												<Music className="w-12 h-12 mb-3" style={{ color: theme.colors.textDim }} />
												<p className="text-sm mb-1" style={{ color: theme.colors.textMain }}>
													{t('symphony.history.no_contributions_title')}
												</p>
												<p className="text-xs" style={{ color: theme.colors.textDim }}>
													{t('symphony.history.no_contributions_description')}
												</p>
											</div>
										) : (
											<div className="grid grid-cols-2 gap-4">
												{completedContributions.map((contribution) => (
													<CompletedContributionCard
														key={contribution.id}
														contribution={contribution}
														theme={theme}
													/>
												))}
											</div>
										)}
									</div>
								</div>
							)}

							{/* Stats Tab */}
							{activeTab === 'stats' && (
								<div className="flex-1 overflow-y-auto p-4">
									{/* Stats cards */}
									<div className="grid grid-cols-3 gap-4 mb-6">
										<div
											className="p-4 rounded-lg border"
											style={{
												backgroundColor: theme.colors.bgActivity,
												borderColor: theme.colors.border,
											}}
										>
											<div className="flex items-center gap-2 mb-2">
												<Zap className="w-5 h-5" style={{ color: theme.colors.accent }} />
												<span
													className="text-sm font-medium"
													style={{ color: theme.colors.textMain }}
												>
													{t('symphony.stats.tokens_donated_label')}
												</span>
											</div>
											<p
												className="text-2xl font-semibold"
												style={{ color: theme.colors.textMain }}
											>
												{formattedTotalTokens}
											</p>
											<p className="text-xs" style={{ color: theme.colors.textDim }}>
												{t('symphony.stats.worth_label', { cost: formattedTotalCost })}
											</p>
										</div>

										<div
											className="p-4 rounded-lg border"
											style={{
												backgroundColor: theme.colors.bgActivity,
												borderColor: theme.colors.border,
											}}
										>
											<div className="flex items-center gap-2 mb-2">
												<Clock className="w-5 h-5" style={{ color: theme.colors.accent }} />
												<span
													className="text-sm font-medium"
													style={{ color: theme.colors.textMain }}
												>
													{t('symphony.stats.time_contributed_label')}
												</span>
											</div>
											<p
												className="text-2xl font-semibold"
												style={{ color: theme.colors.textMain }}
											>
												{formattedTotalTime}
											</p>
											<p className="text-xs" style={{ color: theme.colors.textDim }}>
												{t('symphony.stats.repositories_count', { count: uniqueRepos })}
											</p>
										</div>

										<div
											className="p-4 rounded-lg border"
											style={{
												backgroundColor: theme.colors.bgActivity,
												borderColor: theme.colors.border,
											}}
										>
											<div className="flex items-center gap-2 mb-2">
												<Flame className="w-5 h-5" style={{ color: '#f97316' }} />
												<span
													className="text-sm font-medium"
													style={{ color: theme.colors.textMain }}
												>
													{t('symphony.stats.streak_label')}
												</span>
											</div>
											<p
												className="text-2xl font-semibold"
												style={{ color: theme.colors.textMain }}
											>
												{t('symphony.stats.weeks_count', { count: currentStreakWeeks })}
											</p>
											<p className="text-xs" style={{ color: theme.colors.textDim }}>
												{t('symphony.stats.best_streak', { count: longestStreakWeeks })}
											</p>
										</div>
									</div>

									{/* Achievements */}
									<div>
										<h3
											className="text-sm font-semibold mb-3 flex items-center gap-2"
											style={{ color: theme.colors.textMain }}
										>
											<Trophy className="w-4 h-4" style={{ color: '#eab308' }} />
											{t('symphony.stats.achievements_title')}
										</h3>
										<div className="grid grid-cols-2 gap-3">
											{achievements.map((achievement) => (
												<AchievementCard
													key={achievement.id}
													achievement={achievement}
													theme={theme}
												/>
											))}
										</div>
									</div>
								</div>
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
			{/* Pre-flight Check Dialog */}
			{showBuildWarning &&
				createPortal(
					<div className="fixed inset-0 flex items-center justify-center" style={{ zIndex: 10001 }}>
						<button
							type="button"
							className="absolute inset-0"
							style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
							tabIndex={-1}
							onClick={() => setShowBuildWarning(false)}
							aria-label={tA('modal.close_precheck_dialog')}
						/>
						<div
							className="relative rounded-lg border shadow-2xl p-6 max-w-md mx-4"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
							}}
						>
							{isCheckingGh ? (
								<div className="flex items-center gap-3 py-4">
									<Loader2
										className="w-5 h-5 animate-spin"
										style={{ color: theme.colors.textDim }}
									/>
									<span className="text-sm" style={{ color: theme.colors.textDim }}>
										{t('symphony.preflight.checking')}
									</span>
								</div>
							) : ghCliStatus && !ghCliStatus.installed ? (
								<>
									<div className="flex items-start gap-3 mb-4">
										<AlertCircle
											className="w-6 h-6 shrink-0 mt-0.5"
											style={{ color: STATUS_COLORS.failed }}
										/>
										<div>
											<h3
												className="font-semibold text-base mb-2"
												style={{ color: theme.colors.textMain }}
											>
												{t('symphony.preflight.gh_required_title')}
											</h3>
											<p
												className="text-sm leading-relaxed"
												style={{ color: theme.colors.textDim }}
											>
												{t('symphony.preflight.gh_required_description_part1')}
												<code
													className="px-1 py-0.5 rounded text-xs"
													style={{
														backgroundColor: `${theme.colors.border}80`,
														color: theme.colors.textMain,
													}}
												>
													gh
												</code>
												{t('symphony.preflight.gh_required_description_part2')}
											</p>
											<p
												className="text-sm leading-relaxed mt-2"
												style={{ color: theme.colors.textDim }}
											>
												{t('symphony.preflight.gh_install_part1')}{' '}
												<a
													href="https://cli.github.com/"
													target="_blank"
													rel="noopener noreferrer"
													className="underline"
													style={{ color: theme.colors.accent }}
												>
													cli.github.com
												</a>{' '}
												{t('symphony.preflight.gh_install_part2')}{' '}
												<code
													className="px-1 py-0.5 rounded text-xs"
													style={{
														backgroundColor: `${theme.colors.border}80`,
														color: theme.colors.textMain,
													}}
												>
													gh auth login
												</code>{' '}
												{t('symphony.preflight.gh_install_part3')}
											</p>
										</div>
									</div>
									<div className="flex justify-end mt-4">
										<button
											onClick={() => setShowBuildWarning(false)}
											className="px-4 py-2 rounded text-sm transition-colors hover:bg-white/10"
											style={{
												color: theme.colors.textDim,
												border: `1px solid ${theme.colors.border}`,
											}}
										>
											{t('symphony.preflight.close_button')}
										</button>
									</div>
								</>
							) : ghCliStatus && !ghCliStatus.authenticated ? (
								<>
									<div className="flex items-start gap-3 mb-4">
										<AlertCircle
											className="w-6 h-6 shrink-0 mt-0.5"
											style={{ color: STATUS_COLORS.failed }}
										/>
										<div>
											<h3
												className="font-semibold text-base mb-2"
												style={{ color: theme.colors.textMain }}
											>
												{t('symphony.preflight.gh_not_authenticated_title')}
											</h3>
											<p
												className="text-sm leading-relaxed"
												style={{ color: theme.colors.textDim }}
											>
												{t('symphony.preflight.gh_not_auth_description_part1')}
												<code
													className="px-1 py-0.5 rounded text-xs"
													style={{
														backgroundColor: `${theme.colors.border}80`,
														color: theme.colors.textMain,
													}}
												>
													gh
												</code>
												{t('symphony.preflight.gh_not_auth_description_part2')}
											</p>
											<p
												className="text-sm leading-relaxed mt-2"
												style={{ color: theme.colors.textDim }}
											>
												{t('symphony.preflight.gh_run_auth_part1')}{' '}
												<code
													className="px-1 py-0.5 rounded text-xs"
													style={{
														backgroundColor: `${theme.colors.border}80`,
														color: theme.colors.textMain,
													}}
												>
													gh auth login
												</code>{' '}
												{t('symphony.preflight.gh_run_auth_part2')}
											</p>
										</div>
									</div>
									<div className="flex justify-end mt-4">
										<button
											onClick={() => setShowBuildWarning(false)}
											className="px-4 py-2 rounded text-sm transition-colors hover:bg-white/10"
											style={{
												color: theme.colors.textDim,
												border: `1px solid ${theme.colors.border}`,
											}}
										>
											{t('symphony.preflight.close_button')}
										</button>
									</div>
								</>
							) : (
								<>
									<div className="flex items-start gap-3 mb-1">
										<CheckCircle
											className="w-5 h-5 shrink-0 mt-0.5"
											style={{ color: STATUS_COLORS.running }}
										/>
										<span className="text-sm" style={{ color: STATUS_COLORS.running }}>
											{t('symphony.preflight.gh_authenticated')}
										</span>
									</div>
									<div className="flex items-start gap-3 mb-4 mt-3">
										<AlertCircle
											className="w-6 h-6 shrink-0 mt-0.5"
											style={{ color: STATUS_COLORS.paused }}
										/>
										<div>
											<h3
												className="font-semibold text-base mb-2"
												style={{ color: theme.colors.textMain }}
											>
												{t('symphony.preflight.build_tools_title')}
											</h3>
											<p
												className="text-sm leading-relaxed"
												style={{ color: theme.colors.textDim }}
											>
												{t('symphony.preflight.build_tools_description')}
											</p>
											<p
												className="text-sm leading-relaxed mt-2"
												style={{ color: theme.colors.textDim }}
											>
												{t('symphony.preflight.build_tools_suggestion')}
											</p>
										</div>
									</div>
									<div className="flex justify-end gap-2 mt-4">
										<button
											onClick={() => setShowBuildWarning(false)}
											className="px-4 py-2 rounded text-sm transition-colors hover:bg-white/10"
											style={{
												color: theme.colors.textDim,
												border: `1px solid ${theme.colors.border}`,
											}}
										>
											{t('symphony.preflight.cancel_button')}
										</button>
										<button
											onClick={handleBuildWarningConfirm}
											className="px-4 py-2 rounded font-semibold text-sm transition-colors"
											style={{
												backgroundColor: theme.colors.accent,
												color: theme.colors.accentForeground,
											}}
										>
											{t('symphony.preflight.confirm_build_tools_button')}
										</button>
									</div>
								</>
							)}
						</div>
					</div>,
					document.body
				)}
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
