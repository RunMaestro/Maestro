import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
	X,
	RotateCcw,
	Play,
	Variable,
	ChevronDown,
	ChevronRight,
	Save,
	FolderOpen,
	Bookmark,
	Maximize2,
	Download,
	Upload,
	LayoutGrid,
	Brain,
	PlayCircle,
	HelpCircle,
	Target,
} from 'lucide-react';
import { Spinner } from './ui/Spinner';
import type {
	Theme,
	BatchDocumentEntry,
	BatchRunConfig,
	TaskSelectionMode,
	WorktreeRunTarget,
} from '../types';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { useResizableModal } from '../hooks/ui/useResizableModal';
import { useBracketTabCycle } from '../hooks/utils/useBracketTabCycle';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { TEMPLATE_VARIABLES } from '../utils/templateVariables';
import { PlaybookDeleteConfirmModal } from './PlaybookDeleteConfirmModal';
import { PlaybookNameModal } from './PlaybookNameModal';
import { AgentPromptComposerModal } from './AgentPromptComposerModal';
import { DocumentsPanel } from './DocumentsPanel';
import { GoalConfigPanel } from './GoalConfigPanel';
import { ToggleButtonGroup } from './ToggleButtonGroup';
import { WorktreeRunSection } from './WorktreeRunSection';
import { AutoRunnerHelpModal } from './AutoRun/AutoRunnerHelpModal';
import { useSessionStore, selectSessionById, updateSessionWith } from '../stores/sessionStore';
import { useDebouncedCallback } from '../hooks/utils/useThrottle';
import { useBatchStore } from '../stores/batchStore';
import { useUIStore } from '../stores/uiStore';
import { getModalActions } from '../stores/modalStore';
import {
	usePlaybookManagement,
	DEFAULT_BATCH_PROMPT,
	validateAgentPromptHasTaskReference,
} from '../hooks';
import { generateId } from '../utils/ids';
import { formatMetaKey } from '../utils/shortcutFormatter';
import { logger } from '../utils/logger';
import { resolveEffectiveContextWindow } from '../utils/contextWindowResolver';
import { getModelContextWindowOverride } from '../../shared/agentConstants';
import { formatTokens } from '../../shared/formatters';
import { ResizeHandles } from './ui/ResizeHandles';

// Re-export for external consumers
export { DEFAULT_BATCH_PROMPT, validateAgentPromptHasTaskReference } from '../hooks';

// Tasks-per-document threshold that flips the recommendation between
// Document mode (below the threshold — share context) and Task mode
// (at/above — fresh context per task). Scales linearly with the agent's
// resolved context window so wider windows can absorb more tasks before
// the recommendation tips over. Reference anchors: 256K → 5, 512K → 10,
// 1M → 20. Floors at 5 so tiny windows still get a sensible default.
function computeTasksPerDocThreshold(contextWindow: number): number {
	if (!contextWindow || contextWindow <= 0) return 5;
	return Math.max(5, Math.round((contextWindow / 256_000) * 5));
}

interface BatchRunnerModalProps {
	theme: Theme;
	onClose: () => void;
	onGo: (config: BatchRunConfig) => void | Promise<void>;
	onSave: (prompt: string) => void;
	initialPrompt?: string;
	initialConfig?: Partial<BatchRunConfig>;
	lastModifiedAt?: number;
	showConfirmation: (message: string, onConfirm: () => void) => void;
	// Multi-document support
	folderPath: string;
	/**
	 * Optional pre-seeded list of documents (without `.md`) to populate the run
	 * list with on first mount. When omitted, the run list starts empty. Used by
	 * the inline wizard's "Start Auto Run" button to launch the modal with every
	 * freshly generated doc already selected.
	 */
	presetDocuments?: string[];
	allDocuments: string[]; // All available docs in folder (without .md)
	documentTree?: Array<{
		name: string;
		type: 'file' | 'folder';
		path: string;
		children?: unknown[];
	}>; // Tree structure for folder selection
	getDocumentTaskCount: (filename: string) => Promise<number>; // Get task count for a document
	onRefreshDocuments: () => Promise<void>; // Refresh document list from folder
	// Session ID for playbook storage
	sessionId: string;
	// Callback to open the Playbook Exchange modal
	onOpenMarketplace?: () => void;
}

// Helper function to format the last modified date
function formatLastModified(timestamp: number): string {
	const date = new Date(timestamp);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

	if (diffDays === 0) {
		return `today at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
	} else if (diffDays === 1) {
		return `yesterday at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
	} else if (diffDays < 7) {
		return `${diffDays} days ago`;
	} else {
		return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
	}
}

// The two top-level Auto Run kinds, in the order shown in the tab toggle.
// Cmd+Shift+[ / Cmd+Shift+] cycle between them (see useBracketTabCycle below).
const AUTO_RUN_MODES: readonly ('spec' | 'goal')[] = ['spec', 'goal'];

