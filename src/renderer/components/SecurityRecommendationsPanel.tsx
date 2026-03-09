/**
 * SecurityRecommendationsPanel
 *
 * Displays security recommendations based on analysis of security events.
 * Features:
 * - Recommendations grouped by severity (high, medium, low)
 * - Actionable items for each recommendation
 * - Dismissal capability with configurable duration
 * - Refresh button to re-analyze events
 */

import { useState, useEffect, useCallback, memo } from 'react';
import {
	Lightbulb,
	AlertCircle,
	AlertTriangle,
	CheckCircle,
	ChevronDown,
	ChevronRight,
	RefreshCw,
	X,
	XCircle,
	ArrowRight,
	Info,
} from 'lucide-react';
import type { Theme, LlmGuardSettings } from '../types';
import type {
	SecurityRecommendation,
	RecommendationsSummary,
	RecommendationSeverity,
	RecommendationCategory,
} from '../../main/preload/security';

interface SecurityRecommendationsPanelProps {
	theme: Theme;
	llmGuardSettings: LlmGuardSettings;
	/** Compact mode for embedding in settings tab */
	compact?: boolean;
	/** Callback when user wants to navigate to settings */
	onNavigateToSetting?: (setting: string) => void;
}

// Get severity color
const getSeverityColor = (severity: RecommendationSeverity, theme: Theme) => {
	switch (severity) {
		case 'high':
			return theme.colors.error;
		case 'medium':
			return theme.colors.warning;
		case 'low':
			return theme.colors.textDim;
		default:
			return theme.colors.textDim;
	}
};

// Get severity icon
const getSeverityIcon = (severity: RecommendationSeverity) => {
	switch (severity) {
		case 'high':
			return AlertCircle;
		case 'medium':
			return AlertTriangle;
		case 'low':
			return Info;
		default:
			return Info;
	}
};

// Get category display name
const getCategoryDisplayName = (category: RecommendationCategory): string => {
	const names: Record<RecommendationCategory, string> = {
		blocked_content: 'Blocked Content',
		secret_detection: 'Secret Detection',
		pii_detection: 'PII Detection',
		prompt_injection: 'Prompt Injection',
		code_patterns: 'Dangerous Code',
		url_detection: 'URL Detection',
		configuration: 'Configuration',
		usage_patterns: 'Usage Patterns',
	};
	return names[category] || category;
};

// Individual recommendation item component
interface RecommendationItemProps {
	recommendation: SecurityRecommendation;
	isExpanded: boolean;
	onToggleExpand: () => void;
	onDismiss: (id: string) => void;
	theme: Theme;
}

