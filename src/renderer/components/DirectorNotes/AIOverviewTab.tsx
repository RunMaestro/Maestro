import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
	RefreshCw,
	Save,
	Clock,
	Copy,
	Check,
	Bot,
	History,
	Timer,
	AArrowUp,
	AArrowDown,
} from 'lucide-react';
import { Spinner } from '../ui/Spinner';
import type { Theme } from '../../types';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { RichOverview } from './RichOverview';
import { SaveMarkdownModal } from '../SaveMarkdownModal';
import { useSettings } from '../../hooks';
import { generateTerminalProseStyles } from '../../utils/markdownConfig';
import { safeClipboardWrite } from '../../utils/clipboard';
import { formatNumber } from '../../../shared/formatters';
import { notifyToast } from '../../stores/notificationStore';
import { useModalStore } from '../../stores/modalStore';
import {
	narrativeToMarkdown,
	type DirectorNotesNarrative,
} from '../../../shared/directorNotesNarrative';

type SynopsisStats = NonNullable<
	Awaited<ReturnType<typeof window.maestro.directorNotes.generateSynopsis>>['stats']
>;

interface AIOverviewTabProps {
	theme: Theme;
	onSynopsisReady?: () => void;
}

// Font-scale zoom for the rendered synopsis. Stored as an em multiplier so the
// em-based prose styles scale proportionally. Persisted to localStorage so the
// chosen size is remembered across opens of Director's Notes.
const FONT_SCALE_STORAGE_KEY = 'directorNotes.fontScale';
const FONT_SCALE_MIN = 0.7;
const FONT_SCALE_MAX = 2.0;
const FONT_SCALE_STEP = 0.1;
const FONT_SCALE_DEFAULT = 1.0;

function clampFontScale(value: number): number {
	if (!Number.isFinite(value)) return FONT_SCALE_DEFAULT;
	return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, value));
}

function loadFontScale(): number {
	const raw = localStorage.getItem(FONT_SCALE_STORAGE_KEY);
	if (raw === null) return FONT_SCALE_DEFAULT;
	return clampFontScale(Number(raw));
}

// Rich vs Plain reading mode for the AI Overview. Rich is a widget dashboard
// (stat cards, timeline, breakdowns) rendered from deterministic data. Plain
// reproduces the pre-Rich-Mode reading experience: a markdown synopsis. The
// agent now emits the structured JSON narrative, so Plain Mode (and Copy/Save)
// render `narrativeToMarkdown(narrative)` rather than the raw JSON string,
// falling back to the raw `synopsis` for legacy/no-data/parse-failure results.
//
// Mode resolution layers two sources: the persisted `directorNotesSettings.
// defaultMode` is the baseline default (a real product setting), and the
// localStorage key below is a transient per-session override that the in-tab
// toggle writes. The override wins when present; otherwise we fall back to the
// persisted default, then to 'rich'.
const VIEW_MODE_STORAGE_KEY = 'directorNotes.viewMode';
type ViewMode = 'rich' | 'plain';
const VIEW_MODE_DEFAULT: ViewMode = 'rich';

function loadViewMode(persistedDefault: ViewMode): ViewMode {
	const raw = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
	return raw === 'rich' || raw === 'plain' ? raw : persistedDefault;
}

// Module-level cache so synopsis survives tab switches (unmount/remount)
let cachedSynopsis: {
	content: string;
	generatedAt: number;
	lookbackDays: number;
	stats?: SynopsisStats;
	narrative?: DirectorNotesNarrative | null;
	narrativeError?: string | null;
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
		dismissible: true,
		onClick: () => {
			useModalStore.getState().openModal('directorNotes', { initialTab: 'ai-overview' });
		},
	});
}

