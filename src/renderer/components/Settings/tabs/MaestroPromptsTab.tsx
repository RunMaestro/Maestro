/**
 * Maestro Prompts Tab - Edit core system prompts
 *
 * Settings tab for browsing and editing core prompts.
 * Edits are saved to customizations file AND applied immediately in memory.
 *
 * Layout chrome (split pane, list, editor actions, open-in-finder) is provided by
 * the shared `DualPaneFileEditor`. This component owns the prompt-specific state,
 * template autocomplete, preview mode, and help content.
 *
 * Reading surfaces match the Memory Viewer, deliberately: the same
 * `SegmentedControl` flips between the rendered document and the source, the
 * source is the same CodeMirror `MarkdownEditor` the File Preview edits with,
 * the same `FilterInput` narrows the list, and `toggleMarkdownMode` (Cmd/Ctrl+E)
 * is the same key in both. A prompt is a markdown document like any other, so
 * it should not look or behave like a different kind of thing here.
 *
 * One thing IS prompt-specific: Preview resolves `{{TEMPLATE}}` variables
 * against the active agent before rendering, because what matters about a
 * prompt is what the agent finally receives, not what is on disk.
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { ExternalLink, Maximize2, Minimize2, HelpCircle, X, GitCompare } from 'lucide-react';
import type { Theme } from '../../../constants/themes';
import { refreshRendererPrompts } from '../../../services/promptInit';
import { captureException, captureMessage } from '../../../utils/sentry';
import { openUrl } from '../../../utils/openUrl';
import { buildMaestroUrl } from '../../../utils/buildMaestroUrl';
import { useEditorTemplateAutocomplete } from '../../../hooks/input/useEditorTemplateAutocomplete';
import { TemplateAutocompleteDropdown } from '../../TemplateAutocompleteDropdown';
import { TEMPLATE_VARIABLES, substituteTemplateVariables } from '../../../utils/templateVariables';
import { useActiveSession } from '../../../hooks/session/useActiveSession';
import { useSettingsStore } from '../../../stores/settingsStore';
import { gitService } from '../../../services/git';
import { DualPaneFileEditor, type DualPaneFileEditorItem } from '../../shared/DualPaneFileEditor';
import { FilterInput } from '../../ui/FilterInput';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Markdown } from '../../Markdown';
import { MarkdownEditor, type MarkdownEditorHandle } from '../../FilePreview/markdownEditor';
import { generateProseStyles } from '../../../utils/markdownConfig';
import { searchMatchRanges } from '../../../utils/highlightMatches';
import { useDebouncedValue } from '../../../hooks/utils/useThrottle';
import { useEventListener } from '../../../hooks/utils/useEventListener';
import { eventMatchesShortcutKeys } from '../../../utils/shortcutMatch';
import { isTextInputTarget } from '../../../utils/messageScrollNavigation';
import { PROMPT_IDS } from '../../../../shared/promptDefinitions';
import { estimateTokenCount } from '../../../../shared/formatters';
import { usePluginContributions } from '../../../hooks/usePluginContributions';
import './MaestroPromptsTab.css';

// Category key for plugin-contributed prompts. They are read-only (a plugin owns
// their content), shown for reference/insertion, never edited via this tab.
const PLUGIN_PROMPT_CATEGORY = 'plugin';

interface CorePrompt {
	id: string;
	filename: string;
	description: string;
	category: string;
	content: string;
	isModified: boolean;
	hasDefaultDrifted: boolean;
}

interface MaestroPromptsTabProps {
	theme: Theme;
	initialSelectedPromptId?: string;
	onEscapeHandled?: (handler: (() => boolean) | null) => void;
}

/** Which half of the Preview/Edit switch is showing. */
type PromptViewMode = 'preview' | 'edit';

// Same order as the Memory Viewer so the two switches read alike; the DEFAULT
// differs (`edit`), because this pane exists to change a prompt rather than to
// read one.
const VIEW_MODE_OPTIONS = [
	{
		value: 'preview' as const,
		label: 'Preview',
		title: 'Rendered, with template variables resolved',
	},
	{ value: 'edit' as const, label: 'Edit', title: 'Syntax-highlighted source' },
];

/**
 * The first line of `content` containing `query`, trimmed for a tooltip.
 *
 * A prompt matched on its body needs to show WHY it survived the filter - the
 * id and description on the row already failed to explain it.
 */
