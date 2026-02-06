import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Save, Loader2 } from 'lucide-react';
import type { Theme } from '../../types';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { SaveMarkdownModal } from '../SaveMarkdownModal';
import { useSettings } from '../../hooks';
import { generateTerminalProseStyles } from '../../utils/markdownConfig';

interface AIOverviewTabProps {
	theme: Theme;
	onSynopsisReady?: () => void;
}

export function AIOverviewTab({ theme, onSynopsisReady }: AIOverviewTabProps) {
	const { directorNotesSettings } = useSettings();
	const [lookbackDays, setLookbackDays] = useState(directorNotesSettings.defaultLookbackDays);
	const [synopsis, setSynopsis] = useState<string>('');
	const [isGenerating, setIsGenerating] = useState(false);
	const [progress, setProgress] = useState({ phase: 'idle', message: '', percent: 0 });
	const [showSaveModal, setShowSaveModal] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Generate prose styles for markdown rendering
	const proseStyles = generateTerminalProseStyles(theme, '.director-notes-content');

	// Generate synopsis
	const generateSynopsis = useCallback(async () => {
		setIsGenerating(true);
		setError(null);
		setProgress({ phase: 'gathering', message: 'Gathering history data...', percent: 10 });

		try {
			// Get unified history
			const entries = await window.maestro.directorNotes.getUnifiedHistory({
				lookbackDays,
				filter: null,
			});

			if (entries.length === 0) {
				setSynopsis('# Director\'s Notes\n\nNo history entries found for the selected time period.');
				onSynopsisReady?.();
				setIsGenerating(false);
				return;
			}

			setProgress({ phase: 'analyzing', message: 'Estimating context size...', percent: 30 });

			// Estimate tokens to determine strategy
			const estimatedTokens = await window.maestro.directorNotes.estimateTokens(entries);

			if (estimatedTokens > 100000) {
				// Hierarchical strategy needed - show progress for each agent
				// Falls through to standard generation for now; hierarchical generation is a future enhancement
				setProgress({ phase: 'generating', message: 'Large dataset - using hierarchical analysis...', percent: 40 });
			}

			setProgress({ phase: 'generating', message: 'Generating synopsis...', percent: 60 });

			// Generate synopsis
			const result = await window.maestro.directorNotes.generateSynopsis({
				lookbackDays,
				provider: directorNotesSettings.provider,
			});

			if (result.success) {
				setSynopsis(result.synopsis);
				setProgress({ phase: 'complete', message: 'Synopsis complete', percent: 100 });
				onSynopsisReady?.();
			} else {
				setError(result.error || 'Failed to generate synopsis');
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to generate synopsis');
		} finally {
			setIsGenerating(false);
		}
	}, [lookbackDays, directorNotesSettings.provider, onSynopsisReady]);

	// Generate on mount
	useEffect(() => {
		generateSynopsis();
	}, []); // Only on mount - use Refresh button for manual regeneration

	return (
		<div className="flex flex-col h-full">
			{/* Header: Controls */}
			<div
				className="shrink-0 p-4 border-b flex items-center gap-4 flex-wrap"
				style={{ borderColor: theme.colors.border }}
			>
				{/* Lookback slider */}
				<div className="flex items-center gap-3 flex-1 min-w-[200px]">
					<label className="text-xs font-bold whitespace-nowrap" style={{ color: theme.colors.textMain }}>
						Lookback: {lookbackDays} days
					</label>
					<input
						type="range"
						min={1}
						max={90}
						value={lookbackDays}
						onChange={(e) => setLookbackDays(Number(e.target.value))}
						className="flex-1 accent-indigo-500"
						disabled={isGenerating}
					/>
				</div>

				{/* Refresh button */}
				<button
					onClick={generateSynopsis}
					disabled={isGenerating}
					className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
						opacity: isGenerating ? 0.5 : 1,
					}}
				>
					{isGenerating ? (
						<Loader2 className="w-3.5 h-3.5 animate-spin" />
					) : (
						<RefreshCw className="w-3.5 h-3.5" />
					)}
					Refresh
				</button>

				{/* Save button */}
				<button
					onClick={() => setShowSaveModal(true)}
					disabled={!synopsis || isGenerating}
					className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors"
					style={{
						backgroundColor: theme.colors.bgActivity,
						color: theme.colors.textMain,
						border: `1px solid ${theme.colors.border}`,
						opacity: synopsis && !isGenerating ? 1 : 0.5,
					}}
				>
					<Save className="w-3.5 h-3.5" />
					Save
				</button>
			</div>

			{/* Progress bar (during generation) */}
			{isGenerating && (
				<div className="shrink-0 px-4 py-2" style={{ backgroundColor: theme.colors.bgActivity }}>
					<div className="flex items-center gap-3">
						<div
							className="flex-1 h-2 rounded-full overflow-hidden"
							style={{ backgroundColor: theme.colors.border }}
						>
							<div
								className="h-full transition-all duration-300"
								style={{
									width: `${progress.percent}%`,
									backgroundColor: theme.colors.accent,
								}}
							/>
						</div>
						<span className="text-xs whitespace-nowrap" style={{ color: theme.colors.textDim }}>
							{progress.message}
						</span>
					</div>
				</div>
			)}

			{/* Content */}
			<div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
				{error ? (
					<div
						className="p-4 rounded border"
						style={{
							backgroundColor: theme.colors.error + '10',
							borderColor: theme.colors.error + '40',
							color: theme.colors.error,
						}}
					>
						{error}
					</div>
				) : synopsis ? (
					<div className="director-notes-content">
						<style>{proseStyles}</style>
						<MarkdownRenderer
							content={synopsis}
							theme={theme}
							onCopy={(text) => navigator.clipboard.writeText(text)}
							allowRawHtml
						/>
					</div>
				) : isGenerating ? (
					<div className="flex items-center justify-center h-full">
						<div className="text-center">
							<Loader2
								className="w-8 h-8 animate-spin mx-auto mb-3"
								style={{ color: theme.colors.accent }}
							/>
							<p className="text-sm" style={{ color: theme.colors.textDim }}>
								{progress.message || 'Generating synopsis...'}
							</p>
						</div>
					</div>
				) : null}
			</div>

			{/* Save Modal */}
			{showSaveModal && (
				<SaveMarkdownModal
					theme={theme}
					content={synopsis}
					onClose={() => setShowSaveModal(false)}
					defaultFolder=""
				/>
			)}
		</div>
	);
}
