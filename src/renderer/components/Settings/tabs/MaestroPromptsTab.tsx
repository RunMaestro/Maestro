/**
 * Maestro Prompts Tab - Edit core system prompts
 *
 * Settings tab for browsing and editing core prompts.
 * Edits are saved to customizations file AND applied immediately in memory.
 *
 * Layout chrome (split pane, list, editor actions, open-in-finder) is provided by
 * the shared `DualPaneFileEditor`. This component owns the prompt-specific state,
 * template autocomplete, preview mode, and help content.
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { ExternalLink, Maximize2, Minimize2, HelpCircle, X, Eye, EyeOff } from 'lucide-react';
import type { Theme } from '../../../constants/themes';
import { refreshRendererPrompts } from '../../../services/promptInit';
import { captureException, captureMessage } from '../../../utils/sentry';
import { openUrl } from '../../../utils/openUrl';
import { buildMaestroUrl } from '../../../utils/buildMaestroUrl';
import { useTemplateAutocomplete } from '../../../hooks/input/useTemplateAutocomplete';
import { TemplateAutocompleteDropdown } from '../../TemplateAutocompleteDropdown';
import { TEMPLATE_VARIABLES, substituteTemplateVariables } from '../../../utils/templateVariables';
import { useActiveSession } from '../../../hooks/session/useActiveSession';
import { useSettingsStore } from '../../../stores/settingsStore';
import { gitService } from '../../../services/git';
import { DualPaneFileEditor, type DualPaneFileEditorItem } from '../../shared/DualPaneFileEditor';
import { PROMPT_IDS } from '../../../../shared/promptDefinitions';
import { estimateTokenCount } from '../../../../shared/formatters';
import './MaestroPromptsTab.css';

interface CorePrompt {
	id: string;
	filename: string;
	description: string;
	category: string;
	content: string;
	isModified: boolean;
}

interface MaestroPromptsTabProps {
	theme: Theme;
	initialSelectedPromptId?: string;
	onEscapeHandled?: (handler: (() => boolean) | null) => void;
}

// Category display names (sorted alphabetically by label)
const CATEGORY_INFO: Record<string, { label: string }> = {
	autorun: { label: 'Auto Run' },
	commands: { label: 'Commands' },
	context: { label: 'Context' },
	'group-chat': { label: 'Group Chat' },
	includes: { label: 'Includes' },
	'inline-wizard': { label: 'Inline Wizard' },
	system: { label: 'System' },
	wizard: { label: 'Wizard' },
};

// Category descriptions for the help panel
const CATEGORY_HELP: Record<string, string> = {
	wizard:
		'Prompts used by the Wizard feature for AI-guided conversations, document generation, and continuation flows.',
	'inline-wizard':
		'Prompts for the Inline Wizard that operates within the editor — new sessions, iterations, and generation.',
	autorun:
		'Prompts controlling Auto Run behavior — the default execution prompt and synopsis generation for Auto Run documents.',
	'group-chat':
		'Prompts for Group Chat sessions — moderator system/synthesis prompts, participant behavior, and participant request formatting.',
	context:
		'Prompts for context management — grooming (trimming context), transferring context between sessions, and summarization.',
	commands:
		'Prompts for built-in commands — image-only message handling and git commit message generation.',
	includes:
		'Reusable blocks referenced from other prompts. Two directives consume them: {{INCLUDE:name}} fully inlines the content at assembly time (use for foundational rules every agent must have); {{REF:name}} expands to a one-line pointer that tells the agent to fetch it on demand via `maestro-cli prompts get <name>` (use for heavy reference material only some sessions need). Keeps shared content (history format, Auto Run spec, CLI reference, Cue model, file-access rules) in one place so every agent that needs it gets the same wording.',
	system:
		"System-level prompts — the Maestro system context injected into agents, tab naming, Director's Notes, and feedback.",
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
					Changes take effect immediately — no restart required. Use the{' '}
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
					(native separators for the host OS) — nothing else, no description or formatting. Wrap the
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
	const [isPreviewMode, setIsPreviewMode] = useState(false);
	const [previewContent, setPreviewContent] = useState('');
	const [isBuildingPreview, setIsBuildingPreview] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
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

	const autocomplete = useTemplateAutocomplete({
		textareaRef: textareaRef as React.RefObject<HTMLTextAreaElement>,
		value: editedContent,
		onChange: (newValue: string) => {
			setEditedContent(newValue);
			setHasUnsavedChanges(newValue !== selectedPrompt?.content);
		},
	});

	// Layered escape: help → preview → expanded editor → list view → (modal closes)
	const handleEscape = useCallback(() => {
		if (showHelp) {
			setShowHelp(false);
			return true;
		}
		if (isPreviewMode) {
			setIsPreviewMode(false);
			return true;
		}
		if (isEditorExpanded) {
			setIsEditorExpanded(false);
			return true;
		}
		return false;
	}, [showHelp, isPreviewMode, isEditorExpanded]);

	// Register escape handler with parent so escape navigates: help → preview → expanded → list → close modal
	useEffect(() => {
		if (showHelp || isPreviewMode || isEditorExpanded) {
			onEscapeHandled?.(handleEscape);
		} else {
			onEscapeHandled?.(null);
		}
		return () => onEscapeHandled?.(null);
	}, [showHelp, isPreviewMode, isEditorExpanded, onEscapeHandled, handleEscape]);

	// Exit preview mode when switching prompts or editing
	useEffect(() => {
		setIsPreviewMode(false);
	}, [selectedPrompt?.id]);

	const handleTogglePreview = useCallback(async () => {
		if (isPreviewMode) {
			setIsPreviewMode(false);
			return;
		}
		if (!activeSession) {
			setPreviewContent(
				'Preview unavailable: no active agent session to resolve template variables against.'
			);
			setIsPreviewMode(true);
			return;
		}
		setIsBuildingPreview(true);
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
				historyFilePath = (await window.maestro.history.getFilePath(activeSession.id)) || undefined;
			} catch {
				// ignore
			}
			const interpolated = substituteTemplateVariables(editedContent, {
				session: activeSession as any,
				gitBranch,
				groupId: (activeSession as any).groupId,
				historyFilePath,
				conductorProfile,
			});
			setPreviewContent(interpolated);
			setIsPreviewMode(true);
		} catch (err) {
			captureException(err instanceof Error ? err : new Error(String(err)), {
				extra: { context: 'MaestroPromptsTab.togglePreview' },
			});
			setPreviewContent(`Preview failed: ${String(err)}`);
			setIsPreviewMode(true);
		} finally {
			setIsBuildingPreview(false);
		}
	}, [isPreviewMode, activeSession, editedContent, conductorProfile]);

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

	// Build items for the shared editor (sorted by id within category; category order is handled by the shared component).
	const items = useMemo<DualPaneFileEditorItem[]>(() => {
		return [...prompts]
			.sort((a, b) => a.id.localeCompare(b.id))
			.map((p) => ({
				id: p.id,
				label: p.id,
				description: p.description,
				category: p.category,
				isModified: p.isModified,
			}));
	}, [prompts]);

	const editorTokenCount = useMemo(
		() => (selectedPrompt ? estimateTokenCount(editedContent) : undefined),
		[selectedPrompt, editedContent]
	);

	const handleSelectPrompt = useCallback(
		(id: string) => {
			const prompt = prompts.find((p) => p.id === id);
			if (!prompt) return;
			if (hasUnsavedChanges) {
				const discard = window.confirm('You have unsaved changes. Discard them?');
				if (!discard) return;
			}
			setSelectedPrompt(prompt);
			setEditedContent(prompt.content);
			setHasUnsavedChanges(false);
			setSuccessMessage(null);
			setLastSelectedPromptId(id);
		},
		[prompts, hasUnsavedChanges, setLastSelectedPromptId]
	);

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
				setPrompts((prev) =>
					prev.map((p) =>
						p.id === selectedPrompt.id ? { ...p, content: editedContent, isModified: true } : p
					)
				);
				setSelectedPrompt((prev) =>
					prev ? { ...prev, content: editedContent, isModified: true } : null
				);
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
						p.id === selectedPrompt.id ? { ...p, content: result.content!, isModified: false } : p
					)
				);
				setSelectedPrompt((prev) =>
					prev ? { ...prev, content: result.content!, isModified: false } : null
				);
				setEditedContent(result.content);
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
			{isEditorExpanded && (
				<button
					className="expand-toggle-button"
					onClick={() => setShowHelp(true)}
					title="Prompt reference"
					style={{
						color: theme.colors.textDim,
						borderColor: theme.colors.border,
					}}
				>
					<HelpCircle className="w-3.5 h-3.5" />
				</button>
			)}
			<button
				className="expand-toggle-button"
				onClick={handleTogglePreview}
				disabled={isBuildingPreview}
				title={
					isPreviewMode
						? 'Exit preview (show editable source)'
						: 'Preview with template variables resolved'
				}
				style={{
					color: isPreviewMode ? theme.colors.accent : theme.colors.textDim,
					borderColor: isPreviewMode ? theme.colors.accent : theme.colors.border,
				}}
			>
				{isPreviewMode ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
			</button>
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

	const renderEditorBody = useCallback(() => {
		return isPreviewMode ? (
			<textarea
				className="dual-pane-textarea dual-pane-textarea-preview"
				value={previewContent}
				readOnly
				spellCheck={false}
				style={{
					borderColor: theme.colors.accent,
					backgroundColor: theme.colors.bgMain,
					color: theme.colors.textMain,
				}}
			/>
		) : (
			<>
				<textarea
					ref={textareaRef}
					className="dual-pane-textarea"
					value={editedContent}
					onChange={autocomplete.handleChange}
					onKeyDown={(e) => {
						autocomplete.handleKeyDown(e);
					}}
					spellCheck={false}
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgMain,
						color: theme.colors.textMain,
					}}
				/>
				<TemplateAutocompleteDropdown
					ref={autocomplete.autocompleteRef}
					theme={theme}
					state={autocomplete.autocompleteState}
					onSelect={autocomplete.selectVariable}
				/>
			</>
		);
	}, [isPreviewMode, previewContent, editedContent, autocomplete, theme]);

	const header =
		!isEditorExpanded && !showHelp ? (
			<div className="prompts-tab-header">
				<div className="prompts-tab-header-text">
					<div className="text-xs font-bold opacity-70 uppercase mb-1">Core System Prompts</div>
					<p className="text-xs opacity-50">
						Customize the system prompts used by Maestro features. Changes take effect immediately.
						Use <code className="text-xs opacity-70">{'{{INCLUDE:name}}'}</code> to reference other
						prompt files.
					</p>
				</div>
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
			</div>
		) : null;

	return (
		<div className="maestro-prompts-settings-tab">
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
				emptyStateMessage="Select a prompt to edit"
				editorTitle={selectedPrompt?.id}
				editorDescription={selectedPrompt?.description}
				editorTokenCount={editorTokenCount}
				editorHeaderActions={editorHeaderActions}
				showModifiedBadge={selectedPrompt?.isModified}
				renderEditorBody={renderEditorBody}
				successMessage={successMessage}
				errorMessage={error}
				primaryAction={{
					label: isSaving ? 'Saving...' : 'Save',
					loading: isSaving,
					disabled: !hasUnsavedChanges,
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