function matchingLine(content: string, query: string): string | undefined {
	const lower = query.toLowerCase();
	const line = content.split('\n').find((l) => l.toLowerCase().includes(lower));
	if (!line) return undefined;
	const trimmed = line.trim();
	return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

// Category display names (sorted alphabetically by label)
const CATEGORY_INFO: Record<string, { label: string }> = {
	autorun: { label: 'Auto Run' },
	commands: { label: 'Commands' },
	context: { label: 'Context' },
	'group-chat': { label: 'Group Chat' },
	includes: { label: 'Includes' },
	'inline-wizard': { label: 'Inline Wizard' },
	[PLUGIN_PROMPT_CATEGORY]: { label: 'Plugin Prompts' },
	system: { label: 'System' },
	wizard: { label: 'Wizard' },
};

// Category descriptions for the help panel
const CATEGORY_HELP: Record<string, string> = {
	wizard:
		'Prompts used by the Wizard feature for AI-guided conversations, document generation, and continuation flows.',
	'inline-wizard':
		'Prompts for the Inline Wizard that operates within the editor - new sessions, iterations, and generation.',
	autorun:
		'Prompts controlling Auto Run behavior - the default execution prompt and synopsis generation for Auto Run documents.',
	'group-chat':
		'Prompts for Group Chat sessions - moderator system/synthesis prompts, participant behavior, and participant request formatting.',
	context:
		'Prompts for context management - grooming (trimming context), transferring context between sessions, and summarization.',
	commands:
		'Prompts for built-in commands - image-only message handling and git commit message generation.',
	includes:
		'Reusable blocks referenced from other prompts. Two directives consume them: {{INCLUDE:name}} fully inlines the content at assembly time (use for foundational rules every agent must have); {{REF:name}} expands to a one-line pointer that tells the agent to fetch it on demand via `maestro-cli prompts get <name>` (use for heavy reference material only some sessions need). Keeps shared content (history format, Auto Run spec, CLI reference, Cue model, file-access rules) in one place so every agent that needs it gets the same wording.',
	system:
		"System-level prompts - the Maestro system context injected into agents, tab naming, Director's Notes, and feedback.",
	[PLUGIN_PROMPT_CATEGORY]:
		'Read-only prompts contributed by installed plugins. Their content is owned by the plugin and cannot be edited here.',
};

// Group template variables by prefix for the help panel
function groupTemplateVariables(): { label: string; variables: typeof TEMPLATE_VARIABLES }[] {
	const general = TEMPLATE_VARIABLES.filter(
		(v) => !(v as { autoRunOnly?: boolean }).autoRunOnly && !(v as { cueOnly?: boolean }).cueOnly
	);
	const autoRun = TEMPLATE_VARIABLES.filter((v) => (v as { autoRunOnly?: boolean }).autoRunOnly);
	const cue = TEMPLATE_VARIABLES.filter((v) => (v as { cueOnly?: boolean }).cueOnly);

	const groups: { label: string; variables: typeof TEMPLATE_VARIABLES }[] = [];
	if (general.length > 0) groups.push({ label: 'General', variables: general });
	if (autoRun.length > 0) groups.push({ label: 'Auto Run Only', variables: autoRun });
	if (cue.length > 0) groups.push({ label: 'Cue Automation Only', variables: cue });
	return groups;
}

const TEMPLATE_VARIABLE_GROUPS = groupTemplateVariables();

function PromptsHelpPanel({ theme, onClose }: { theme: Theme; onClose?: () => void }): JSX.Element {
	return (
		<div className="prompts-help-panel" style={{ color: theme.colors.textMain }}>
			{onClose && (
				<div className="prompts-help-close-row">
					<button
						className="expand-toggle-button"
						onClick={onClose}
						title="Close help"
						style={{
							color: theme.colors.textDim,
							borderColor: theme.colors.border,
						}}
					>
						<X className="w-3.5 h-3.5" />
					</button>
				</div>
			)}

			<div className="prompts-help-section">
				<h3 className="prompts-help-heading" style={{ color: theme.colors.accent }}>
					What Are Core Prompts?
				</h3>
				<p className="prompts-help-text" style={{ color: theme.colors.textDim }}>
					Core prompts are the system instructions that control how Maestro's AI features behave.
					Each prompt is a Markdown template that gets injected into the AI context for a specific
					feature. Customizing these lets you tailor Maestro's behavior without modifying source
					code.
				</p>
				<p className="prompts-help-text" style={{ color: theme.colors.textDim }}>
					Changes take effect immediately - no restart required. Use the{' '}
					<strong style={{ color: theme.colors.textMain }}>Reset to Default</strong> button to
					revert any prompt to its bundled original.
				</p>
			</div>

			<div className="prompts-help-section">
				<h3 className="prompts-help-heading" style={{ color: theme.colors.accent }}>
					Prompt Categories
				</h3>
				{Object.entries(CATEGORY_INFO)
					.sort(([, a], [, b]) => a.label.localeCompare(b.label))
					.map(([key, info]) => (
						<div key={key} className="prompts-help-category-item">
							<strong style={{ color: theme.colors.textMain }}>{info.label}</strong>
							<p
								className="prompts-help-text"
								style={{ color: theme.colors.textDim, marginTop: 2 }}
							>
								{CATEGORY_HELP[key] || ''}
							</p>
						</div>
					))}
			</div>

			<div className="prompts-help-section">
				<h3 className="prompts-help-heading" style={{ color: theme.colors.accent }}>
					Include Directives
				</h3>
				<p className="prompts-help-text" style={{ color: theme.colors.textDim }}>
					<code
						className="prompts-help-code"
						style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.accent }}
					>
						{'{{INCLUDE:name}}'}
					</code>{' '}
					fully inlines another prompt file at assembly time. Nesting up to 3 levels deep is
					supported and cycles are detected. Use this for foundational rules every recipient must
					see.
				</p>
				<p className="prompts-help-text" style={{ color: theme.colors.textDim }}>
					<code
						className="prompts-help-code"
						style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.accent }}
					>
						{'{{REF:name}}'}
					</code>{' '}
					expands to the absolute on-disk path of the bundled{' '}
					<code
						className="prompts-help-code"
						style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.accent }}
					>
						.md
					</code>{' '}
					(native separators for the host OS) - nothing else, no description or formatting. Wrap the
					directive with whatever prose, list markers, or context you want; the agent reads the file
					directly. Use this for heavy reference material only some sessions need. The path resolves
					to bundled content; to honor your customizations on this tab, agents should fetch via{' '}
					<code
						className="prompts-help-code"
						style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.accent }}
					>
						maestro-cli prompts get &lt;name&gt;
					</code>{' '}
					instead.
				</p>
			</div>

			<div className="prompts-help-section">
				<h3 className="prompts-help-heading" style={{ color: theme.colors.accent }}>
					Template Variables
				</h3>
				<p className="prompts-help-text" style={{ color: theme.colors.textDim }}>
					Template variables are placeholders that get substituted with live values at runtime. Type{' '}
					<code
						className="prompts-help-code"
						style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.accent }}
					>
						{'{{'}
					</code>{' '}
					in the editor to trigger autocomplete.
				</p>
				{TEMPLATE_VARIABLE_GROUPS.map((group) => (
					<div key={group.label} className="prompts-help-var-group">
						<div className="prompts-help-var-group-label" style={{ color: theme.colors.textMain }}>
							{group.label}
						</div>
						<div className="prompts-help-var-table" style={{ borderColor: theme.colors.border }}>
							{group.variables.map((v) => (
								<div
									key={v.variable}
									className="prompts-help-var-row"
									style={{ borderColor: theme.colors.border }}
								>
									<code
										className="prompts-help-var-name"
										style={{
											backgroundColor: theme.colors.bgMain,
											color: theme.colors.accent,
										}}
									>
										{v.variable}
									</code>
									<span className="prompts-help-var-desc" style={{ color: theme.colors.textDim }}>
										{v.description}
									</span>
								</div>
							))}
						</div>
					</div>
				))}
			</div>

			{/* Read more link */}
			<div
				className="mt-4 pt-3 border-t flex items-center gap-1.5"
				style={{ borderColor: theme.colors.border }}
			>
				<ExternalLink className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
				<button
					onClick={() =>
						openUrl(buildMaestroUrl('https://docs.runmaestro.ai/prompt-customization'))
					}
					className="text-xs hover:opacity-80 transition-colors"
					style={{ color: theme.colors.accent }}
				>
					Read more at docs.runmaestro.ai/prompt-customization
				</button>
			</div>
		</div>
	);
}