const RecommendationItem = memo(function RecommendationItem({
	recommendation,
	isExpanded,
	onToggleExpand,
	onDismiss,
	theme,
}: RecommendationItemProps) {
	const severityColor = getSeverityColor(recommendation.severity, theme);
	const SeverityIcon = getSeverityIcon(recommendation.severity);

	return (
		<div
			className="rounded border transition-colors"
			style={{
				borderColor: isExpanded ? severityColor + '40' : theme.colors.border,
				backgroundColor: isExpanded ? severityColor + '08' : 'transparent',
			}}
		>
			{/* Header */}
			<button
				className="w-full p-3 flex items-start gap-3 text-left hover:bg-white/5 transition-colors"
				onClick={onToggleExpand}
			>
				{/* Expand/Collapse Icon */}
				<div className="flex-shrink-0 mt-0.5">
					{isExpanded ? (
						<ChevronDown className="w-4 h-4" style={{ color: theme.colors.textDim }} />
					) : (
						<ChevronRight className="w-4 h-4" style={{ color: theme.colors.textDim }} />
					)}
				</div>

				{/* Severity Icon */}
				<div className="flex-shrink-0 mt-0.5">
					<SeverityIcon className="w-4 h-4" style={{ color: severityColor }} />
				</div>

				{/* Content */}
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2 flex-wrap">
						<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							{recommendation.title}
						</span>
						<span
							className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
							style={{
								backgroundColor: severityColor + '20',
								color: severityColor,
							}}
						>
							{recommendation.severity}
						</span>
						<span
							className="px-1.5 py-0.5 rounded text-[9px] uppercase"
							style={{
								backgroundColor: theme.colors.bgActivity,
								color: theme.colors.textDim,
							}}
						>
							{getCategoryDisplayName(recommendation.category)}
						</span>
					</div>
					{!isExpanded && (
						<p className="text-xs mt-1 line-clamp-2" style={{ color: theme.colors.textDim }}>
							{recommendation.description}
						</p>
					)}
				</div>

				{/* Event count */}
				{recommendation.affectedEventCount > 0 && (
					<div className="flex-shrink-0">
						<span
							className="px-2 py-0.5 rounded-full text-[10px] font-medium"
							style={{
								backgroundColor: theme.colors.bgActivity,
								color: theme.colors.textDim,
							}}
						>
							{recommendation.affectedEventCount} event
							{recommendation.affectedEventCount !== 1 ? 's' : ''}
						</span>
					</div>
				)}
			</button>

			{/* Expanded Details */}
			{isExpanded && (
				<div className="px-3 pb-3 pt-0 border-t" style={{ borderColor: theme.colors.border }}>
					{/* Description */}
					<p className="text-xs mb-3 mt-3" style={{ color: theme.colors.textDim }}>
						{recommendation.description}
					</p>

					{/* Action Items */}
					{recommendation.actionItems.length > 0 && (
						<div className="mb-3">
							<div
								className="text-[10px] font-bold uppercase mb-2"
								style={{ color: theme.colors.textMain }}
							>
								Suggested Actions
							</div>
							<ul className="space-y-1.5">
								{recommendation.actionItems.map((item, idx) => (
									<li
										key={idx}
										className="flex items-start gap-2 text-xs"
										style={{ color: theme.colors.textMain }}
									>
										<ArrowRight
											className="w-3 h-3 mt-0.5 flex-shrink-0"
											style={{ color: theme.colors.accent }}
										/>
										<span>{item}</span>
									</li>
								))}
							</ul>
						</div>
					)}

					{/* Related Finding Types */}
					{recommendation.relatedFindingTypes.length > 0 && (
						<div className="mb-3">
							<div
								className="text-[10px] font-bold uppercase mb-1"
								style={{ color: theme.colors.textMain }}
							>
								Related Finding Types
							</div>
							<div className="flex flex-wrap gap-1">
								{recommendation.relatedFindingTypes.map((type, idx) => (
									<span
										key={idx}
										className="px-1.5 py-0.5 rounded text-[9px] font-mono uppercase"
										style={{
											backgroundColor: theme.colors.bgActivity,
											color: theme.colors.textDim,
										}}
									>
										{type.replace(/_/g, ' ')}
									</span>
								))}
							</div>
						</div>
					)}

					{/* Actions */}
					<div className="flex items-center gap-2">
						<button
							onClick={(e) => {
								e.stopPropagation();
								onDismiss(recommendation.id);
							}}
							className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors hover:bg-white/10"
							style={{
								color: theme.colors.textDim,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							<XCircle className="w-3 h-3" />
							Dismiss
						</button>
					</div>
				</div>
			)}
		</div>
	);
});

export const SecurityRecommendationsPanel = memo(function SecurityRecommendationsPanel({
	theme,
	llmGuardSettings,
	compact = false,
	onNavigateToSetting,
}: SecurityRecommendationsPanelProps) {
	const [recommendations, setRecommendations] = useState<SecurityRecommendation[]>([]);
	const [summary, setSummary] = useState<RecommendationsSummary | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
	const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => {
		// Load dismissed IDs from localStorage
		try {
			const stored = localStorage.getItem('maestro:dismissed-recommendations');
			if (stored) {
				const parsed = JSON.parse(stored);
				// Filter out expired dismissals (dismissed > 7 days ago)
				const now = Date.now();
				const validDismissals = Object.entries(parsed)
					.filter(([, timestamp]) => now - (timestamp as number) < 7 * 24 * 60 * 60 * 1000)
					.map(([id]) => id);
				return new Set(validDismissals);
			}
		} catch {
			// Ignore errors
		}
		return new Set();
	});
	const [showAll, setShowAll] = useState(false);

	// Load recommendations
	const loadRecommendations = useCallback(async () => {
		setIsLoading(true);
		try {
			const [recsResult, summaryResult] = await Promise.all([
				window.maestro.security.getRecommendations(llmGuardSettings, {
					excludeDismissed: true,
					dismissedIds: [...dismissedIds],
				}),
				window.maestro.security.getRecommendationsSummary(llmGuardSettings),
			]);
			setRecommendations(recsResult);
			setSummary(summaryResult);
		} catch (error) {
			console.error('Failed to load recommendations:', error);
			setRecommendations([]);
		} finally {
			setIsLoading(false);
		}
	}, [llmGuardSettings, dismissedIds]);

	// Initial load
	useEffect(() => {
		loadRecommendations();
	}, [loadRecommendations]);

	// Toggle expansion
	const toggleExpand = useCallback((id: string) => {
		setExpandedIds((prev) => {
			const newSet = new Set(prev);
			if (newSet.has(id)) {
				newSet.delete(id);
			} else {
				newSet.add(id);
			}
			return newSet;
		});
	}, []);

	// Dismiss recommendation
	const dismissRecommendation = useCallback((id: string) => {
		setDismissedIds((prev) => {
			const newSet = new Set(prev);
			newSet.add(id);
			// Save to localStorage with timestamp
			try {
				const stored = localStorage.getItem('maestro:dismissed-recommendations');
				const existing = stored ? JSON.parse(stored) : {};
				existing[id] = Date.now();
				localStorage.setItem('maestro:dismissed-recommendations', JSON.stringify(existing));
			} catch {
				// Ignore errors
			}
			return newSet;
		});
		// Remove from visible recommendations
		setRecommendations((prev) => prev.filter((r) => r.id !== id));
	}, []);

	// Filter recommendations (exclude dismissed)
	const visibleRecommendations = recommendations.filter((r) => !dismissedIds.has(r.id));

	// Limit display in compact mode
	const displayRecommendations =
		compact && !showAll ? visibleRecommendations.slice(0, 3) : visibleRecommendations;

	// Separate by severity for summary
	const highSeverity = visibleRecommendations.filter((r) => r.severity === 'high');
	const mediumSeverity = visibleRecommendations.filter((r) => r.severity === 'medium');
	const lowSeverity = visibleRecommendations.filter((r) => r.severity === 'low');

	if (isLoading) {
		return (
			<div
				className="rounded-lg border p-4"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgMain,
				}}
			>
				<div className="flex items-center gap-2 mb-3">
					<Lightbulb className="w-4 h-4" style={{ color: theme.colors.accent }} />
					<span className="text-xs font-bold uppercase" style={{ color: theme.colors.textMain }}>
						Security Recommendations
					</span>
				</div>
				<div className="text-xs text-center py-4" style={{ color: theme.colors.textDim }}>
					<RefreshCw className="w-4 h-4 mx-auto mb-2 animate-spin" />
					Analyzing security events...
				</div>
			</div>
		);
	}

	return (
		<div
			className="rounded-lg border p-4"
			style={{
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgMain,
			}}
		>
			{/* Header */}
			<div className="flex items-center justify-between mb-3">
				<div className="flex items-center gap-2">
					<Lightbulb className="w-4 h-4" style={{ color: theme.colors.accent }} />
					<span className="text-xs font-bold uppercase" style={{ color: theme.colors.textMain }}>
						Security Recommendations
					</span>
					{visibleRecommendations.length > 0 && (
						<span
							className="px-1.5 py-0.5 rounded text-[10px] font-medium"
							style={{
								backgroundColor:
									highSeverity.length > 0
										? theme.colors.error + '20'
										: mediumSeverity.length > 0
											? theme.colors.warning + '20'
											: theme.colors.bgActivity,
								color:
									highSeverity.length > 0
										? theme.colors.error
										: mediumSeverity.length > 0
											? theme.colors.warning
											: theme.colors.textDim,
							}}
						>
							{visibleRecommendations.length}
						</span>
					)}
				</div>
				<button
					onClick={loadRecommendations}
					className="p-1.5 rounded hover:bg-white/10 transition-colors"
					title="Refresh recommendations"
				>
					<RefreshCw
						className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`}
						style={{ color: theme.colors.textDim }}
					/>
				</button>
			</div>

			{/* Summary Stats */}
			{summary && visibleRecommendations.length > 0 && (
				<div
					className="flex items-center gap-3 mb-3 pb-3 border-b"
					style={{ borderColor: theme.colors.border }}
				>
					{highSeverity.length > 0 && (
						<div className="flex items-center gap-1">
							<AlertCircle className="w-3 h-3" style={{ color: theme.colors.error }} />
							<span className="text-xs font-medium" style={{ color: theme.colors.error }}>
								{highSeverity.length} High
							</span>
						</div>
					)}
					{mediumSeverity.length > 0 && (
						<div className="flex items-center gap-1">
							<AlertTriangle className="w-3 h-3" style={{ color: theme.colors.warning }} />
							<span className="text-xs font-medium" style={{ color: theme.colors.warning }}>
								{mediumSeverity.length} Medium
							</span>
						</div>
					)}
					{lowSeverity.length > 0 && (
						<div className="flex items-center gap-1">
							<Info className="w-3 h-3" style={{ color: theme.colors.textDim }} />
							<span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
								{lowSeverity.length} Low
							</span>
						</div>
					)}
				</div>
			)}

			{/* Recommendations List */}
			{visibleRecommendations.length === 0 ? (
				<div className="text-center py-6">
					<CheckCircle className="w-8 h-8 mx-auto mb-2" style={{ color: theme.colors.success }} />
					<p className="text-xs" style={{ color: theme.colors.textMain }}>
						No recommendations at this time
					</p>
					<p className="text-[10px] mt-1" style={{ color: theme.colors.textDim }}>
						Your security settings are looking good!
					</p>
				</div>
			) : (
				<div className="space-y-2">
					{displayRecommendations.map((rec) => (
						<RecommendationItem
							key={rec.id}
							recommendation={rec}
							isExpanded={expandedIds.has(rec.id)}
							onToggleExpand={() => toggleExpand(rec.id)}
							onDismiss={dismissRecommendation}
							theme={theme}
						/>
					))}

					{/* Show more button in compact mode */}
					{compact && visibleRecommendations.length > 3 && (
						<button
							onClick={() => setShowAll(!showAll)}
							className="w-full py-2 text-xs font-medium rounded hover:bg-white/5 transition-colors"
							style={{ color: theme.colors.accent }}
						>
							{showAll
								? 'Show less'
								: `Show ${visibleRecommendations.length - 3} more recommendation${visibleRecommendations.length - 3 !== 1 ? 's' : ''}`}
						</button>
					)}
				</div>
			)}

			{/* Help text */}
			<p className="text-[10px] mt-3" style={{ color: theme.colors.textDim }}>
				Recommendations are based on your security event history and current configuration.
				Dismissed recommendations will reappear after 7 days.
			</p>
		</div>
	);
});