export function BatchRunnerModal(props: BatchRunnerModalProps) {
	const {
		theme,
		onClose,
		onGo,
		onSave,
		initialPrompt,
		initialConfig,
		lastModifiedAt,
		showConfirmation,
		folderPath,
		presetDocuments,
		allDocuments,
		documentTree,
		getDocumentTaskCount,
		onRefreshDocuments,
		sessionId,
		onOpenMarketplace,
	} = props;

	// Auto-follow state (read/write directly from store to avoid stale local copy)
	const autoFollowEnabled = useUIStore((s) => s.autoFollowEnabled);
	const setAutoFollowEnabled = useUIStore((s) => s.setAutoFollowEnabled);

	// Worktree run target state
	const [worktreeTarget, setWorktreeTarget] = useState<WorktreeRunTarget | null>(null);
	const [isPreparingWorktree, setIsPreparingWorktree] = useState(false);
	const activeSession = useSessionStore(selectSessionById(sessionId));
	const sessions = useSessionStore((state) => state.sessions);
	// When the current session is a worktree child, worktree config lives on its parent.
	// Resolve the parent so the WorktreeRunSection can read basePath and list siblings.
	const worktreeParentSession = useMemo(() => {
		if (!activeSession) return null;
		if (activeSession.parentSessionId) {
			return sessions.find((s) => s.id === activeSession.parentSessionId) ?? activeSession;
		}
		return activeSession;
	}, [activeSession, sessions]);
	const worktreeChildren = useMemo(
		() =>
			worktreeParentSession
				? sessions.filter(
						(s) => s.parentSessionId === worktreeParentSession.id && s.id !== sessionId
					)
				: [],
		[sessions, worktreeParentSession, sessionId]
	);

	const handleOpenWorktreeConfig = useCallback(() => {
		// Open worktree config on top of the batch runner (WORKTREE_CONFIG priority 752 > BATCH_RUNNER 720).
		// The batch runner stays open underneath so the user returns to it after configuring.
		getModalActions().setWorktreeConfigModalOpen(true);
	}, []);

	// Document list state. Opens empty unless the inline wizard's "Start Auto
	// Run" pre-seeded it with freshly generated docs via `presetDocuments`.
	const [documents, setDocuments] = useState<BatchDocumentEntry[]>(() => {
		if (initialConfig?.documents?.length) {
			return initialConfig.documents;
		}
		if (presetDocuments && presetDocuments.length > 0) {
			return presetDocuments.map((filename) => ({
				id: generateId(),
				filename,
				resetOnCompletion: false,
				isDuplicate: false,
			}));
		}
		return [];
	});

	// Track initial document state for dirty checking. Mirrors the run-list
	// initialization above so dirty detection is correct for preset opens too.
	const initialDocumentsRef = useRef<string[]>(
		initialConfig?.documents?.map((doc) => doc.filename) ??
			(presetDocuments && presetDocuments.length > 0 ? [...presetDocuments] : [])
	);

	// Task counts per document (keyed by filename, value = unchecked task count).
	// Seeded synchronously from the batch store, which is already populated by
	// useAutoRunDocumentLoader. This avoids redundant per-document SSH `cat`
	// reads in the modal — critical for SSH-remote sessions where the modal
	// otherwise stays stuck on "..." while sequential SSH reads pile up.
	const documentTaskCountsFromStore = useBatchStore((s) => s.documentTaskCounts);
	const isLoadingDocumentsFromStore = useBatchStore((s) => s.isLoadingDocuments);
	const seededTaskCounts = useMemo(() => {
		const out: Record<string, number> = {};
		documentTaskCountsFromStore.forEach((entry, filename) => {
			out[filename] = Math.max(0, entry.total - entry.completed);
		});
		return out;
	}, [documentTaskCountsFromStore]);
	const [taskCounts, setTaskCounts] = useState<Record<string, number>>(seededTaskCounts);
	const [loadingTaskCounts, setLoadingTaskCounts] = useState(
		// Only show the loading badge if the store hasn't surfaced any counts yet
		// AND it's still loading — otherwise we have stale-but-usable data to render.
		() => isLoadingDocumentsFromStore && Object.keys(seededTaskCounts).length === 0
	);

	// Loop mode state
	const [loopEnabled, setLoopEnabled] = useState(initialConfig?.loopEnabled || false);
	const [maxLoops, setMaxLoops] = useState<number | null>(initialConfig?.maxLoops ?? null); // null = infinite

	// Track initial loop settings for dirty checking
	const initialLoopEnabledRef = useRef(initialConfig?.loopEnabled || false);
	const initialMaxLoopsRef = useRef<number | null>(initialConfig?.maxLoops ?? null);

	// Fresh-context-per mode. Default 'task' preserves legacy behavior (one
	// agent invocation per unchecked task). 'document' makes the agent walk
	// every task in a single invocation, sharing context across them.
	const [taskSelectionMode, setTaskSelectionMode] = useState<TaskSelectionMode>('task');
	const initialTaskSelectionModeRef = useRef<TaskSelectionMode>('task');
	// Set true when the user explicitly clicks the toggle. Sticky: once the
	// user has expressed a preference we stop auto-applying recommendations and
	// instead surface a warning if the recommendation disagrees.
	const [userOverrodeMode, setUserOverrodeMode] = useState(false);
	// Resolved context window for the active agent. Drives the tasks/doc
	// threshold that recommendedMode uses. Null until the resolver finishes
	// (or there's no active session) — recommendations wait for it.
	const [effectiveContextWindow, setEffectiveContextWindow] = useState<number | null>(null);

	// Goal-Driven mode state. Seeded once from the session's persisted goal config
	// (see Session.autoRunDriveMode / autoRunGoalConfig) so reopening the modal
	// restores the tab and the goal inputs. Spec mode is the default.
	const [autoRunMode, setAutoRunMode] = useState<'spec' | 'goal'>(
		() => activeSession?.autoRunDriveMode ?? 'spec'
	);
	const [goal, setGoal] = useState(() => activeSession?.autoRunGoalConfig?.goal ?? '');
	const [exitCriteria, setExitCriteria] = useState(
		() => activeSession?.autoRunGoalConfig?.exitCriteria ?? ''
	);
	const [maxIterations, setMaxIterations] = useState<number | null>(
		() => activeSession?.autoRunGoalConfig?.maxIterations ?? null
	);

	// Auto Run help guide overlay (same content as the Auto Run panel's Help
	// button). Renders above this modal; closing it returns here.
	const [showHelp, setShowHelp] = useState(false);

	// Prompt state
	const resolvedInitialPrompt = initialConfig?.prompt || initialPrompt || DEFAULT_BATCH_PROMPT;
	const [prompt, setPrompt] = useState(resolvedInitialPrompt);
	const [variablesExpanded, setVariablesExpanded] = useState(false);
	const [savedPrompt, setSavedPrompt] = useState(initialConfig?.prompt || initialPrompt || '');
	const [promptComposerOpen, setPromptComposerOpen] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Track initial prompt for dirty checking
	const initialPromptRef = useRef(resolvedInitialPrompt);

	// Persist the goal config + selected Auto Run tab back onto the session so the
	// modal reopens in the same mode with the same inputs. Uses the canonical
	// updateSessionWith helper (NOT a hand-rolled setSessions map). Debounced so
	// typing into the goal/exit fields doesn't thrash the session store.
	const { debouncedCallback: debouncedPersistGoalConfig, flush: flushGoalConfig } =
		useDebouncedCallback(() => {
			updateSessionWith(sessionId, (s) => ({
				...s,
				autoRunDriveMode: autoRunMode,
				autoRunGoalConfig: { goal, exitCriteria, maxIterations },
			}));
		}, 500);

	// Save shortly after the user stops editing or switches tabs. Skip the very
	// first run so seeding from the session doesn't immediately write the same
	// values straight back.
	const didSeedGoalConfigRef = useRef(false);
	useEffect(() => {
		if (!didSeedGoalConfigRef.current) {
			didSeedGoalConfigRef.current = true;
			return;
		}
		debouncedPersistGoalConfig();
	}, [autoRunMode, goal, exitCriteria, maxIterations, debouncedPersistGoalConfig]);

	// Compute if there are unsaved configuration changes
	// This checks if documents, loop settings, or prompt have changed from initial values
	const hasUnsavedConfigChanges = useCallback(() => {
		// Check if documents have changed (compare filenames)
		const currentDocFilenames = documents.map((d) => d.filename).sort();
		const initialDocFilenames = [...initialDocumentsRef.current].sort();
		const documentsChanged =
			currentDocFilenames.length !== initialDocFilenames.length ||
			currentDocFilenames.some((f, i) => f !== initialDocFilenames[i]);

		// Check if loop settings have changed
		const loopChanged =
			loopEnabled !== initialLoopEnabledRef.current || maxLoops !== initialMaxLoopsRef.current;

		// Check if prompt has changed
		const promptChanged = prompt !== initialPromptRef.current;

		// Check if task-selection mode has changed
		const taskSelectionModeChanged = taskSelectionMode !== initialTaskSelectionModeRef.current;

		return documentsChanged || loopChanged || promptChanged || taskSelectionModeChanged;
	}, [documents, loopEnabled, maxLoops, prompt, taskSelectionMode]);

	// Handler for closing with unsaved changes check
	const handleCloseWithConfirmation = useCallback(() => {
		// Persist any pending goal edits before closing so a quick close (before the
		// debounce fires) doesn't drop the user's last keystrokes. Goal config auto-saves,
		// so it isn't part of the spec-mode "unsaved changes" prompt below.
		flushGoalConfig();
		if (hasUnsavedConfigChanges()) {
			showConfirmation(
				'You have unsaved changes to your Auto Run configuration. Close without saving?',
				() => {
					onClose();
				}
			);
		} else {
			onClose();
		}
	}, [flushGoalConfig, hasUnsavedConfigChanges, showConfirmation, onClose]);

	// Playbook management callback to apply loaded playbook configuration
	const handleApplyPlaybook = useCallback(
		(data: {
			documents: BatchDocumentEntry[];
			loopEnabled: boolean;
			maxLoops: number | null;
			prompt: string;
			taskSelectionMode: TaskSelectionMode;
		}) => {
			setDocuments(data.documents);
			setLoopEnabled(data.loopEnabled);
			setMaxLoops(data.maxLoops);
			setPrompt(data.prompt);
			setTaskSelectionMode(data.taskSelectionMode);
		},
		[]
	);

	// Playbook management hook
	const {
		playbooks,
		loadedPlaybook,
		loadingPlaybooks,
		savingPlaybook,
		isPlaybookModified,
		showPlaybookDropdown,
		setShowPlaybookDropdown,
		showSavePlaybookModal,
		setShowSavePlaybookModal,
		showDeleteConfirmModal,
		playbookToDelete,
		playbackDropdownRef,
		handleLoadPlaybook,
		handleDeletePlaybook,
		handleConfirmDeletePlaybook,
		handleCancelDeletePlaybook,
		handleExportPlaybook,
		handleImportPlaybook,
		handleSaveAsPlaybook,
		handleSaveUpdate,
		handleDiscardChanges,
	} = usePlaybookManagement({
		sessionId,
		folderPath,
		allDocuments,
		config: {
			documents,
			loopEnabled,
			maxLoops,
			prompt,
			taskSelectionMode,
		},
		onApplyPlaybook: handleApplyPlaybook,
	});

	// Resolve the active agent's context window the first time the modal opens on
	// a blank config (no loaded playbook). The resolved window drives the
	// task-count recommendation's scaling threshold; the Task/Document choice
	// itself is owned by that recommendation (see the auto-apply effect below),
	// not a raw window-size cutoff.
	const autoModeAppliedRef = useRef(false);
	useEffect(() => {
		if (autoModeAppliedRef.current) return;
		// A playbook supplies its own mode — don't second-guess it.
		if (loadedPlaybook) {
			autoModeAppliedRef.current = true;
			return;
		}
		if (!activeSession) return;

		let active = true;
		(async () => {
			const configured = await resolveEffectiveContextWindow(activeSession);
			// Also honor a window the agent reported at runtime (e.g. Claude's 1M
			// beta) even when the configured value was left at the default.
			const reported = activeSession.aiTabs.reduce(
				(max, tab) => Math.max(max, tab.usageStats?.contextWindow ?? 0),
				0
			);
			// Honor a per-tab `[1m]` model selection before any usage is reported;
			// the resolver already covers session- and agent-level model overrides.
			const tabModelWindow = activeSession.aiTabs.reduce(
				(max, tab) => Math.max(max, getModelContextWindowOverride(tab.customModel) ?? 0),
				0
			);
			const contextWindow = Math.max(configured, reported, tabModelWindow);
			if (!active) return;
			// Expose the resolved window so the task-count recommendation can
			// scale its tasks/doc threshold (5 at 256K → 20 at 1M).
			setEffectiveContextWindow(contextWindow);
			autoModeAppliedRef.current = true;
		})();
		return () => {
			active = false;
		};
	}, [activeSession, loadedPlaybook]);

	// Use ref for getDocumentTaskCount to avoid dependency issues
	const getDocumentTaskCountRef = useRef(getDocumentTaskCount);
	getDocumentTaskCountRef.current = getDocumentTaskCount;

	// Reflect updates from the store (e.g., when a doc's tasks get checked
	// after the modal opened). For docs covered by the store, this is the
	// fast path — no IPC needed.
	useEffect(() => {
		setTaskCounts((prev) => {
			let changed = false;
			const next = { ...prev };
			for (const [filename, count] of Object.entries(seededTaskCounts)) {
				if (next[filename] !== count) {
					next[filename] = count;
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, [seededTaskCounts]);

	// IPC fallback: read counts only for documents NOT already covered by the
	// store. On SSH-remote sessions the store is normally pre-populated by
	// useAutoRunDocumentLoader, so this loop runs zero IPC calls in practice.
	useEffect(() => {
		const missing = allDocuments.filter((doc) => !(doc in seededTaskCounts));
		if (missing.length === 0) {
			setLoadingTaskCounts(false);
			return;
		}

		let cancelled = false;
		const loadMissing = async () => {
			setLoadingTaskCounts(true);
			const additions: Record<string, number> = {};
			for (const doc of missing) {
				if (cancelled) return;
				try {
					additions[doc] = await getDocumentTaskCountRef.current(doc);
				} catch {
					additions[doc] = 0;
				}
			}
			if (cancelled) return;
			setTaskCounts((prev) => ({ ...prev, ...additions }));
			setLoadingTaskCounts(false);
		};

		loadMissing();
		return () => {
			cancelled = true;
		};
	}, [allDocuments, seededTaskCounts]);

	// Calculate total tasks across selected documents (excluding missing documents)
	const totalTaskCount = documents.reduce((sum, doc) => {
		// Don't count tasks from missing documents
		if (doc.isMissing) return sum;
		return sum + (taskCounts[doc.filename] || 0);
	}, 0);
	const hasNoTasks = totalTaskCount === 0;

	// Count missing documents for warning display
	const missingDocCount = documents.filter((doc) => doc.isMissing).length;

	// Recommend a fresh-context mode based on average tasks per selected doc,
	// using a threshold that scales with the agent's resolved context window.
	// Small docs benefit from a shared agent across tasks (less spawn overhead,
	// no repeated context priming); large docs do better with a fresh context
	// per task so tool output from earlier tasks doesn't crowd later ones.
	const tasksPerDocThreshold = useMemo(
		() =>
			effectiveContextWindow === null ? null : computeTasksPerDocThreshold(effectiveContextWindow),
		[effectiveContextWindow]
	);
	const recommendation = useMemo<{
		mode: TaskSelectionMode;
		averageTasks: number;
		docCount: number;
		threshold: number;
	} | null>(() => {
		// Wait for the context window resolver — its value drives the threshold.
		if (tasksPerDocThreshold === null) return null;
		const validDocs = documents.filter((d) => !d.isMissing);
		if (validDocs.length === 0) return null;
		// Wait until at least one selected doc has a task count loaded —
		// recommending against zeros would lock us into 'document' on first paint.
		const knownCounts = validDocs
			.map((d) => taskCounts[d.filename])
			.filter((n): n is number => typeof n === 'number');
		if (knownCounts.length === 0) return null;
		const averageTasks = knownCounts.reduce((a, b) => a + b, 0) / knownCounts.length;
		return {
			mode: averageTasks < tasksPerDocThreshold ? 'document' : 'task',
			averageTasks,
			docCount: validDocs.length,
			threshold: tasksPerDocThreshold,
		};
	}, [documents, taskCounts, tasksPerDocThreshold]);
	const recommendedMode = recommendation?.mode ?? null;

	// Auto-apply the task-count recommendation when documents/counts change.
	// Skips if a playbook is loaded (it owns the mode) or the user has
	// manually overridden — once they've picked, we respect it and warn
	// instead of fighting them.
	useEffect(() => {
		if (userOverrodeMode) return;
		if (loadedPlaybook) return;
		if (recommendedMode === null) return;
		if (recommendedMode === taskSelectionMode) return;
		setTaskSelectionMode(recommendedMode);
		// Keep the dirty check honest: an automatic mode shift shouldn't
		// mark the form as having unsaved changes.
		initialTaskSelectionModeRef.current = recommendedMode;
	}, [recommendedMode, loadedPlaybook, userOverrodeMode, taskSelectionMode]);

	// Wrapped setter for the toggle: any manual click flips the override flag
	// so future doc-selection changes don't yank the mode back.
	const handleTaskSelectionModeChange = useCallback((mode: TaskSelectionMode) => {
		setUserOverrodeMode(true);
		setTaskSelectionMode(mode);
	}, []);

	const showRecommendationWarning =
		userOverrodeMode && recommendedMode !== null && recommendedMode !== taskSelectionMode;

	// Noun for the "sent to the AI agent for each ___ in the queue" helper text.
	// `taskSelectionMode` always holds a concrete value ('task' default), but a
	// real selection only exists once the user clicks the toggle OR the
	// auto-recommendation resolves from actual doc/task counts. Until then the
	// value is just the un-vetted default, so show the combined "task/document".
	const hasSelectedMode = userOverrodeMode || recommendedMode !== null;
	const queueItemNoun = !hasSelectedMode
		? 'task/document'
		: taskSelectionMode === 'document'
			? 'document'
			: 'task';

	// Human-readable explanation of the dynamic mode choice: average task count
	// across selected docs + the resolved context window + the threshold that
	// scales with it. Drives the copy shown above the Task/Document toggle.
	const recommendationExplanation = useMemo<string | null>(() => {
		if (recommendation === null || effectiveContextWindow === null) return null;
		const { averageTasks, docCount, threshold, mode } = recommendation;
		const avgLabel = Number.isInteger(averageTasks) ? `${averageTasks}` : averageTasks.toFixed(1);
		const docLabel = docCount === 1 ? '1 document' : `${docCount} documents`;
		const taskLabel = avgLabel === '1' ? '1 task' : `${avgLabel} tasks`;
		const windowLabel = formatTokens(effectiveContextWindow);
		const recommendedLabel = mode === 'task' ? 'Task' : 'Document';
		const reason =
			mode === 'task'
				? `that's at or above the ${threshold}-task cutoff for a ${windowLabel} context window, so a clean context per task avoids crowding the window`
				: `that's under the ${threshold}-task cutoff for a ${windowLabel} context window, so one shared session can hold the whole document`;
		if (showRecommendationWarning) {
			const currentLabel = taskSelectionMode === 'task' ? 'Task' : 'Document';
			return `Heads up: your ${docLabel} average ${taskLabel} each; ${reason}, so ${recommendedLabel} is the better fit. You've chosen ${currentLabel} - if you know what you're doing, go for it.`;
		}
		return `Your ${docLabel} average ${taskLabel} each - ${reason}. Defaulted to ${recommendedLabel}.`;
	}, [recommendation, effectiveContextWindow, showRecommendationWarning, taskSelectionMode]);

	// Validate agent prompt has task references
	const hasValidPrompt = validateAgentPromptHasTaskReference(prompt);
	const isPromptEmpty = !prompt || !prompt.trim();

	// Goal mode is launch-ready as soon as a non-empty goal is entered. The
	// document/prompt gates below are meaningless without documents, so goal mode
	// uses this single check instead.
	const isGoalEmpty = !goal.trim();
	const goalMode = autoRunMode === 'goal';

	// Block launch (but not configuration) while the agent for this session is mid-thought.
	const isAgentBusy = activeSession?.state === 'busy' || activeSession?.state === 'connecting';

	// One Auto Run per agent at a time. If this session already has an active
	// batch (spec OR goal driven), block launching another regardless of the
	// mode the user is currently looking at. errorPaused runs still occupy the
	// agent, so a paused run blocks a fresh launch too.
	const isBatchRunningForSession = useBatchStore(
		useCallback((s) => !!s.batchRunStates[sessionId]?.isRunning, [sessionId])
	);

	// Dispatching to a separate worktree spawns/uses a different agent, so the current
	// session being busy is irrelevant — let the user launch regardless. (Busy open-worktree
	// targets are already disabled in the WorktreeRunSection dropdown.)
	const blocksLaunchWhileBusy = isAgentBusy && worktreeTarget === null;

	// Whether the Go button should be disabled, branching on the active mode.
	const isGoDisabled =
		isPreparingWorktree ||
		blocksLaunchWhileBusy ||
		isBatchRunningForSession ||
		(goalMode
			? isGoalEmpty
			: hasNoTasks ||
				documents.length === 0 ||
				documents.length === missingDocCount ||
				isPromptEmpty ||
				!hasValidPrompt);

	useModalLayer(MODAL_PRIORITIES.BATCH_RUNNER, undefined, () => {
		if (showDeleteConfirmModal) {
			handleCancelDeletePlaybook();
		} else if (showSavePlaybookModal) {
			setShowSavePlaybookModal(false);
		} else {
			handleCloseWithConfirmation();
		}
	});

	// Cmd+Shift+[ / Cmd+Shift+] cycle between the Spec-Driven and Goal-Driven
	// tabs. Suppressed while a nested overlay is up (help, prompt composer, or a
	// playbook save/delete dialog) so the shortcut doesn't shift the tab behind them.
	useBracketTabCycle<'spec' | 'goal'>({
		enabled: !showHelp && !promptComposerOpen && !showSavePlaybookModal && !showDeleteConfirmModal,
		values: AUTO_RUN_MODES,
		active: autoRunMode,
		onChange: setAutoRunMode,
	});

	// Focus textarea on mount
	useEffect(() => {
		setTimeout(() => textareaRef.current?.focus(), 100);
	}, []);

	const handleReset = () => {
		showConfirmation('Reset the prompt to the default? Your customizations will be lost.', () => {
			setPrompt(DEFAULT_BATCH_PROMPT);
		});
	};

	const handleSave = () => {
		onSave(prompt);
		setSavedPrompt(prompt);
		// Update initial ref so hasUnsavedConfigChanges doesn't flag a saved prompt as dirty
		initialPromptRef.current = prompt;
	};

	const handleGo = async () => {
		// Also save when running
		onSave(prompt);

		// Persist the latest goal config immediately on launch (flush any pending
		// debounced save) so the session reflects exactly what was run.
		flushGoalConfig();

		// Filter out missing documents before starting batch run
		const validDocuments = documents.filter((doc) => !doc.isMissing);

		// Build config (worktree configuration is now managed separately via WorktreeConfigModal).
		// The presence of `goalConfig` is the discriminator the engine uses to route to the
		// goal runner; in goal mode there are no documents and no loop/task-selection semantics.
		const config: BatchRunConfig =
			autoRunMode === 'goal'
				? {
						documents: [],
						prompt,
						loopEnabled: false,
						maxLoops: null,
						goalConfig: { goal: goal.trim(), exitCriteria: exitCriteria.trim(), maxIterations },
						...(worktreeTarget && { worktreeTarget }),
					}
				: {
						documents: validDocuments,
						prompt,
						loopEnabled,
						maxLoops: loopEnabled ? maxLoops : null,
						taskSelectionMode,
						...(worktreeTarget && { worktreeTarget }),
					};

		logger.info('[BatchRunnerModal] handleGo - calling onGo with config:', undefined, config);
		window.maestro.logger.log('info', 'Go button clicked', 'BatchRunnerModal', {
			documentsCount: validDocuments.length,
			autoRunMode,
		});

		// Worktree creation/opening requires async work — show loading state
		const needsWorktreePrep =
			worktreeTarget?.mode === 'create-new' || worktreeTarget?.mode === 'existing-closed';

		if (needsWorktreePrep) {
			setIsPreparingWorktree(true);
			try {
				await onGo(config);
				onClose();
			} catch {
				// Keep modal open so the user can adjust config and retry
			} finally {
				setIsPreparingWorktree(false);
			}
		} else {
			onGo(config);
			onClose();
		}
	};

	const isModified = prompt !== DEFAULT_BATCH_PROMPT;
	const hasUnsavedChanges = prompt !== savedPrompt && prompt !== DEFAULT_BATCH_PROMPT;
	const resizableModal = useResizableModal({
		resizeKey: 'batch-runner',
		defaultSize: { width: 720, height: 720 },
		minSize: { width: 560, height: 440 },
	});

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center z-[9999] animate-in fade-in duration-200"
			role="dialog"
			aria-modal="true"
			aria-label="Maestro Auto Run"
			tabIndex={-1}
		>
			<div
				ref={resizableModal.modalRef}
				className="relative border rounded-lg shadow-2xl overflow-hidden flex flex-col select-none"
				style={{
					...resizableModal.style,
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
				data-modal-resize-key="batch-runner"
			>
				<ResizeHandles
					onResizeStart={resizableModal.onResizeStart}
					accentColor={theme.colors.accent}
				/>

				{/* Header */}
				<div
					className="p-4 border-b flex items-center justify-between shrink-0"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-2">
						<PlayCircle className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
							Maestro Auto Run
						</h2>
						<button
							onClick={() => setShowHelp(true)}
							className="p-1 rounded hover:bg-white/10 transition-colors"
							aria-label="Open help"
							title="About Maestro Auto Run"
							style={{ color: theme.colors.textDim }}
						>
							<HelpCircle className="w-4 h-4" />
						</button>
					</div>
					<div className="flex items-center gap-4">
						{/* Auto Run active pill - shown when this agent already has a run in
						    flight, explaining why Go is disabled in both modes. */}
						{isBatchRunningForSession && (
							<div
								className="flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold whitespace-nowrap"
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.bgMain,
									border: `1px solid ${theme.colors.accent}`,
								}}
								title="An Auto Run is already active for this agent"
							>
								<Play className="w-2.5 h-2.5" />
								<span>Auto Run active</span>
							</div>
						)}
						{/* Agent thinking pill — shown only while the session agent is busy.
						    Lives in the header (rather than over the Go button) so it stays
						    visible without forcing the modal footer to grow. */}
						{isAgentBusy && !isBatchRunningForSession && (
							<div
								className="flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold whitespace-nowrap"
								style={{
									backgroundColor: theme.colors.warning,
									color: theme.colors.bgMain,
									border: `1px solid ${theme.colors.warning}`,
								}}
							>
								<Brain className="w-2.5 h-2.5 animate-pulse" />
								<span>Agent thinking</span>
							</div>
						)}
						{/* Goal mode shows a small pill instead of the task count (which is
						    meaningless without documents); spec mode shows the task total. */}
						{goalMode ? (
							<div
								className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg"
								style={{
									backgroundColor: theme.colors.accent + '20',
									border: `1px solid ${theme.colors.accent}40`,
								}}
							>
								<Target className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
								<span className="text-xs font-medium" style={{ color: theme.colors.accent }}>
									Goal-Driven
								</span>
							</div>
						) : (
							/* Total Task Count Badge */
							<div
								className="flex items-center gap-2 px-3 py-1.5 rounded-lg"
								style={{
									backgroundColor: hasNoTasks
										? theme.colors.error + '20'
										: theme.colors.success + '20',
									border: `1px solid ${hasNoTasks ? theme.colors.error + '40' : theme.colors.success + '40'}`,
								}}
							>
								<span
									className="text-lg font-bold"
									style={{ color: hasNoTasks ? theme.colors.error : theme.colors.success }}
								>
									{loadingTaskCounts ? '...' : totalTaskCount}
								</span>
								<span
									className="text-xs font-medium"
									style={{ color: hasNoTasks ? theme.colors.error : theme.colors.success }}
								>
									{totalTaskCount === 1 ? 'task' : 'tasks'}
								</span>
							</div>
						)}
						<button
							onClick={handleCloseWithConfirmation}
							aria-label="Close"
							style={{ color: theme.colors.textDim }}
						>
							<X className="w-4 h-4" />
						</button>
					</div>
				</div>

				{/* Content */}
				<div className="flex-1 overflow-y-auto p-6">
					{/* Spec-Driven / Goal-Driven tabs — the top-level choice for how this
					    Auto Run is driven. Everything below adapts to the selection. */}
					<div className="mb-6">
						<p className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
							Spec-Driven runs your checklist documents to completion. Goal-Driven pursues an
							open-ended goal until the agent reports it's done.
						</p>
						<ToggleButtonGroup<'spec' | 'goal'>
							options={[
								{ value: 'spec', label: 'Spec-Driven' },
								{ value: 'goal', label: 'Goal-Driven' },
							]}
							value={autoRunMode}
							onChange={setAutoRunMode}
							theme={theme}
						/>
					</div>

					{/* Playbook Section — Spec-Driven only; playbooks are checklist
					    documents, which have no meaning in Goal-Driven mode. */}
					{!goalMode && (
						<div className="mb-6 flex items-center justify-between">
							{/* Left side: Load Playbook and Playbook Exchange buttons */}
							<div className="flex items-center gap-2">
								{/* Load Playbook Dropdown - only show when playbooks exist or one is loaded */}
								{(playbooks.length > 0 || loadedPlaybook) && (
									<div className="relative" ref={playbackDropdownRef}>
										<button
											onClick={() => setShowPlaybookDropdown(!showPlaybookDropdown)}
											className="flex items-center gap-2 px-3 py-1.5 rounded-lg border hover:bg-white/5 transition-colors"
											style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
											disabled={loadingPlaybooks}
										>
											<FolderOpen className="w-4 h-4" style={{ color: theme.colors.accent }} />
											<span className="text-sm">
												{loadedPlaybook ? loadedPlaybook.name : 'Load Playbook'}
											</span>
											<ChevronDown
												className="w-3.5 h-3.5"
												style={{ color: theme.colors.textDim }}
											/>
										</button>

										{/* Dropdown Menu */}
										{showPlaybookDropdown && (
											<div
												className="absolute top-full left-0 mt-1 min-w-64 max-w-[calc(700px-48px)] w-max rounded-lg border shadow-lg z-10 overflow-hidden"
												style={{
													backgroundColor: theme.colors.bgSidebar,
													borderColor: theme.colors.border,
												}}
											>
												<div className="max-h-48 overflow-y-auto">
													{playbooks.map((pb) => (
														<div
															key={pb.id}
															className={`flex items-center gap-2 px-3 py-2 hover:bg-white/5 cursor-pointer transition-colors ${
																loadedPlaybook?.id === pb.id ? 'bg-white/10' : ''
															}`}
															onClick={() => handleLoadPlaybook(pb)}
														>
															<span
																className="flex-1 text-sm"
																style={{ color: theme.colors.textMain }}
															>
																{pb.name}
															</span>
															<span
																className="text-[10px] shrink-0"
																style={{ color: theme.colors.textDim }}
															>
																{pb.documents.length} doc{pb.documents.length !== 1 ? 's' : ''}
															</span>
															<button
																onClick={(e) => {
																	e.stopPropagation();
																	handleExportPlaybook(pb);
																}}
																className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
																style={{ color: theme.colors.textDim }}
																title="Export playbook"
															>
																<Download className="w-3 h-3" />
															</button>
															<button
																onClick={(e) => handleDeletePlaybook(pb, e)}
																className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
																style={{ color: theme.colors.textDim }}
																title="Delete playbook"
															>
																<X className="w-3 h-3" />
															</button>
														</div>
													))}
												</div>
											</div>
										)}
									</div>
								)}

								{/* Import Playbook — always visible so users with zero existing
							    playbooks can still import a .maestro-playbook.zip. Previously
							    lived inside the Load Playbook dropdown, which only renders when
							    at least one playbook exists — making the entry point unreachable
							    on fresh worktrees / first-time users. */}
								<button
									onClick={handleImportPlaybook}
									className="flex items-center gap-2 px-3 py-1.5 rounded-lg border hover:bg-white/5 transition-colors"
									style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
									title="Import a playbook from a .maestro-playbook.zip file"
								>
									<Upload className="w-4 h-4" style={{ color: theme.colors.accent }} />
									<span className="text-sm">Import Playbook</span>
								</button>

								{/* Playbook Exchange button */}
								{onOpenMarketplace && (
									<button
										onClick={onOpenMarketplace}
										className="flex items-center gap-2 px-3 py-1.5 rounded-lg border hover:bg-white/5 transition-colors"
										style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
										title="Browse Playbook Exchange"
									>
										<LayoutGrid className="w-4 h-4" style={{ color: theme.colors.accent }} />
										<span className="text-sm">Playbook Exchange</span>
									</button>
								)}
							</div>

							{/* Right side: Save as Playbook OR Save Update/Discard buttons */}
							<div className="flex items-center gap-2">
								{/* Save as Playbook button - shown when >1 doc and no playbook loaded */}
								{documents.length > 1 && !loadedPlaybook && (
									<button
										onClick={() => setShowSavePlaybookModal(true)}
										className="flex items-center gap-2 px-3 py-1.5 rounded-lg border hover:bg-white/5 transition-colors"
										style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
									>
										<Bookmark className="w-4 h-4" style={{ color: theme.colors.accent }} />
										<span className="text-sm">Save as Playbook</span>
									</button>
								)}

								{/* Save Update, Save as New, and Discard buttons - shown when playbook is loaded and modified */}
								{loadedPlaybook && isPlaybookModified && (
									<>
										<button
											onClick={handleDiscardChanges}
											className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border hover:bg-white/5 transition-colors"
											style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
											title="Discard changes and reload original playbook configuration"
										>
											<RotateCcw className="w-3.5 h-3.5" />
											<span className="text-sm">Discard</span>
										</button>
										<button
											onClick={() => setShowSavePlaybookModal(true)}
											disabled={savingPlaybook}
											className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
											style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
											title="Save as a new playbook with a different name"
										>
											<Bookmark className="w-3.5 h-3.5" />
											<span className="text-sm">Save as New</span>
										</button>
										<button
											onClick={handleSaveUpdate}
											disabled={savingPlaybook}
											className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
											style={{ borderColor: theme.colors.accent, color: theme.colors.accent }}
											title="Save changes to the loaded playbook"
										>
											<Save className="w-3.5 h-3.5" />
											<span className="text-sm">
												{savingPlaybook ? 'Saving...' : 'Save Update'}
											</span>
										</button>
									</>
								)}
							</div>
						</div>
					)}

					{/* Documents Section (Spec-Driven) or Goal config (Goal-Driven) */}
					{goalMode ? (
						<GoalConfigPanel
							theme={theme}
							goal={goal}
							exitCriteria={exitCriteria}
							maxIterations={maxIterations}
							onGoalChange={setGoal}
							onExitCriteriaChange={setExitCriteria}
							onMaxIterationsChange={setMaxIterations}
						/>
					) : (
						<DocumentsPanel
							theme={theme}
							documents={documents}
							setDocuments={setDocuments}
							taskCounts={taskCounts}
							loadingTaskCounts={loadingTaskCounts}
							loopEnabled={loopEnabled}
							setLoopEnabled={setLoopEnabled}
							maxLoops={maxLoops}
							setMaxLoops={setMaxLoops}
							allDocuments={allDocuments}
							documentTree={documentTree as import('./DocumentsPanel').DocTreeNode[] | undefined}
							onRefreshDocuments={onRefreshDocuments}
						/>
					)}

					{/* Run in Worktree Section — hidden for non-git repos since worktrees require git */}
					{worktreeParentSession?.isGitRepo && (
						<WorktreeRunSection
							theme={theme}
							activeSession={worktreeParentSession}
							worktreeChildren={worktreeChildren}
							worktreeTarget={worktreeTarget}
							onWorktreeTargetChange={setWorktreeTarget}
							onOpenWorktreeConfig={handleOpenWorktreeConfig}
						/>
					)}

					{/* Spec-Driven config: Fresh-context selector + Agent Prompt. Hidden in
					    goal mode, where the agent prompt is built internally by the goal
					    runner and "Fresh context per" has no meaning without documents. */}
					{!goalMode && (
						<div className="flex flex-col gap-2">
							{/* Fresh-context-per selector - drives {{TASK_SELECTION_BLOCK}}.
							    Hidden until at least one document is selected; the mode is then
							    auto-chosen from the docs' task counts and the agent context window. */}
							{documents.length > 0 && (
								<div className="mb-2">
									<div
										className="text-[10px] font-bold uppercase mb-1.5"
										style={{ color: theme.colors.textDim }}
									>
										Fresh context per:
									</div>
									{recommendationExplanation && (
										<p
											className="text-[10px] mb-1.5"
											style={{
												color: showRecommendationWarning
													? theme.colors.warning
													: theme.colors.textDim,
											}}
										>
											{recommendationExplanation}
										</p>
									)}
									<ToggleButtonGroup<TaskSelectionMode>
										options={[
											{ value: 'task', label: 'Task' },
											{ value: 'document', label: 'Document' },
										]}
										value={taskSelectionMode}
										onChange={handleTaskSelectionModeChange}
										theme={theme}
									/>
									<p className="text-[10px] mt-1.5" style={{ color: theme.colors.textDim }}>
										{taskSelectionMode === 'task'
											? 'A new agent session is spawned for each unchecked task, clean context per work in the document.'
											: 'A new agent session is spawned for each document, processing all tasks together.'}
									</p>
								</div>
							)}

							<div className="flex items-center justify-between">
								<div className="flex items-center gap-3">
									<label
										className="text-xs font-bold uppercase"
										style={{ color: theme.colors.textDim }}
									>
										Agent Prompt
									</label>
									{isModified && (
										<span
											className="text-[10px] px-2 py-0.5 rounded-full"
											style={{
												backgroundColor: theme.colors.accent + '20',
												color: theme.colors.accent,
											}}
										>
											CUSTOMIZED
										</span>
									)}
								</div>
								<button
									onClick={handleReset}
									disabled={!isModified}
									className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
									style={{ color: theme.colors.textDim }}
									title="Reset to default prompt"
								>
									<RotateCcw className="w-3 h-3" />
									Reset
								</button>
							</div>
							<div className="text-[10px] mb-2" style={{ color: theme.colors.textDim }}>
								This prompt is sent to the AI agent for each {queueItemNoun} in the queue.{' '}
								{isModified && lastModifiedAt && (
									<span style={{ color: theme.colors.textMain }}>
										Last modified {formatLastModified(lastModifiedAt)}.
									</span>
								)}
							</div>

							{/* Template Variables Documentation */}
							<div
								className="rounded-lg border overflow-hidden mb-2"
								style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
							>
								<button
									onClick={() => setVariablesExpanded(!variablesExpanded)}
									className="w-full px-3 py-2 flex items-center justify-between hover:bg-white/5 transition-colors"
								>
									<div className="flex items-center gap-2">
										<Variable className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
										<span
											className="text-xs font-bold uppercase"
											style={{ color: theme.colors.textDim }}
										>
											Template Variables
										</span>
									</div>
									{variablesExpanded ? (
										<ChevronDown className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
									) : (
										<ChevronRight className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
									)}
								</button>
								{variablesExpanded && (
									<div
										className="px-3 pb-3 pt-1 border-t select-text"
										style={{ borderColor: theme.colors.border }}
									>
										<p className="text-[10px] mb-2" style={{ color: theme.colors.textDim }}>
											Use these variables in your prompt. They will be replaced with actual values
											at runtime.
										</p>
										<div className="grid grid-cols-2 gap-x-4 gap-y-1 max-h-48 overflow-y-auto scrollbar-thin">
											{TEMPLATE_VARIABLES.map(({ variable, description }) => (
												<div key={variable} className="flex items-center gap-2 py-0.5">
													<code
														className="text-[10px] font-mono px-1 py-0.5 rounded shrink-0"
														style={{
															backgroundColor: theme.colors.bgActivity,
															color: theme.colors.accent,
														}}
													>
														{variable}
													</code>
													<span
														className="text-[10px] truncate"
														style={{ color: theme.colors.textDim }}
													>
														{description}
													</span>
												</div>
											))}
										</div>
									</div>
								)}
							</div>
							<div className="relative">
								<textarea
									ref={textareaRef}
									value={prompt}
									onChange={(e) => setPrompt(e.target.value)}
									onKeyDown={(e) => {
										// Insert actual tab character instead of moving focus
										if (e.key === 'Tab') {
											e.preventDefault();
											const textarea = e.currentTarget;
											const start = textarea.selectionStart;
											const end = textarea.selectionEnd;
											const newValue = prompt.substring(0, start) + '\t' + prompt.substring(end);
											setPrompt(newValue);
											// Restore cursor position after the tab
											requestAnimationFrame(() => {
												textarea.selectionStart = start + 1;
												textarea.selectionEnd = start + 1;
											});
										}
									}}
									className="w-full p-4 pr-10 rounded border bg-transparent outline-none resize-none font-mono text-sm"
									style={{
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
										minHeight: '200px',
									}}
									placeholder="Enter the system prompt for auto-run..."
								/>
								<button
									onClick={() => setPromptComposerOpen(true)}
									className="absolute top-2 right-2 p-1.5 rounded hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textDim }}
									title="Expand editor"
								>
									<Maximize2 className="w-4 h-4" />
								</button>
							</div>
							{/* Prompt validation warning */}
							{isPromptEmpty && (
								<div
									className="text-xs px-3 py-2 rounded"
									style={{
										backgroundColor: theme.colors.error + '15',
										color: theme.colors.error,
									}}
								>
									Agent prompt cannot be empty. Reset to default or provide a prompt.
								</div>
							)}
							{!isPromptEmpty && !hasValidPrompt && (
								<div
									className="text-xs px-3 py-2 rounded"
									style={{
										backgroundColor: theme.colors.error + '15',
										color: theme.colors.error,
									}}
								>
									Agent prompt must reference Markdown tasks (e.g., include checkbox syntax like
									&quot;- [ ]&quot; or the phrase &quot;markdown task&quot;).
								</div>
							)}
						</div>
					)}
				</div>

				{/* Footer */}
				<div
					className="p-4 border-t flex items-center justify-between shrink-0"
					style={{ borderColor: theme.colors.border }}
				>
					{/* Left side: Auto-follow toggle + Hint. Both are document-centric
					    (following the active task, drag-to-copy a document) and have no
					    meaning in Goal-Driven mode, so they hide there. The container
					    stays mounted to preserve the footer's justify-between layout. */}
					<div className="flex items-center gap-4">
						{!goalMode && (
							<>
								<label className="flex items-center gap-1.5 cursor-pointer">
									<input
										type="checkbox"
										checked={autoFollowEnabled}
										onChange={(e) => setAutoFollowEnabled(e.target.checked)}
										className="w-3 h-3 rounded cursor-pointer accent-current"
										style={{ accentColor: theme.colors.accent }}
									/>
									<span className="text-xs" style={{ color: theme.colors.textDim }}>
										Follow active task
									</span>
								</label>
								<div
									className="flex items-center gap-2 text-xs"
									style={{ color: theme.colors.textDim }}
								>
									<span
										className="px-1.5 py-0.5 rounded border text-[10px] font-mono"
										style={{
											borderColor: theme.colors.border,
											backgroundColor: theme.colors.bgActivity,
										}}
									>
										{formatMetaKey()} + Drag
									</span>
									<span>to copy document</span>
								</div>
							</>
						)}
					</div>

					{/* Right side: Buttons */}
					<div className="flex items-center gap-2">
						<button
							onClick={handleCloseWithConfirmation}
							className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						>
							Cancel
						</button>
						{/* Save persists the Spec-Driven agent prompt for this session.
						    Goal-Driven has no editable prompt to save, so it's hidden there. */}
						{!goalMode && (
							<button
								onClick={handleSave}
								disabled={!hasUnsavedChanges}
								className="flex items-center gap-2 px-4 py-2 rounded border hover:bg-white/5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
								style={{ borderColor: theme.colors.border, color: theme.colors.success }}
								title={hasUnsavedChanges ? 'Save prompt for this session' : 'No unsaved changes'}
							>
								<Save className="w-4 h-4" />
								Save
							</button>
						)}
						<button
							onClick={handleGo}
							disabled={isGoDisabled}
							className="flex items-center gap-2 px-4 py-2 rounded text-white font-bold disabled:opacity-40 disabled:cursor-not-allowed"
							style={{
								backgroundColor: isGoDisabled ? theme.colors.textDim : theme.colors.accent,
							}}
							title={
								isPreparingWorktree
									? 'Preparing worktree...'
									: isBatchRunningForSession
										? 'An Auto Run is already active for this agent - stop it before launching another'
										: blocksLaunchWhileBusy
											? 'Agent is thinking - finish or interrupt the current task before launching auto-run'
											: goalMode
												? isGoalEmpty
													? 'Enter a goal to launch a Goal-Driven run'
													: 'Start goal-driven auto-run'
												: isPromptEmpty
													? 'Agent prompt cannot be empty'
													: !hasValidPrompt
														? 'Agent prompt must reference Markdown tasks (e.g., checkbox syntax "- [ ]")'
														: documents.length === 0
															? 'No documents selected'
															: documents.length === missingDocCount
																? 'All selected documents are missing'
																: hasNoTasks
																	? 'No unchecked tasks in documents'
																	: 'Start auto-run'
							}
						>
							{isPreparingWorktree ? <Spinner size={16} /> : <Play className="w-4 h-4" />}
							{isPreparingWorktree ? 'Preparing Worktree...' : 'Go'}
						</button>
					</div>
				</div>
			</div>

			{/* Save Playbook Modal */}
			{showSavePlaybookModal && (
				<PlaybookNameModal
					theme={theme}
					onSave={handleSaveAsPlaybook}
					onCancel={() => setShowSavePlaybookModal(false)}
					title="Save as Playbook"
					saveButtonText={savingPlaybook ? 'Saving...' : 'Save'}
				/>
			)}

			{/* Playbook Delete Confirmation Modal */}
			{showDeleteConfirmModal && playbookToDelete && (
				<PlaybookDeleteConfirmModal
					theme={theme}
					playbookName={playbookToDelete.name}
					onConfirm={handleConfirmDeletePlaybook}
					onCancel={handleCancelDeletePlaybook}
				/>
			)}

			{/* Agent Prompt Composer Modal */}
			<AgentPromptComposerModal
				isOpen={promptComposerOpen}
				onClose={() => setPromptComposerOpen(false)}
				theme={theme}
				initialValue={prompt}
				onSubmit={(value) => setPrompt(value)}
			/>

			{/* Auto Run help guide - opened via the (?) in the header. Layered above
			    this modal (z-9999) so it sits on top; closing it (Got it / Escape /
			    backdrop) returns the user to this config modal. */}
			{showHelp && (
				<AutoRunnerHelpModal theme={theme} onClose={() => setShowHelp(false)} zIndex={10000} />
			)}
		</div>
	);
}