export function MaestroPromptsTab({
	theme,
	initialSelectedPromptId,
	onEscapeHandled,
}: MaestroPromptsTabProps): JSX.Element {
	const [prompts, setPrompts] = useState<CorePrompt[]>([]);
	const [selectedPrompt, setSelectedPrompt] = useState<CorePrompt | null>(null);
	const [editedContent, setEditedContent] = useState('');
	const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [isResetting, setIsResetting] = useState(false);
	const [successMessage, setSuccessMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
	const [promptsPath, setPromptsPath] = useState<string | null>(null);
	const [isEditorExpanded, setIsEditorExpanded] = useState(false);
	const [showHelp, setShowHelp] = useState(false);
	/**
	 * Reading or writing. Unlike the Memory Viewer this opens on `edit`: a
	 * prompt is opened here to be changed, and the rendered form is one
	 * keystroke away rather than the state you have to leave first.
	 */
	const [viewMode, setViewMode] = useState<PromptViewMode>('edit');
	const [previewContent, setPreviewContent] = useState('');
	const [isBuildingPreview, setIsBuildingPreview] = useState(false);
	// "Show bundled default" overlay: read-only view of the current bundled
	// content, surfaced when the user's customization has drifted from the
	// default after an app update. Mutually exclusive with preview mode.
	const [isShowingDefault, setIsShowingDefault] = useState(false);
	const [bundledDefaultContent, setBundledDefaultContent] = useState('');
	const [isLoadingBundledDefault, setIsLoadingBundledDefault] = useState(false);

	// Keyword filter over id, description, and body. Everything is already in
	// memory, so this is a local narrow rather than a search round trip.
	const [filterQuery, setFilterQuery] = useState('');
	const debouncedFilter = useDebouncedValue(filterQuery, 120);
	const filterInputRef = useRef<HTMLInputElement>(null);
	// Bumped to hand keyboard focus back to the list (leaving the filter box).
	const [listFocusToken, setListFocusToken] = useState(0);

	const editorRef = useRef<MarkdownEditorHandle>(null);
	const previewScrollRef = useRef<HTMLDivElement>(null);
	const activeSession = useActiveSession();
	const conductorProfile = useSettingsStore((s) => s.conductorProfile);
	const lastSelectedPromptId = useSettingsStore((s) => s.lastSelectedPromptId);
	const setLastSelectedPromptId = useSettingsStore((s) => s.setLastSelectedPromptId);
	// Snapshot the recalled prompt ID once so we don't re-select across rerenders after the
	// user picks something else in this session.
	const initialRecalledPromptIdRef = useRef<string | null | undefined>(undefined);
	if (initialRecalledPromptIdRef.current === undefined) {
		initialRecalledPromptIdRef.current = lastSelectedPromptId ?? null;
	}

	// Plugin-contributed prompts (read-only). Empty when the plugins Encore flag
	// is off. Shaped like CorePrompt so they slot into the same list/editor, but
	// flagged via pluginPromptIds so save/reset/editing stay disabled for them.
	const pluginContributions = usePluginContributions();
	const pluginPromptItems = useMemo<CorePrompt[]>(
		() =>
			pluginContributions.prompts.map((p) => ({
				id: p.id,
				filename: '',
				description: p.description ?? `Plugin prompt from ${p.pluginId}`,
				category: PLUGIN_PROMPT_CATEGORY,
				content: p.content,
				isModified: false,
				hasDefaultDrifted: false,
			})),
		[pluginContributions.prompts]
	);
	const pluginPromptIds = useMemo(
		() => new Set(pluginPromptItems.map((p) => p.id)),
		[pluginPromptItems]
	);
	const allPrompts = useMemo(
		() => [...prompts, ...pluginPromptItems],
		[prompts, pluginPromptItems]
	);
	const isSelectedPluginPrompt = selectedPrompt ? pluginPromptIds.has(selectedPrompt.id) : false;

	const autocomplete = useEditorTemplateAutocomplete({
		editorRef: editorRef as React.RefObject<MarkdownEditorHandle>,
		onChange: (newValue: string) => {
			setEditedContent(newValue);
			setHasUnsavedChanges(newValue !== selectedPrompt?.content);
		},
	});

	/** Move keyboard focus back to the prompt list. */
	const focusList = useCallback(() => setListFocusToken((t) => t + 1), []);

	/**
	 * Escape is a LADDER, climbed one rung per press, never skipping to close:
	 *
	 *   1. autocomplete open      -> dismiss the popup
	 *   2. caret in the filter box -> hand focus back to the list, query intact
	 *   3. filter still has text   -> clear it
	 *   4. help panel / bundled-default overlay / expanded editor -> back out
	 *   5. otherwise               -> report unhandled and let Settings close
	 *
	 * Rung 2 is what makes "filter, then arrow through the hits" work: the query
	 * has to survive the key that gets you out of the text box.
	 *
	 * Every rung lives here because the layer stack handles Escape at CAPTURE on
	 * `window`, so neither `FilterInput` nor the CodeMirror editor ever sees the
	 * key - without this the whole Settings modal would close instead.
	 */
	const visibleIdsRef = useRef<string[]>([]);
	const escapeStateRef = useRef<() => boolean>(() => false);
	escapeStateRef.current = () => {
		if (autocomplete.autocompleteState.isOpen) {
			autocomplete.closeAutocomplete();
			return true;
		}
		if (document.activeElement === filterInputRef.current && visibleIdsRef.current.length > 0) {
			filterInputRef.current?.blur();
			focusList();
			return true;
		}
		if (filterQuery) {
			setFilterQuery('');
			return true;
		}
		if (showHelp) {
			setShowHelp(false);
			return true;
		}
		if (isShowingDefault) {
			setIsShowingDefault(false);
			return true;
		}
		if (isEditorExpanded) {
			setIsEditorExpanded(false);
			return true;
		}
		return false;
	};

	// Registered unconditionally: two of the rungs above (focus in the filter
	// box, an open autocomplete) are not React state, so there is no state to
	// gate registration on. The handler reports `false` when no rung applies,
	// which is what lets Settings close normally.
	const handleEscape = useCallback(() => escapeStateRef.current(), []);
	useEffect(() => {
		onEscapeHandled?.(handleEscape);
		return () => onEscapeHandled?.(null);
	}, [onEscapeHandled, handleEscape]);

	/**
	 * Jump to the filter box with a bare `/`.
	 *
	 * Cmd/Ctrl+F is deliberately NOT bound here: the Settings modal already owns
	 * it for the settings search, and taking a chord away from its incumbent is
	 * worse than having one way in. `/` is a legal character, so it only fires
	 * when the caret is outside a text surface - typing a path into a prompt
	 * must never fling focus into the filter mid-word.
	 */
	useEventListener('keydown', (event) => {
		const e = event as KeyboardEvent;
		if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
		if (isTextInputTarget(e.target)) return;
		e.preventDefault();
		e.stopPropagation();
		filterInputRef.current?.focus();
		filterInputRef.current?.select();
	});

	/**
	 * Cmd/Ctrl+E flips between the rendered prompt and the source editor.
	 *
	 * Read from the user's LIVE `toggleMarkdownMode` binding rather than a
	 * literal `e`, so the chord that flips a file preview, a memory, and a
	 * prompt stays one key after a remap.
	 */
	const toggleModeKeys = useSettingsStore((s) => s.shortcuts?.toggleMarkdownMode?.keys);

	/**
	 * Picking a mode also leaves the bundled-default comparison. That overlay
	 * covers the whole pane, so switching underneath it would move nothing on
	 * screen and read as a dead control.
	 */
	const changeViewMode = useCallback((mode: PromptViewMode) => {
		setIsShowingDefault(false);
		setViewMode(mode);
	}, []);

	useEventListener('keydown', (event) => {
		const e = event as KeyboardEvent;
		if (!eventMatchesShortcutKeys(e, toggleModeKeys)) return;
		e.preventDefault();
		e.stopPropagation();
		setIsShowingDefault(false);
		setViewMode((mode) => (mode === 'preview' ? 'edit' : 'preview'));
	});

	/**
	 * Land the caret in the editor on the way into Edit, and hand it back to the
	 * list on the way out. Without the first half, the switch puts a writable
	 * surface on screen that silently swallows nothing: every keystroke still
	 * goes wherever focus already was, which reads as a broken editor.
	 */
	const previousViewModeRef = useRef(viewMode);
	useEffect(() => {
		const previous = previousViewModeRef.current;
		previousViewModeRef.current = viewMode;
		if (previous === viewMode || showHelp) return;
		if (viewMode === 'edit') {
			requestAnimationFrame(() => editorRef.current?.focus());
		} else {
			focusList();
		}
	}, [viewMode, showHelp, focusList]);

	// Exit the bundled-default overlay when switching prompts - it describes the
	// prompt you were looking at, not the one you just opened.
	useEffect(() => {
		setIsShowingDefault(false);
	}, [selectedPrompt?.id]);

	/**
	 * Resolve the prompt's template variables against the active agent.
	 *
	 * Read through a ref rather than a dependency: the content only changes in
	 * Edit mode, so rebuilding per keystroke would resolve a preview nobody is
	 * looking at.
	 */
	const editedContentRef = useRef(editedContent);
	editedContentRef.current = editedContent;
	useEffect(() => {
		if (viewMode !== 'preview') return;
		let cancelled = false;
		const content = editedContentRef.current;
		if (!activeSession) {
			setPreviewContent(
				'Preview unavailable: no active agent session to resolve template variables against.'
			);
			return;
		}
		setIsBuildingPreview(true);
		void (async () => {
			try {
				let gitBranch: string | undefined;
				if (activeSession.isGitRepo) {
					try {
						const status = await gitService.getStatus(activeSession.cwd);
						gitBranch = status.branch;
					} catch {
						// ignore
					}
				}
				let historyFilePath: string | undefined;
				try {
					historyFilePath =
						(await window.maestro.history.getFilePath(activeSession.id)) || undefined;
				} catch {
					// ignore
				}
				if (cancelled) return;
				setPreviewContent(
					substituteTemplateVariables(content, {
						session: activeSession as any,
						gitBranch,
						groupId: (activeSession as any).groupId,
						historyFilePath,
						conductorProfile,
					})
				);
			} catch (err) {
				captureException(err instanceof Error ? err : new Error(String(err)), {
					extra: { context: 'MaestroPromptsTab.buildPreview' },
				});
				if (!cancelled) setPreviewContent(`Preview failed: ${String(err)}`);
			} finally {
				if (!cancelled) setIsBuildingPreview(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [viewMode, selectedPrompt?.id, activeSession, conductorProfile]);

	const handleToggleShowDefault = useCallback(async () => {
		if (isShowingDefault) {
			setIsShowingDefault(false);
			return;
		}
		if (!selectedPrompt) return;
		// The bundled default is a comparison view of the SOURCE, so it takes
		// over the editor pane rather than sitting beside the rendered preview.
		setViewMode('edit');
		setIsLoadingBundledDefault(true);
		try {
			const result = await window.maestro.prompts.getBundledDefault(selectedPrompt.id);
			if (result.success && typeof result.content === 'string') {
				setBundledDefaultContent(result.content);
				setIsShowingDefault(true);
			} else {
				const msg = result.error || 'Failed to load bundled default';
				setBundledDefaultContent(`Failed to load bundled default: ${msg}`);
				setIsShowingDefault(true);
			}
		} catch (err) {
			captureException(err instanceof Error ? err : new Error(String(err)), {
				extra: { context: 'MaestroPromptsTab.toggleShowDefault', promptId: selectedPrompt.id },
			});
			setBundledDefaultContent(`Failed to load bundled default: ${String(err)}`);
			setIsShowingDefault(true);
		} finally {
			setIsLoadingBundledDefault(false);
		}
	}, [isShowingDefault, selectedPrompt]);

	// Auto-dismiss success message after 3 seconds
	useEffect(() => {
		if (!successMessage) return;
		const timer = setTimeout(() => setSuccessMessage(null), 3000);
		return () => clearTimeout(timer);
	}, [successMessage]);

	// Load prompts and prompts path on mount
	useEffect(() => {
		(async () => {
			try {
				const [result, pathResult] = await Promise.all([
					window.maestro.prompts.getAll(),
					window.maestro.prompts.getPath(),
				]);
				if (pathResult.success && pathResult.path) {
					setPromptsPath(pathResult.path);
				}
				if (result.success && result.prompts) {
					setPrompts(result.prompts);
					const findById = (id: string | null | undefined) =>
						id ? result.prompts!.find((p) => p.id === id) : undefined;
					const target =
						findById(initialSelectedPromptId) ||
						findById(initialRecalledPromptIdRef.current) ||
						findById(PROMPT_IDS.MAESTRO_SYSTEM_PROMPT) ||
						result.prompts[0];
					if (target) {
						setSelectedPrompt(target);
						setEditedContent(target.content);
					}
				} else {
					const msg = result.error || 'Failed to load prompts';
					captureMessage(`MaestroPromptsTab load failed: ${msg}`, {
						extra: { error: result.error },
					});
					setError(msg);
				}
			} catch (err) {
				captureException(err instanceof Error ? err : new Error(String(err)), {
					extra: { context: 'MaestroPromptsTab.loadPrompts' },
				});
				setError(String(err));
			}
		})();
	}, []);

	const filterQueryTrimmed = debouncedFilter.trim();

	/**
	 * Prompts matching the filter, with the body line that matched.
	 *
	 * The body is searched as well as the id and description because that is
	 * where the answer to "which prompt tells the agent X?" actually lives -
	 * matching only the names would leave the whole point of the box undone.
	 */
	const filteredPrompts = useMemo(() => {
		const sorted = [...allPrompts].sort((a, b) => a.id.localeCompare(b.id));
		if (!filterQueryTrimmed) return sorted.map((prompt) => ({ prompt, snippet: undefined }));
		const q = filterQueryTrimmed.toLowerCase();
		return sorted
			.map((prompt) => ({
				prompt,
				matches:
					prompt.id.toLowerCase().includes(q) ||
					prompt.description.toLowerCase().includes(q) ||
					prompt.content.toLowerCase().includes(q) ||
					// A prompt with unsaved edits is never filtered away. The editor
					// pane only exists while its row does, so hiding the row would
					// take an unsaved draft off screen with no way back to it.
					(hasUnsavedChanges && prompt.id === selectedPrompt?.id),
				snippet: matchingLine(prompt.content, filterQueryTrimmed),
			}))
			.filter((entry) => entry.matches);
	}, [allPrompts, filterQueryTrimmed, hasUnsavedChanges, selectedPrompt?.id]);

	// Read at filter time to hand focus back to the list; a ref keeps the
	// Escape ladder off the filtered list's identity.
	visibleIdsRef.current = filteredPrompts.map((entry) => entry.prompt.id);

	// Build items for the shared editor (sorted by id within category; category order is handled by the shared component).
	const items = useMemo<DualPaneFileEditorItem[]>(
		() =>
			filteredPrompts.map(({ prompt, snippet }) => ({
				id: prompt.id,
				label: prompt.id,
				description: snippet ? `${prompt.description}\nmatch: ${snippet}` : prompt.description,
				category: prompt.category,
				isModified: prompt.isModified,
				hasDefaultDrifted: prompt.hasDefaultDrifted,
			})),
		[filteredPrompts]
	);

	const editorTokenCount = useMemo(
		() => (selectedPrompt ? estimateTokenCount(editedContent) : undefined),
		[selectedPrompt, editedContent]
	);

	const openPrompt = useCallback(
		(prompt: CorePrompt) => {
			setSelectedPrompt(prompt);
			setEditedContent(prompt.content);
			setHasUnsavedChanges(false);
			setSuccessMessage(null);
			setLastSelectedPromptId(prompt.id);
		},
		[setLastSelectedPromptId]
	);

	const handleSelectPrompt = useCallback(
		(id: string) => {
			const prompt = allPrompts.find((p) => p.id === id);
			if (!prompt) return;
			if (hasUnsavedChanges) {
				const discard = window.confirm('You have unsaved changes. Discard them?');
				if (!discard) return;
			}
			openPrompt(prompt);
		},
		[prompts, hasUnsavedChanges, openPrompt]
	);

	// A filter that hides the current selection moves to the top hit, so typing
	// shows the match instead of an editor pinned to a row that is gone.
	// Unsaved edits win: never yank the user off a prompt they have changed.
	useEffect(() => {
		if (!filterQueryTrimmed || hasUnsavedChanges) return;
		if (selectedPrompt && filteredPrompts.some((e) => e.prompt.id === selectedPrompt.id)) return;
		const first = filteredPrompts[0];
		if (first) openPrompt(first.prompt);
	}, [filterQueryTrimmed, filteredPrompts, selectedPrompt, hasUnsavedChanges, openPrompt]);

	const toggleCategory = useCallback((category: string) => {
		setCollapsedCategories((prev) => {
			const next = new Set(prev);
			if (next.has(category)) {
				next.delete(category);
			} else {
				next.add(category);
			}
			return next;
		});
	}, []);

	const handleSave = useCallback(async () => {
		if (!selectedPrompt || !hasUnsavedChanges) return;

		setIsSaving(true);
		setError(null);
		try {
			const result = await window.maestro.prompts.save(selectedPrompt.id, editedContent);
			if (result.success) {
				// Refresh all renderer prompt caches so the edit takes effect immediately
				await refreshRendererPrompts();
				// Saving re-baselines against the current bundled hash, so any prior
				// drift indicator clears immediately.
				setPrompts((prev) =>
					prev.map((p) =>
						p.id === selectedPrompt.id
							? { ...p, content: editedContent, isModified: true, hasDefaultDrifted: false }
							: p
					)
				);
				setSelectedPrompt((prev) =>
					prev
						? { ...prev, content: editedContent, isModified: true, hasDefaultDrifted: false }
						: null
				);
				setIsShowingDefault(false);
				setHasUnsavedChanges(false);
				setSuccessMessage('Changes saved');
			} else {
				const msg = result.error || 'Failed to save prompt';
				captureMessage(`MaestroPromptsTab save failed: ${msg}`, {
					extra: { promptId: selectedPrompt.id, error: result.error },
				});
				setError(msg);
			}
		} catch (err) {
			captureException(err instanceof Error ? err : new Error(String(err)), {
				extra: { context: 'MaestroPromptsTab.savePrompt', promptId: selectedPrompt.id },
			});
			setError(String(err));
		} finally {
			setIsSaving(false);
		}
	}, [selectedPrompt, editedContent, hasUnsavedChanges]);

	const handleReset = useCallback(async () => {
		if (!selectedPrompt) return;

		const confirmed = window.confirm(
			`Reset "${selectedPrompt.id}" to the bundled default? Your customization will be lost.`
		);
		if (!confirmed) return;

		setIsResetting(true);
		setError(null);
		try {
			const result = await window.maestro.prompts.reset(selectedPrompt.id);
			if (result.success && result.content) {
				// Refresh all renderer prompt caches so the reset takes effect immediately
				await refreshRendererPrompts();
				setPrompts((prev) =>
					prev.map((p) =>
						p.id === selectedPrompt.id
							? { ...p, content: result.content!, isModified: false, hasDefaultDrifted: false }
							: p
					)
				);
				setSelectedPrompt((prev) =>
					prev
						? { ...prev, content: result.content!, isModified: false, hasDefaultDrifted: false }
						: null
				);
				setEditedContent(result.content);
				setIsShowingDefault(false);
				setHasUnsavedChanges(false);
				setSuccessMessage('Reset to default');
			} else {
				const msg = result.error || 'Failed to reset prompt';
				captureMessage(`MaestroPromptsTab reset failed: ${msg}`, {
					extra: { promptId: selectedPrompt.id, error: result.error },
				});
				setError(msg);
			}
		} catch (err) {
			captureException(err instanceof Error ? err : new Error(String(err)), {
				extra: { context: 'MaestroPromptsTab.resetPrompt', promptId: selectedPrompt.id },
			});
			setError(String(err));
		} finally {
			setIsResetting(false);
		}
	}, [selectedPrompt]);

	const editorHeaderActions = (
		<>
			{selectedPrompt?.hasDefaultDrifted && (
				<button
					className="expand-toggle-button"
					onClick={handleToggleShowDefault}
					disabled={isLoadingBundledDefault}
					title={
						isShowingDefault
							? 'Exit default view (show your customization)'
							: 'View the current bundled default that shipped with this update'
					}
					style={{
						color: isShowingDefault ? theme.colors.warning : theme.colors.textDim,
						borderColor: isShowingDefault ? theme.colors.warning : theme.colors.border,
					}}
				>
					<GitCompare className="w-3.5 h-3.5" />
				</button>
			)}
			<button
				className="expand-toggle-button"
				onClick={() => setIsEditorExpanded((prev) => !prev)}
				title={isEditorExpanded ? 'Collapse editor' : 'Expand editor'}
				style={{
					color: theme.colors.textDim,
					borderColor: theme.colors.border,
				}}
			>
				{isEditorExpanded ? (
					<Minimize2 className="w-3.5 h-3.5" />
				) : (
					<Maximize2 className="w-3.5 h-3.5" />
				)}
			</button>
		</>
	);

	/**
	 * Repaint the editor's filter highlights whenever the query or the document
	 * changes. Pushed imperatively because CodeMirror owns its document -
	 * re-rendering the component would not move a decoration, and rebuilding the
	 * view would throw away the undo history and the caret.
	 *
	 * `-1` for the active index washes every hit equally: this is a filter, not
	 * a find bar, so there is no cursor into the results.
	 */
	useEffect(() => {
		if (viewMode !== 'edit' || isShowingDefault) return;
		editorRef.current?.setSearchMatches(searchMatchRanges(editedContent, filterQueryTrimmed), -1);
	}, [viewMode, isShowingDefault, editedContent, filterQueryTrimmed]);

	const renderEditorBody = useCallback(() => {
		// A plugin owns its prompt's content, so it is shown in the same editor
		// with writing switched off - readable and copyable, never saveable.
		if (isSelectedPluginPrompt) {
			return (
				<div className="prompt-editor-shell" style={{ borderColor: theme.colors.border }}>
					<MarkdownEditor
						key={`plugin-${selectedPrompt?.id ?? 'none'}`}
						value={editedContent}
						onChange={() => {}}
						readOnly
						language="markdown"
						theme={theme}
					/>
				</div>
			);
		}

		// The bundled default is a read-only comparison view, so it takes the
		// editor's place rather than opening beside it - and it is shown as
		// SOURCE, since the point is to diff wording against your own copy.
		if (isShowingDefault) {
			return (
				<div className="prompt-editor-shell" style={{ borderColor: theme.colors.warning }}>
					<MarkdownEditor
						key={`default-${selectedPrompt?.id ?? 'none'}`}
						value={bundledDefaultContent}
						onChange={() => {}}
						readOnly
						language="markdown"
						theme={theme}
					/>
				</div>
			);
		}

		if (viewMode === 'preview') {
			return (
				<div
					ref={previewScrollRef}
					className="prompt-preview"
					// Focusable so the pane scrolls with the keyboard the moment it
					// is shown; a reading surface you have to click first is one the
					// arrow keys look broken on.
					tabIndex={0}
					style={{
						borderColor: theme.colors.accent,
						backgroundColor: theme.colors.bgMain,
						color: theme.colors.textMain,
					}}
					data-testid="prompt-preview"
				>
					<Markdown
						preset="document"
						content={isBuildingPreview && !previewContent ? 'Building preview...' : previewContent}
						theme={theme}
						containerRef={previewScrollRef}
						searchHighlight={
							filterQueryTrimmed ? { query: filterQueryTrimmed, currentMatchIndex: -1 } : undefined
						}
					/>
				</div>
			);
		}

		// Same CodeMirror editor the File Preview and the Memory Viewer write
		// with, so a prompt is coloured like every other markdown document in the
		// app and the gutter stays aligned through soft wraps.
		//
		// Keyed on the prompt id so switching prompts remounts the view: undo
		// history belongs to one document, and carrying it across files lets an
		// undo paste the previous prompt's text into this one.
		return (
			<>
				{/* The border lives on a wrapper rather than on the editor's own
				    host: CodeMirror measures its viewport against that host, and a
				    border on it is counted twice once the content scrolls. */}
				<div className="prompt-editor-shell" style={{ borderColor: theme.colors.border }}>
					<MarkdownEditor
						key={selectedPrompt?.id ?? 'prompt'}
						ref={editorRef}
						value={editedContent}
						onChange={autocomplete.handleChange}
						onKeyDown={autocomplete.handleKeyDown}
						language="markdown"
						theme={theme}
					/>
				</div>
				{/* Outside the editor shell, which clips its overflow, but inside
				    the body - that is the positioned ancestor the dropdown's
				    caret-relative coordinates are measured against. */}
				<TemplateAutocompleteDropdown
					ref={autocomplete.autocompleteRef}
					theme={theme}
					state={autocomplete.autocompleteState}
					onSelect={autocomplete.selectVariable}
				/>
			</>
		);
	}, [
		isSelectedPluginPrompt,
		isShowingDefault,
		bundledDefaultContent,
		viewMode,
		previewContent,
		isBuildingPreview,
		filterQueryTrimmed,
		editedContent,
		selectedPrompt?.id,
		autocomplete,
		theme,
	]);

	/**
	 * Title block plus the toolbar that carries every control the pane offers.
	 *
	 * The toolbar stays on screen while the editor is expanded - the filter and
	 * the view switch are how you get around in here, and hiding them behind the
	 * expand button would make expanding cost more than it buys. Only the prose
	 * above it yields, since that is the part that is purely explanatory.
	 */
	const header = showHelp ? null : (
		<div className="prompts-tab-header">
			{!isEditorExpanded && (
				<div className="prompts-tab-header-text">
					<div className="text-xs font-bold opacity-70 uppercase mb-1">Core System Prompts</div>
					<p className="text-xs opacity-70">
						Customize the system prompts used by Maestro features. Changes take effect immediately.
						Use <code className="text-xs opacity-70">{'{{INCLUDE:name}}'}</code> to reference other
						prompt files.
					</p>
				</div>
			)}
			<div className="prompts-toolbar" style={{ color: theme.colors.textDim }}>
				<FilterInput
					ref={filterInputRef}
					theme={theme}
					value={filterQuery}
					onChange={setFilterQuery}
					placeholder="Filter prompts by name or content..."
					ariaLabel="Filter prompts by name, description, or content"
					title="Filter prompts by name, description, or content (/)"
					width={280}
					resultLabel={filterQueryTrimmed ? `${items.length}/${prompts.length}` : undefined}
				/>
				<div className="flex-1" />
				<button
					className="prompts-help-button"
					onClick={() => setShowHelp(true)}
					title="Prompt reference"
					style={{
						color: theme.colors.textDim,
						borderColor: theme.colors.border,
					}}
				>
					<HelpCircle className="w-3.5 h-3.5" />
				</button>
				<SegmentedControl
					value={viewMode}
					onChange={changeViewMode}
					options={VIEW_MODE_OPTIONS}
					theme={theme}
					ariaLabel="Show the prompt rendered with template variables resolved, or as editable source"
					testId="prompt-view-mode"
				/>
			</div>
		</div>
	);

	return (
		<div className="maestro-prompts-settings-tab">
			{/* Scoped so the rendered prompt picks up the app's document
			    typography without leaking heading and table rules onto the
			    settings chrome around it. */}
			<style>{generateProseStyles({ theme, scopeSelector: '.prompt-preview' })}</style>
			<DualPaneFileEditor
				theme={theme}
				items={items}
				selectedId={selectedPrompt?.id ?? null}
				onSelect={handleSelectPrompt}
				categories={CATEGORY_INFO}
				collapsedCategories={collapsedCategories}
				onToggleCategory={toggleCategory}
				header={header}
				helpPanel={<PromptsHelpPanel theme={theme} onClose={() => setShowHelp(false)} />}
				showHelp={showHelp}
				isExpanded={isEditorExpanded}
				emptyStateMessage={
					filterQueryTrimmed && items.length === 0
						? `No prompt matches "${filterQueryTrimmed}"`
						: 'Select a prompt to edit'
				}
				highlightQuery={filterQueryTrimmed}
				listFocusToken={listFocusToken}
				// So Up/Down walk the prompts without having to click a row first.
				// It defers to anything that already holds focus, so opening the
				// tab by clicking its button does not yank the caret away.
				autoFocusList
				editorTitle={selectedPrompt?.id}
				editorDescription={selectedPrompt?.description}
				editorTokenCount={editorTokenCount}
				editorHeaderActions={editorHeaderActions}
				showModifiedBadge={selectedPrompt?.isModified}
				showDefaultDriftedBadge={selectedPrompt?.hasDefaultDrifted}
				renderEditorBody={renderEditorBody}
				successMessage={successMessage}
				errorMessage={error}
				primaryAction={{
					label: isSaving ? 'Saving...' : 'Save',
					loading: isSaving,
					disabled: !hasUnsavedChanges || isSelectedPluginPrompt,
					onClick: handleSave,
				}}
				secondaryAction={{
					label: isResetting ? 'Resetting...' : 'Reset to Default',
					loading: isResetting,
					disabled: !selectedPrompt?.isModified && !hasUnsavedChanges,
					onClick: handleReset,
				}}
				openInFinderPath={promptsPath}
			/>
		</div>
	);
}