export function AIOverviewTab({ theme, onSynopsisReady }: AIOverviewTabProps) {
	const { directorNotesSettings, bionifyReadingMode } = useSettings();
	const [lookbackDays, setLookbackDays] = useState(directorNotesSettings.defaultLookbackDays);
	const [synopsis, setSynopsis] = useState<string>(cachedSynopsis?.content ?? '');
	// Structured narrative (Rich Mode) and its overt parse-failure detail, both
	// derived from the synopsis result. Plain Mode ignores these and renders the
	// raw `synopsis` markdown.
	const [narrative, setNarrative] = useState<DirectorNotesNarrative | null>(
		cachedSynopsis?.narrative ?? null
	);
	const [narrativeError, setNarrativeError] = useState<string | null>(
		cachedSynopsis?.narrativeError ?? null
	);
	const [generatedAt, setGeneratedAt] = useState<number | null>(
		cachedSynopsis?.generatedAt ?? null
	);
	const [isGenerating, setIsGenerating] = useState(false);
	const [showSaveModal, setShowSaveModal] = useState(false);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [stats, setStats] = useState<SynopsisStats | null>(cachedSynopsis?.stats ?? null);
	const [fontScale, setFontScale] = useState<number>(loadFontScale);
	// Baseline default from the persisted setting; the localStorage override
	// (written by the in-tab toggle) layers on top of it.
	const [viewMode, setViewMode] = useState<ViewMode>(() =>
		loadViewMode(directorNotesSettings.defaultMode ?? VIEW_MODE_DEFAULT)
	);
	const mountedRef = useRef(true);

	// Adjust the synopsis font size and persist the new scale.
	const adjustFontScale = useCallback((direction: -1 | 1) => {
		setFontScale((prev) => {
			const next = clampFontScale(prev + direction * FONT_SCALE_STEP);
			localStorage.setItem(FONT_SCALE_STORAGE_KEY, String(next));
			return next;
		});
	}, []);

	// Switch reading mode and persist the choice.
	const changeViewMode = useCallback((mode: ViewMode) => {
		setViewMode(mode);
		localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
	}, []);
	const isGeneratingRef = useRef(false);

	// Base prose styling for the Plain-mode markdown block. (Rich mode frames the
	// narrative inside RichOverview, which injects its own base prose styles.)
	const proseStyles = generateTerminalProseStyles(theme, '.director-notes-content');

	// Font-scale override. MarkdownRenderer's root `.prose` carries Tailwind's
	// `text-sm` (0.875rem, an absolute rem unit), which would otherwise pin the
	// base font size and ignore the zoom control. Override it with a scaled size
	// (same selector → higher specificity than the utility class) so the em-based
	// prose children scale proportionally. Injected at the content-container
	// level so it applies to both the Plain block and the Rich narrative, which
	// share the `.director-notes-content` class.
	const proseScaleRule = `.director-notes-content .prose { font-size: calc(0.875rem * ${fontScale}) !important; }`;

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

	// Human-readable markdown for Plain Mode, Copy, and Save. The agent emits the
	// structured JSON narrative now, so render that as prose; only fall back to
	// the raw `synopsis` for legacy markdown, the no-data message, or a parse
	// failure (when there is no parsed narrative to convert).
	const plainContent = useMemo(
		() => (narrative ? narrativeToMarkdown(narrative) : synopsis),
		[narrative, synopsis]
	);

	// Copy the readable synopsis markdown to clipboard
	const copyToClipboard = useCallback(async () => {
		if (!plainContent) return;
		const ok = await safeClipboardWrite(plainContent);
		if (ok) {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	}, [plainContent]);

	// Generate synopsis - the handler reads history files directly via file paths,
	// so the renderer only needs to make a single IPC call.
	const generateSynopsis = useCallback(async () => {
		setIsGenerating(true);
		isGeneratingRef.current = true;
		setError(null);

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
					narrative: result.narrative ?? null,
					narrativeError: result.narrativeError ?? null,
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
				setNarrative(result.narrative ?? null);
				setNarrativeError(result.narrativeError ?? null);
				setGeneratedAt(ts);
				setStats(result.stats ?? null);
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
			setNarrative(cachedSynopsis.narrative ?? null);
			setNarrativeError(cachedSynopsis.narrativeError ?? null);
			setGeneratedAt(cachedSynopsis.generatedAt);
			setStats(cachedSynopsis.stats ?? null);
			setLookbackDays(cachedSynopsis.lookbackDays);
			onSynopsisReady?.();
		} else if (activeGenerationPromise) {
			// A generation is already in flight (started before modal was closed).
			// Attach to it instead of starting a duplicate.
			setIsGenerating(true);
			isGeneratingRef.current = true;

			const existingPromise = activeGenerationPromise;
			existingPromise
				.then((result) => {
					if (!mountedRef.current) return;
					if (result.success) {
						const ts = result.generatedAt ?? Date.now();
						setSynopsis(result.synopsis);
						setNarrative(result.narrative ?? null);
						setNarrativeError(result.narrativeError ?? null);
						setGeneratedAt(ts);
						setStats(result.stats ?? null);
						if (cachedSynopsis) setLookbackDays(cachedSynopsis.lookbackDays);
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
						htmlFor="director-notes-lookback"
						className="text-xs font-bold whitespace-nowrap"
						style={{ color: theme.colors.textMain }}
					>
						Lookback: {lookbackDays} days
					</label>
					<input
						id="director-notes-lookback"
						type="range"
						min={1}
						max={90}
						value={lookbackDays}
						onChange={(e) => setLookbackDays(Number(e.target.value))}
						className="focus-ring rounded flex-1"
						style={{ accentColor: theme.colors.accent }}
						aria-label={`Lookback window: ${lookbackDays} days`}
					/>
				</div>

				{/* Generated at timestamp - stays visible during regeneration */}
				{generatedAt && (
					<div className="flex items-center gap-1.5" style={{ color: theme.colors.textDim }}>
						<Clock className="w-3 h-3" />
						<span className="text-xs">{formatGeneratedAt(generatedAt)}</span>
					</div>
				)}

				{/* Rich/Plain mode toggle - segmented control. Rich is the default
				    widget dashboard; Plain is today's exact markdown view. */}
				<div
					className="flex items-center rounded overflow-hidden"
					style={{ border: `1px solid ${theme.colors.border}` }}
					role="group"
					aria-label="Reading mode"
				>
					{(['rich', 'plain'] as ViewMode[]).map((mode) => {
						const active = viewMode === mode;
						return (
							<button
								key={mode}
								type="button"
								onClick={() => changeViewMode(mode)}
								aria-pressed={active}
								// Inset ring (the wrapper is rounded + overflow-hidden, so an
								// outset ring would be clipped). On the active segment the ring
								// rides an accent fill, so use the contrasting accentForeground.
								className="focus-ring-inset px-3 py-1.5 text-xs font-medium capitalize transition-colors"
								style={{
									backgroundColor: active ? theme.colors.accent : 'transparent',
									color: active ? theme.colors.accentForeground : theme.colors.textDim,
									['--focus-ring-color' as any]: active
										? theme.colors.accentForeground
										: theme.colors.accent,
								}}
							>
								{mode}
							</button>
						);
					})}
				</div>

				{/* Regenerate button - only this disables during generation */}
				<button
					type="button"
					onClick={generateSynopsis}
					disabled={isGenerating}
					className="focus-ring flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
						opacity: isGenerating ? 0.5 : 1,
					}}
				>
					{isGenerating ? <Spinner size={14} /> : <RefreshCw className="w-3.5 h-3.5" />}
					{isGenerating ? 'Regenerating…' : 'Regenerate'}
				</button>

				{/* Save button - enabled whenever we have content */}
				<button
					type="button"
					onClick={() => setShowSaveModal(true)}
					disabled={!synopsis}
					className="focus-ring flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors"
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

				{/* Copy to clipboard button - enabled whenever we have content */}
				<button
					type="button"
					onClick={copyToClipboard}
					disabled={!synopsis}
					className="focus-ring flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors"
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

			{/* Stats bar - stays visible during regeneration */}
			{stats && synopsis && (
				<div
					className="shrink-0 flex items-center gap-6 px-6 py-2.5 border-b"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
				>
					<div className="flex items-center gap-1.5" style={{ color: theme.colors.textDim }}>
						<History className="w-3.5 h-3.5" />
						<span className="text-xs">
							<span style={{ color: theme.colors.textMain, fontWeight: 600 }}>
								{formatNumber(stats.entryCount)}
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

					{/* Font-size controls - right-justified, scale only the synopsis text */}
					<div className="ml-auto flex items-center gap-1">
						<button
							type="button"
							onClick={() => adjustFontScale(-1)}
							disabled={fontScale <= FONT_SCALE_MIN}
							aria-label="Decrease font size"
							title="Decrease font size"
							className="focus-ring flex items-center justify-center w-7 h-7 rounded transition-colors hover:opacity-100"
							style={{
								color: theme.colors.textDim,
								border: `1px solid ${theme.colors.border}`,
								opacity: fontScale <= FONT_SCALE_MIN ? 0.4 : 0.8,
								cursor: fontScale <= FONT_SCALE_MIN ? 'default' : 'pointer',
							}}
						>
							<AArrowDown className="w-4 h-4" />
						</button>
						<button
							type="button"
							onClick={() => adjustFontScale(1)}
							disabled={fontScale >= FONT_SCALE_MAX}
							aria-label="Increase font size"
							title="Increase font size"
							className="focus-ring flex items-center justify-center w-7 h-7 rounded transition-colors hover:opacity-100"
							style={{
								color: theme.colors.textDim,
								border: `1px solid ${theme.colors.border}`,
								opacity: fontScale >= FONT_SCALE_MAX ? 0.4 : 0.8,
								cursor: fontScale >= FONT_SCALE_MAX ? 'default' : 'pointer',
							}}
						>
							<AArrowUp className="w-4 h-4" />
						</button>
					</div>
				</div>
			)}

			{/* Content - old notes stay visible and scrollable during regeneration */}
			<div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
				{/* Font-scale override - applies to both Plain and Rich narratives. */}
				<style>{proseScaleRule}</style>
				{/* Error banner - shown above content so old notes remain readable */}
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
					viewMode === 'rich' ? (
						<RichOverview
							theme={theme}
							stats={stats}
							synopsis={synopsis}
							narrative={narrative}
							narrativeError={narrativeError}
							lookbackDays={lookbackDays}
							enableBionifyReadingMode={bionifyReadingMode}
							chatMath
						/>
					) : (
						// Content-driven AI output: opt back into text selection under
						// the modal's select-none (see CLAUDE.md modal text rules).
						<div className="director-notes-content select-text">
							<style>{proseStyles}</style>
							<MarkdownRenderer
								content={plainContent}
								theme={theme}
								onCopy={(text) => safeClipboardWrite(text)}
								enableBionifyReadingMode={bionifyReadingMode}
								chatMath
							/>
						</div>
					)
				) : isGenerating ? (
					<div className="flex items-center justify-center h-full">
						<div className="flex items-center gap-3">
							<Spinner size={24} color={theme.colors.accent} />
							<p className="text-sm" style={{ color: theme.colors.textDim }}>
								Generating…
							</p>
						</div>
					</div>
				) : null}
			</div>

			{/* Save Modal */}
			{showSaveModal && (
				<SaveMarkdownModal
					theme={theme}
					content={plainContent}
					onClose={() => setShowSaveModal(false)}
					defaultFolder=""
				/>
			)}
		</div>
	);
}
