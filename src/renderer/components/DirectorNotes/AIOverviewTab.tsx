import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Save, Loader2, Clock, Copy, Check, Bot, History, Timer } from 'lucide-react';
import type { Theme } from '../../types';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { SaveMarkdownModal } from '../SaveMarkdownModal';
import { useSettings } from '../../hooks';
import { generateTerminalProseStyles } from '../../utils/markdownConfig';
import { safeClipboardWrite } from '../../utils/clipboard';
import { notifyToast } from '../../stores/notificationStore';
import { useModalStore } from '../../stores/modalStore';

type SynopsisStats = NonNullable<
	Awaited<ReturnType<typeof window.maestro.directorNotes.generateSynopsis>>['stats']
>;

interface AIOverviewTabProps {
	theme: Theme;
	onSynopsisReady?: () => void;
	onProgressChange?: (percent: number) => void;
}

// Module-level cache so synopsis survives tab switches (unmount/remount)
let cachedSynopsis: {
	content: string;
	generatedAt: number;
	lookbackDays: number;
	stats?: SynopsisStats;
} | null = null;

// Exported for testing only – allows resetting the module-level cache between test runs
export function _resetCacheForTesting() {
	cachedSynopsis = null;
	activeGenerationPromise = null;
}

// Check whether a cached synopsis exists (any lookback window)
export function hasCachedSynopsis(): boolean {
	return cachedSynopsis !== null;
}

// Module-level: tracks the in-flight synopsis IPC promise.
// Prevents duplicate generation when the modal is closed and reopened
// while a generation is still running in the main process.
type SynopsisResult = Awaited<ReturnType<typeof window.maestro.directorNotes.generateSynopsis>>;
let activeGenerationPromise: Promise<SynopsisResult> | null = null;

/** Fire a toast when synopsis completes while the modal is closed */
function fireSynopsisReadyToast() {
	notifyToast({
		type: 'success',
		title: "Director's Notes",
		message: 'AI Synopsis is ready. Click to view.',
		skipCustomNotification: true,
		onClick: () => {
			useModalStore.getState().openModal('directorNotes', { initialTab: 'ai-overview' });
		},
	});
}

// Heuristic: expected chunk count for a typical synopsis generation.
// Progress uses an asymptotic curve so the bar never stalls at 100% before completion.
const EXPECTED_CHUNKS = 60;

