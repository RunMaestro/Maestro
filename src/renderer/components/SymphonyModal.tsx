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
} from 'lucide-react';
import type { Theme } from '../types';
import type {
	RegisteredRepository,
	SymphonyIssue,
	SymphonyCategory,
	ActiveContribution,
	CompletedContribution,
	ContributionStatus,
} from '../../shared/symphony-types';
import { SYMPHONY_CATEGORIES } from '../../shared/symphony-constants';
import { COLORBLIND_AGENT_PALETTE } from '../constants/colorblindPalettes';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useSymphony } from '../hooks/symphony';
import { useContributorStats, type Achievement } from '../hooks/symphony/useContributorStats';
import { AgentCreationDialog, type AgentCreationConfig } from './AgentCreationDialog';
import { generateProseStyles, createMarkdownComponents } from '../utils/markdownConfig';

// ============================================================================
// Types
// ============================================================================

export interface SymphonyContributionData {
	contributionId: string;
	localPath: string;
	autoRunPath?: string;
	branchName?: string;
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

function formatCacheAge(cacheAgeMs: number | null): string {
	if (cacheAgeMs === null || cacheAgeMs === 0) return 'just now';
	const seconds = Math.floor(cacheAgeMs / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	if (hours > 0) return `${hours}h ago`;
	if (minutes > 0) return `${minutes}m ago`;
	return 'just now';
}

function formatDurationMs(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)}m`;
	return `${Math.floor(totalSeconds / 3600)}h ${Math.floor((totalSeconds % 3600) / 60)}m`;
}

function formatDate(isoString: string): string {
	return new Date(isoString).toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	});
}

function getStatusInfo(status: ContributionStatus): {
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
	const labels: Record<string, string> = {
		cloning: 'Cloning',
		creating_pr: 'Creating PR',
		running: 'Running',
		paused: 'Paused',
		completed: 'Completed',
		completing: 'Completing',
		ready_for_review: 'Ready for Review',
		failed: 'Failed',
		cancelled: 'Cancelled',
	};
	return {
		label: labels[status] ?? status,
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
// Repository Tile
// ============================================================================

function RepositoryTile({
	repo,
	theme,
	isSelected,
	onSelect,
}: {
	repo: RegisteredRepository;
	theme: Theme;
	isSelected: boolean;
	onSelect: () => void;
}) {
	const tileRef = useRef<HTMLButtonElement>(null);
	const categoryInfo = SYMPHONY_CATEGORIES[repo.category] ?? { label: repo.category, emoji: '📦' };

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
				...(isSelected && { boxShadow: `0 0 0 2px ${theme.colors.accent}` }),
			}}
		>
			<div className="flex items-center gap-2 mb-2">
				<span
					className="px-2 py-0.5 rounded text-xs flex items-center gap-1"
					style={{ backgroundColor: `${theme.colors.accent}20`, color: theme.colors.accent }}
				>
					<span>{categoryInfo.emoji}</span>
					<span>{categoryInfo.label}</span>
				</span>
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
				<span className="flex items-center gap-1" style={{ color: theme.colors.accent }}>
					<Hash className="w-3 h-3" />
					View Issues
				</span>
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
	const isAvailable = issue.status === 'available';
	const isClaimed = issue.status === 'in_progress';

	return (
		<button
			onClick={onSelect}
			disabled={!isAvailable}
			className={`w-full p-3 rounded-lg border text-left transition-all ${
				!isAvailable ? 'opacity-60 cursor-not-allowed' : 'hover:bg-white/5'
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
					style={{ color: theme.colors.textMain }}
				>
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						#{issue.number}
					</span>
					{issue.title}
				</h4>
				{isClaimed && (
					<span
						className="px-1.5 py-0.5 rounded text-xs shrink-0 flex items-center gap-1"
						style={{ backgroundColor: `${STATUS_COLORS.running}20`, color: STATUS_COLORS.running }}
					>
						<GitPullRequest className="w-3 h-3" />
						Claimed
					</span>
				)}
			</div>

			<div
				className="flex flex-wrap items-center gap-3 text-xs"
				style={{ color: theme.colors.textDim }}
			>
				<span className="flex items-center gap-1">
					<FileText className="w-3 h-3" />
					{issue.documentPaths.length} {issue.documentPaths.length === 1 ? 'document' : 'documents'}
				</span>
				{isClaimed && issue.claimedByPr && (
					<a
						href={issue.claimedByPr.url}
						target="_blank"
						rel="noopener noreferrer"
						className="flex items-center gap-1 cursor-pointer hover:underline"
						style={{ color: theme.colors.accent }}
						onClick={(e) => {
							e.preventDefault();
							e.stopPropagation();
							window.maestro.shell.openExternal(issue.claimedByPr!.url);
						}}
					>
						<GitPullRequest className="w-3 h-3" />
						{issue.claimedByPr.isDraft ? 'Draft ' : ''}PR #{issue.claimedByPr.number} by @
						{issue.claimedByPr.author}
						<ExternalLink className="w-2.5 h-2.5" />
					</a>
				)}
			</div>

			{issue.documentPaths.length > 0 && (
				<div className="mt-2 text-xs" style={{ color: theme.colors.textDim }}>
					{issue.documentPaths.slice(0, 2).map((doc, i) => (
						<div key={i} className="truncate">
							• {doc.name}
						</div>
					))}
					{issue.documentPaths.length > 2 && (
						<div>...and {issue.documentPaths.length - 2} more</div>
					)}
				</div>
			)}
		</button>
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
	const categoryInfo = SYMPHONY_CATEGORIES[repo.category] ?? { label: repo.category, emoji: '📦' };
	const availableIssues = issues.filter((i) => i.status === 'available');
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
						title="Back (Esc)"
					>
						<ArrowLeft className="w-5 h-5" style={{ color: theme.colors.textDim }} />
					</button>
					<div className="flex items-center gap-2">
						<Music className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h2 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
							Maestro Symphony: {repo.name}
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
					<a
						href={repo.url}
						target="_blank"
						rel="noopener noreferrer"
						className="p-1.5 rounded hover:bg-white/10 transition-colors"
						title="View repository on GitHub"
						onClick={(e) => {
							e.preventDefault();
							handleOpenExternal(repo.url);
						}}
					>
						<ExternalLink className="w-5 h-5" style={{ color: theme.colors.textDim }} />
					</a>
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
							About
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
							Maintainer
						</h4>
						{repo.maintainer.url ? (
							<a
								href={repo.maintainer.url}
								target="_blank"
								rel="noopener noreferrer"
								className="text-sm hover:underline inline-flex items-center gap-1"
								style={{ color: theme.colors.accent }}
								onClick={(e) => {
									e.preventDefault();
									handleOpenExternal(repo.maintainer.url!);
								}}
							>
								{repo.maintainer.name}
								<ExternalLink className="w-3 h-3" />
							</a>
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
								Tags
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
							{[1, 2, 3].map((i) => (
								<div
									key={i}
									className="h-20 rounded animate-pulse"
									style={{ backgroundColor: theme.colors.bgMain }}
								/>
							))}
						</div>
					) : issues.length === 0 ? (
						<p className="text-sm text-center py-4" style={{ color: theme.colors.textDim }}>
							No issues with runmaestro.ai label
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
										<span>In Progress ({inProgressIssues.length})</span>
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
									<span>Available Issues ({availableIssues.length})</span>
									{isLoadingIssues && (
										<Loader2
											className="w-3 h-3 animate-spin"
											style={{ color: theme.colors.accent }}
										/>
									)}
								</h4>
								{availableIssues.length === 0 ? (
									<p className="text-sm text-center py-4" style={{ color: theme.colors.textDim }}>
										All issues are currently being worked on
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
									<a
										href={selectedIssue.htmlUrl}
										target="_blank"
										rel="noopener noreferrer"
										className="text-xs hover:underline flex items-center gap-1"
										style={{ color: theme.colors.accent }}
										onClick={(e) => {
											e.preventDefault();
											handleOpenExternal(selectedIssue.htmlUrl);
										}}
										title="View issue on GitHub"
									>
										View Issue
										<ExternalLink className="w-3 h-3" />
									</a>
								</div>
								<div
									className="flex items-center gap-2 text-xs"
									style={{ color: theme.colors.textDim }}
								>
									<FileText className="w-3 h-3" />
									<span>{selectedIssue.documentPaths.length} Auto Run documents to process</span>
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
											{selectedIssue.documentPaths[selectedDocIndex]?.name || 'Select document'}
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
										<p style={{ color: theme.colors.textDim }}>Select a document to preview</p>
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
								<Music className="w-12 h-12 mx-auto mb-3" style={{ color: theme.colors.textDim }} />
								<p style={{ color: theme.colors.textDim }}>Select an issue to see details</p>
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
						<GitBranch className="w-4 h-4" />
						<span>Will clone repo, create draft PR, and run all documents</span>
					</div>
					<button
						onClick={onStartContribution}
						disabled={isStarting}
						className="px-4 py-2 rounded font-semibold text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
					>
						{isStarting ? (
							<>
								<Loader2 className="w-4 h-4 animate-spin" />
								Starting...
							</>
						) : (
							<>
								<Play className="w-4 h-4" />
								Start Symphony
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
}: {
	contribution: ActiveContribution;
	theme: Theme;
	onFinalize: () => void;
	onSync: () => void;
	isSyncing: boolean;
}) {
	const statusInfo = getStatusInfo(contribution.status);
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
				</div>
				<div className="flex items-center gap-2 shrink-0">
					<button
						onClick={onSync}
						disabled={isSyncing}
						className="p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
						title="Sync status with GitHub"
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
				<a
					href={contribution.draftPrUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="flex items-center gap-1 text-xs mb-2 hover:underline"
					style={{ color: theme.colors.accent }}
					onClick={(e) => {
						e.preventDefault();
						handleOpenExternal(contribution.draftPrUrl!);
					}}
				>
					<GitPullRequest className="w-3 h-3" />
					Draft PR #{contribution.draftPrNumber}
					<ExternalLink className="w-3 h-3" />
				</a>
			) : (
				<div
					className="flex items-center gap-1 text-xs mb-2"
					style={{ color: theme.colors.textDim }}
				>
					<GitBranch className="w-3 h-3" />
					<span>PR will be created on first commit</span>
				</div>
			)}

			<div className="mb-2">
				<div className="flex items-center justify-between text-xs mb-1">
					<span style={{ color: theme.colors.textDim }}>
						{contribution.progress.completedDocuments} / {contribution.progress.totalDocuments}{' '}
						documents
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
						Current: {contribution.progress.currentDocument}
					</p>
				)}
			</div>

			{contribution.tokenUsage && (
				<div
					className="flex items-center gap-4 text-xs mb-2"
					style={{ color: theme.colors.textDim }}
				>
					<span>In: {Math.round(contribution.tokenUsage.inputTokens / 1000)}K</span>
					<span>Out: {Math.round(contribution.tokenUsage.outputTokens / 1000)}K</span>
					<span>${contribution.tokenUsage.estimatedCost.toFixed(2)}</span>
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
					<GitPullRequest className="w-3 h-3" /> Finalize PR
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
						<GitMerge className="w-3 h-3" /> Merged
					</span>
				) : isClosed ? (
					<span
						className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs"
						style={{
							backgroundColor: `${STATUS_COLORS.cancelled}20`,
							color: STATUS_COLORS.cancelled,
						}}
					>
						<X className="w-3 h-3" /> Closed
					</span>
				) : (
					<span
						className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs"
						style={{ backgroundColor: `${STATUS_COLORS.running}20`, color: STATUS_COLORS.running }}
					>
						<GitPullRequest className="w-3 h-3" /> Open
					</span>
				)}
			</div>

			<div className="flex items-center gap-3 text-xs mb-2">
				<span style={{ color: theme.colors.textDim }}>
					Completed {formatDate(contribution.completedAt)}
				</span>
				<button
					onClick={handleOpenPR}
					className="flex items-center gap-1 hover:underline"
					style={{ color: theme.colors.accent }}
				>
					<GitPullRequest className="w-3 h-3" />
					PR #{contribution.prNumber}
					<ExternalLink className="w-2.5 h-2.5" />
				</button>
			</div>

			<div className="grid grid-cols-4 gap-2 text-xs">
				<div>
					<span style={{ color: theme.colors.textDim }}>Documents</span>
					<p style={{ color: theme.colors.textMain }}>{contribution.documentsProcessed}</p>
				</div>
				<div>
					<span style={{ color: theme.colors.textDim }}>Tasks</span>
					<p style={{ color: theme.colors.textMain }}>{contribution.tasksCompleted}</p>
				</div>
				<div>
					<span style={{ color: theme.colors.textDim }}>Tokens</span>
					<p style={{ color: theme.colors.textMain }}>{formattedTokens}</p>
				</div>
				<div>
					<span style={{ color: theme.colors.textDim }}>Cost</span>
					<p style={{ color: theme.colors.accent }}>
						${contribution.tokenUsage.totalCost.toFixed(2)}
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

export function SymphonyModal({ theme, isOpen, onClose, onStartContribution }: SymphonyModalProps) {
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

	// Reset on filter change
	useEffect(() => {
		setSelectedTileIndex(0);
	}, [filteredRepositories.length, selectedCategory, searchQuery]);

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

	// Start contribution - opens agent creation dialog
	const handleStartContribution = useCallback(() => {
		if (!selectedRepo || !selectedIssue) return;
		setShowAgentDialog(true);
	}, [selectedRepo, selectedIssue]);

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

	// Sync individual contribution status with GitHub
	const handleSyncContribution = useCallback(
		async (contributionId: string) => {
			setSyncingContributionId(contributionId);
			try {
				const result = await window.maestro.symphony.syncContribution(contributionId);
				if (result.message) {
					setPrStatusMessage(result.message);
					setTimeout(() => setPrStatusMessage(null), 5000);
				}
			} catch (err) {
				console.error('Failed to sync contribution:', err);
				setPrStatusMessage('Sync failed');
				setTimeout(() => setPrStatusMessage(null), 5000);
			} finally {
				setSyncingContributionId(null);
			}
		},
		[]
	);

	// Check PR statuses (merged/closed) and update history
	const handleCheckPRStatuses = useCallback(async () => {
		setIsCheckingPRStatuses(true);
		setPrStatusMessage(null);
		try {
			const result = await window.maestro.symphony.checkPRStatuses();
			const messages: string[] = [];
			if ((result.merged ?? 0) > 0) {
				messages.push(`${result.merged} PR${(result.merged ?? 0) > 1 ? 's' : ''} merged`);
			}
			if ((result.closed ?? 0) > 0) {
				messages.push(`${result.closed} PR${(result.closed ?? 0) > 1 ? 's' : ''} closed`);
			}
			if (messages.length > 0) {
				setPrStatusMessage(messages.join(', '));
			} else if ((result.checked ?? 0) > 0) {
				setPrStatusMessage('All PRs up to date');
			} else {
				setPrStatusMessage('No PRs to check');
			}
			// Clear message after 5 seconds
			setTimeout(() => setPrStatusMessage(null), 5000);
		} catch (err) {
			console.error('Failed to check PR statuses:', err);
			setPrStatusMessage('Failed to check statuses');
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
				case 'Enter':
					e.preventDefault();
					if (filteredRepositories[selectedTileIndex]) {
						handleSelectRepo(filteredRepositories[selectedTileIndex]);
					}
					break;
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
									Maestro Symphony
								</h2>
								{/* Help button */}
								<div className="relative">
									<button
										ref={helpButtonRef}
										onClick={() => setShowHelp(!showHelp)}
										className="p-1 rounded hover:bg-white/10 transition-colors"
										title="About Maestro Symphony"
										aria-label="Help"
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
												About Maestro Symphony
											</h3>
											<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
												Symphony connects Maestro users with open source projects seeking
												AI-assisted contributions. Browse projects, find issues labeled with{' '}
												<code
													className="px-1 py-0.5 rounded text-xs"
													style={{ backgroundColor: theme.colors.bgActivity }}
												>
													runmaestro.ai
												</code>
												, and contribute by running Auto Run documents that maintainers have
												prepared.
											</p>
											<h4
												className="text-xs font-semibold mb-1"
												style={{ color: theme.colors.textMain }}
											>
												Register Your Project
											</h4>
											<p className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
												Want to receive Symphony contributions for your open source project? Add
												your repository to the registry:
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
													Close
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
									title="Register your project for Symphony contributions"
									style={{ color: theme.colors.textDim }}
								>
									<Github className="w-3.5 h-3.5" />
									<span>Register Your Project</span>
								</button>
							</div>
							<div className="flex items-center gap-3">
								{activeTab === 'projects' && (
									<span className="text-xs" style={{ color: theme.colors.textDim }}>
										{fromCache ? `Cached ${formatCacheAge(cacheAge)}` : 'Live'}
									</span>
								)}
								<button
									onClick={() => refresh(true)}
									disabled={isRefreshing}
									className="p-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
									title="Refresh"
								>
									<RefreshCw
										className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`}
										style={{ color: theme.colors.textDim }}
									/>
								</button>
								<button
									onClick={onClose}
									className="p-1.5 rounded hover:bg-white/10 transition-colors"
									title="Close (Esc)"
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
													onChange={(e) => setSearchQuery(e.target.value)}
													placeholder="Search repositories..."
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
													onClick={() => setSelectedCategory('all')}
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
													All
												</button>
												{categories.map((cat) => {
													const info = SYMPHONY_CATEGORIES[cat];
													return (
														<button
															key={cat}
															onClick={() => setSelectedCategory(cat)}
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
															<span>{info?.emoji}</span>
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
												{[1, 2, 3, 4, 5, 6].map((i) => (
													<RepositoryTileSkeleton key={i} theme={theme} />
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
													Retry
												</button>
											</div>
										) : filteredRepositories.length === 0 ? (
											<div className="flex flex-col items-center justify-center h-48">
												<Music className="w-8 h-8 mb-2" style={{ color: theme.colors.textDim }} />
												<p style={{ color: theme.colors.textDim }}>
													{searchQuery
														? 'No repositories match your search'
														: 'No repositories available'}
												</p>
											</div>
										) : (
											<div
												ref={tileGridRef}
												tabIndex={0}
												className="grid grid-cols-3 gap-4 outline-none"
												role="grid"
												aria-label="Repository tiles"
											>
												{filteredRepositories.map((repo, index) => (
													<RepositoryTile
														key={repo.slug}
														repo={repo}
														theme={theme}
														isSelected={index === selectedTileIndex}
														onSelect={() => handleSelectRepo(repo)}
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
										<span>
											{filteredRepositories.length} repositories • Contribute to open source with AI
										</span>
										<span>↑↓←→ navigate • Enter select • / search • ⌘⇧[] tabs</span>
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
											{activeContributions.length} active contribution
											{activeContributions.length !== 1 ? 's' : ''}
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
												title="Check for merged or closed PRs"
											>
												<RefreshCw
													className={`w-3 h-3 ${isCheckingPRStatuses ? 'animate-spin' : ''}`}
												/>
												Check PR Status
											</button>
										</div>
									</div>

									{/* Content */}
									<div className="flex-1 overflow-y-auto p-4">
										{activeContributions.length === 0 ? (
											<div className="flex flex-col items-center justify-center h-64">
												<Music className="w-12 h-12 mb-3" style={{ color: theme.colors.textDim }} />
												<p className="text-sm mb-1" style={{ color: theme.colors.textMain }}>
													No active contributions
												</p>
												<p className="text-xs mb-4" style={{ color: theme.colors.textDim }}>
													Start a contribution from the Projects tab
												</p>
												<button
													onClick={() => setActiveTab('projects')}
													className="px-3 py-1.5 rounded text-sm"
													style={{
														backgroundColor: theme.colors.accent,
														color: theme.colors.accentForeground,
													}}
												>
													Browse Projects
												</button>
											</div>
										) : (
											<div className="grid grid-cols-2 gap-4">
												{activeContributions.map((contribution) => (
													<ActiveContributionCard
														key={contribution.id}
														contribution={contribution}
														theme={theme}
														onFinalize={() => handleFinalize(contribution.id)}
														onSync={() => handleSyncContribution(contribution.id)}
														isSyncing={syncingContributionId === contribution.id}
													/>
												))}
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
													PRs Created
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
													Merged
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
													Tasks
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
													Tokens
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
													Value
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
													No completed contributions
												</p>
												<p className="text-xs" style={{ color: theme.colors.textDim }}>
													Your contribution history will appear here
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
													Tokens Donated
												</span>
											</div>
											<p
												className="text-2xl font-semibold"
												style={{ color: theme.colors.textMain }}
											>
												{formattedTotalTokens}
											</p>
											<p className="text-xs" style={{ color: theme.colors.textDim }}>
												Worth {formattedTotalCost}
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
													Time Contributed
												</span>
											</div>
											<p
												className="text-2xl font-semibold"
												style={{ color: theme.colors.textMain }}
											>
												{formattedTotalTime}
											</p>
											<p className="text-xs" style={{ color: theme.colors.textDim }}>
												{uniqueRepos} repositories
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
													Streak
												</span>
											</div>
											<p
												className="text-2xl font-semibold"
												style={{ color: theme.colors.textMain }}
											>
												{currentStreakWeeks} weeks
											</p>
											<p className="text-xs" style={{ color: theme.colors.textDim }}>
												Best: {longestStreakWeeks} weeks
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
											Achievements
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