export function AIOverviewTab({ theme, onSynopsisReady, onProgressChange }: AIOverviewTabProps) {
	const { directorNotesSettings } = useSettings();
	const [lookbackDays, setLookbackDays] = useState(directorNotesSettings.defaultLookbackDays);
	const [synopsis, setSynopsis] = useState<string>(cachedSynopsis?.content ?? '');
	const [generatedAt, setGeneratedAt] = useState<number | null>(
		cachedSynopsis?.generatedAt ?? null
	);
	const [isGenerating, setIsGenerating] = useState(false);
	const [progress, setProgress] = useState({ phase: 'idle', message: '', percent: 0 });
	const [showSaveModal, setShowSaveModal] = useState(false);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [stats, setStats] = useState<SynopsisStats | null>(cachedSynopsis?.stats ?? null);
	const mountedRef = useRef(true);
	const isGeneratingRef = useRef(false);

	// Generate prose styles for markdown rendering
	const proseStyles = generateTerminalProseStyles(theme, '.director-notes-content');

	// Format generation duration for display
	const formatDurationMs = (ms: number): string => {
		const totalSeconds = Math.floor(ms / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		if (minutes > 0) return `${minutes}m ${seconds}s`;
		return `${seconds}s`;
	};

	// Format the generation timestamp
	const formatGeneratedAt = (timestamp: number): string => {
		const date = new Date(timestamp);
		return date.toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
		});
	};

	// Copy synopsis markdown to clipboard
	const copyToClipboard = useCallback(async () => {
		if (!synopsis) return;
		const ok = await safeClipboardWrite(synopsis);
		if (ok) {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	}, [synopsis]);

	// Stable ref for onProgressChange to avoid re-subscribing
	const onProgressChangeRef = useRef(onProgressChange);
	onProgressChangeRef.current = onProgressChange;

	// Subscribe to progress updates from main process
	useEffect(() => {
		const cleanup = window.maestro.directorNotes.onSynopsisProgress((update) => {
			if (!isGeneratingRef.current) return;
			// Asymptotic progress: approaches 95% but never reaches it before completion
			const ratio = update.chunkCount / EXPECTED_CHUNKS;
			const percent = Math.min(5 + 90 * (1 - Math.exp(-2 * ratio)), 95);
			const rounded = Math.round(percent);
			const elapsedSec = Math.floor(update.elapsedMs / 1000);
			const kbReceived = (update.bytesReceived / 1024).toFixed(1);
			setProgress({
				phase: 'generating',
				message: `${rounded}% · ${kbReceived} KB · ${elapsedSec}s`,
				percent: rounded,
			});
			onProgressChangeRef.current?.(rounded);
		});
		return cleanup;
	}, []);

	// Generate synopsis — the handler reads history files directly via file paths,
	// so the renderer only needs to make a single IPC call.
	const generateSynopsis = useCallback(async () => {
		setIsGenerating(true);
		isGeneratingRef.current = true;
		setError(null);
		setProgress({ phase: 'generating', message: 'Starting...', percent: 2 });

		const ipcPromise = window.maestro.directorNotes.generateSynopsis({
			lookbackDays,
			provider: directorNotesSettings.provider,
			customPath: directorNotesSettings.customPath,
			customArgs: directorNotesSettings.customArgs,
			customEnvVars: directorNotesSettings.customEnvVars,
		});
		activeGenerationPromise = ipcPromise;

		try {
			const result = await ipcPromise;

			// Always cache regardless of mount state so result is available next open
			if (result.success) {
				const ts = result.generatedAt ?? Date.now();
				cachedSynopsis = {
					content: result.synopsis,
					generatedAt: ts,
					lookbackDays,
					stats: result.stats,
				};
			}

			// If component unmounted while generating, fire a toast notification
			if (!mountedRef.current) {
				if (result.success) {
					fireSynopsisReadyToast();
				}
				return;
			}

			if (result.success) {
				const ts = result.generatedAt ?? Date.now();
				setSynopsis(result.synopsis);
				setGeneratedAt(ts);
				setStats(result.stats ?? null);
				setProgress({ phase: 'complete', message: 'Synopsis complete', percent: 100 });
				onSynopsisReady?.();
			} else {
				setError(result.error || 'Failed to generate synopsis');
			}
		} catch (err) {
			if (!mountedRef.current) return;
			setError(err instanceof Error ? err.message : 'Failed to generate synopsis');
		} finally {
			// Only clear if this is still the active generation (not overwritten by Regenerate)
			if (activeGenerationPromise === ipcPromise) {
				activeGenerationPromise = null;
			}
			isGeneratingRef.current = false;
			if (mountedRef.current) {
				setIsGenerating(false);
			}
		}
	}, [lookbackDays, directorNotesSettings, onSynopsisReady]);

	// On mount: use cache if available, attach to in-flight generation, or start fresh
	useEffect(() => {
		mountedRef.current = true;
		if (cachedSynopsis) {
			setSynopsis(cachedSynopsis.content);
			setGeneratedAt(cachedSynopsis.generatedAt);
			setStats(cachedSynopsis.stats ?? null);
			setLookbackDays(cachedSynopsis.lookbackDays);
			onSynopsisReady?.();
		} else if (activeGenerationPromise) {
			// A generation is already in flight (started before modal was closed).
			// Attach to it instead of starting a duplicate.
			setIsGenerating(true);
			isGeneratingRef.current = true;
			setProgress({ phase: 'generating', message: 'Resuming...', percent: 2 });

			const existingPromise = activeGenerationPromise;
			existingPromise
				.then((result) => {
					if (!mountedRef.current) return;
					if (result.success) {
						const ts = result.generatedAt ?? Date.now();
						setSynopsis(result.synopsis);
						setGeneratedAt(ts);
						setStats(result.stats ?? null);
						if (cachedSynopsis) setLookbackDays(cachedSynopsis.lookbackDays);
						setProgress({ phase: 'complete', message: 'Synopsis complete', percent: 100 });
						onSynopsisReady?.();
					} else {
						setError(result.error || 'Failed to generate synopsis');
					}
				})
				.catch((err) => {
					if (!mountedRef.current) return;
					setError(err instanceof Error ? err.message : 'Failed to generate synopsis');
				})
				.finally(() => {
					isGeneratingRef.current = false;
					if (mountedRef.current) {
						setIsGenerating(false);
					}
				});
		} else {
			generateSynopsis();
		}
		return () => {
			mountedRef.current = false;
		};
	}, []); // Only on mount

	return (
		<div className="flex flex-col h-full">
			{/* Header: Controls */}
			<div
				className="shrink-0 p-4 border-b flex items-center gap-4 flex-wrap"
				style={{ borderColor: theme.colors.border }}
			>
				{/* Lookback slider */}
				<div className="flex items-center gap-3 flex-1 min-w-[200px]">
					<label
						className="text-xs font-bold whitespace-nowrap"
						style={{ color: theme.colors.textMain }}
					>
						Lookback: {lookbackDays} days
					</label>
					<input
						type="range"
						min={1}
						max={90}
						value={lookbackDays}
						onChange={(e) => setLookbackDays(Number(e.target.value))}
						className="flex-1 accent-indigo-500"
					/>
				</div>

				{/* Generated at timestamp — stays visible during regeneration */}
				{generatedAt && (
					<div className="flex items-center gap-1.5" style={{ color: theme.colors.textDim }}>
						<Clock className="w-3 h-3" />
						<span className="text-xs">{formatGeneratedAt(generatedAt)}</span>
					</div>
				)}

				{/* Regenerate button — only this disables during generation */}
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
					{isGenerating ? 'Regenerating…' : 'Regenerate'}
				</button>

				{/* Save button — enabled whenever we have content */}
				<button
					onClick={() => setShowSaveModal(true)}
					disabled={!synopsis}
					className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors"
					style={{
						backgroundColor: theme.colors.bgActivity,
						color: theme.colors.textMain,
						border: `1px solid ${theme.colors.border}`,
						opacity: synopsis ? 1 : 0.5,
					}}
				>
					<Save className="w-3.5 h-3.5" />
					Save
				</button>

				{/* Copy to clipboard button — enabled whenever we have content */}
				<button
					onClick={copyToClipboard}
					disabled={!synopsis}
					className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors"
					style={{
						backgroundColor: theme.colors.bgActivity,
						color: copied ? theme.colors.accent : theme.colors.textMain,
						border: `1px solid ${copied ? theme.colors.accent : theme.colors.border}`,
						opacity: synopsis ? 1 : 0.5,
					}}
				>
					{copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
					{copied ? 'Copied!' : 'Copy'}
				</button>
			</div>

			{/* Progress bar — shown during any generation (initial or regeneration) */}
			{isGenerating && (
				<div className="shrink-0 px-4 py-2" style={{ backgroundColor: theme.colors.bgActivity }}>
					<div className="flex items-center gap-3">
						<div
							className="flex-1 h-2 rounded-full overflow-hidden"
							style={{ backgroundColor: theme.colors.border }}
						>
							<div
								className="h-full transition-all duration-500 ease-out"
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

			{/* Stats bar — stays visible during regeneration */}
			{stats && synopsis && (
				<div
					className="shrink-0 flex items-center gap-6 px-6 py-2.5 border-b"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
				>
					<div className="flex items-center gap-1.5" style={{ color: theme.colors.textDim }}>
						<History className="w-3.5 h-3.5" />
						<span className="text-xs">
							<span style={{ color: theme.colors.textMain, fontWeight: 600 }}>
								{stats.entryCount}
							</span>{' '}
							{stats.entryCount === 1 ? 'history entry' : 'history entries'}
						</span>
					</div>
					<div className="flex items-center gap-1.5" style={{ color: theme.colors.textDim }}>
						<Bot className="w-3.5 h-3.5" />
						<span className="text-xs">
							across{' '}
							<span style={{ color: theme.colors.textMain, fontWeight: 600 }}>
								{stats.agentCount}
							</span>{' '}
							{stats.agentCount === 1 ? 'agent' : 'agents'}
						</span>
					</div>
					{stats.durationMs > 0 && (
						<div className="flex items-center gap-1.5" style={{ color: theme.colors.textDim }}>
							<Timer className="w-3.5 h-3.5" />
							<span className="text-xs">
								generated in{' '}
								<span style={{ color: theme.colors.textMain, fontWeight: 600 }}>
									{formatDurationMs(stats.durationMs)}
								</span>
							</span>
						</div>
					)}
				</div>
			)}

			{/* Content — old notes stay visible and scrollable during regeneration */}
			<div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
				{/* Error banner — shown above content so old notes remain readable */}
				{error && (
					<div
						className={`p-4 rounded border ${synopsis ? 'mb-4' : ''}`}
						style={{
							backgroundColor: theme.colors.error + '10',
							borderColor: theme.colors.error + '40',
							color: theme.colors.error,
						}}
					>
						{error}
					</div>
				)}
				{synopsis ? (
					<div className="director-notes-content">
						<style>{proseStyles}</style>
						<MarkdownRenderer
							content={synopsis}
							theme={theme}
							onCopy={(text) => safeClipboardWrite(text)}
						/>
					</div>
				) : isGenerating ? (
					<div className="flex items-center justify-center h-full">
						<div className="text-center w-64">
							<Loader2
								className="w-8 h-8 animate-spin mx-auto mb-3"
								style={{ color: theme.colors.accent }}
							/>
							<div
								className="h-2 rounded-full overflow-hidden mb-2"
								style={{ backgroundColor: theme.colors.border }}
							>
								<div
									className="h-full transition-all duration-500 ease-out"
									style={{
										width: `${progress.percent}%`,
										backgroundColor: theme.colors.accent,
									}}
								/>
							</div>
							<p className="text-sm" style={{ color: theme.colors.textDim }}>
								{progress.message || 'Starting...'}
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
