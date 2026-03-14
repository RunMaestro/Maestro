// ABOUTME: Maestro Prompts Tab - browse and edit core system prompts in the Right Bar.
// ABOUTME: Follows the SpecKitCommandsPanel UI pattern with category grouping and inline editing.

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Save, RotateCcw, ChevronDown, ChevronRight } from 'lucide-react';
import type { Theme } from '../types';
import type { CorePromptEntry } from '../../main/preload/prompts';
import { reloadRendererPrompts } from '../services/promptInit';

interface MaestroPromptsTabProps {
	theme: Theme;
}

// Category display names and sort order
const CATEGORY_INFO: Record<string, { label: string; order: number }> = {
	wizard: { label: 'Wizard', order: 1 },
	'inline-wizard': { label: 'Inline Wizard', order: 2 },
	autorun: { label: 'Auto Run', order: 3 },
	'group-chat': { label: 'Group Chat', order: 4 },
	context: { label: 'Context', order: 5 },
	commands: { label: 'Commands', order: 6 },
	system: { label: 'System', order: 7 },
};

export function MaestroPromptsTab({ theme }: MaestroPromptsTabProps) {
	const [prompts, setPrompts] = useState<CorePromptEntry[]>([]);
	const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
	const [editedContent, setEditedContent] = useState('');
	const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [isResetting, setIsResetting] = useState(false);
	const [isLoading, setIsLoading] = useState(true);
	const [successMessage, setSuccessMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

	const selectedPrompt = useMemo(
		() => prompts.find((p) => p.id === selectedPromptId) ?? null,
		[prompts, selectedPromptId]
	);

	// Load prompts on mount
	useEffect(() => {
		const loadPrompts = async () => {
			setIsLoading(true);
			try {
				const result = await window.maestro.prompts.getAll();
				if (result.success && result.prompts) {
					setPrompts(result.prompts);
					// Expand all categories by default
					const categories = new Set(result.prompts.map((p) => p.category));
					setExpandedCategories(categories);
					// Select first prompt if none selected
					if (result.prompts.length > 0) {
						const first = result.prompts[0];
						setSelectedPromptId(first.id);
						setEditedContent(first.content);
					}
				} else {
					setError(result.error || 'Failed to load prompts');
				}
			} catch (err) {
				setError(String(err));
			} finally {
				setIsLoading(false);
			}
		};

		loadPrompts();
	}, []);

	// Group prompts by category, sorted
	const groupedPrompts = useMemo(() => {
		const groups: Record<string, CorePromptEntry[]> = {};
		for (const prompt of prompts) {
			if (!groups[prompt.category]) {
				groups[prompt.category] = [];
			}
			groups[prompt.category].push(prompt);
		}
		return Object.entries(groups).sort(([a], [b]) => {
			const orderA = CATEGORY_INFO[a]?.order ?? 99;
			const orderB = CATEGORY_INFO[b]?.order ?? 99;
			return orderA - orderB;
		});
	}, [prompts]);

	const toggleCategory = useCallback((category: string) => {
		setExpandedCategories((prev) => {
			const next = new Set(prev);
			if (next.has(category)) {
				next.delete(category);
			} else {
				next.add(category);
			}
			return next;
		});
	}, []);

	const handleSelectPrompt = useCallback(
		(prompt: CorePromptEntry) => {
			if (
				hasUnsavedChanges &&
				selectedPromptId !== prompt.id &&
				!window.confirm('Discard unsaved changes to the current prompt?')
			) {
				return;
			}
			setSelectedPromptId(prompt.id);
			setEditedContent(prompt.content);
			setHasUnsavedChanges(false);
			setSuccessMessage(null);
			setError(null);
		},
		[hasUnsavedChanges, selectedPromptId]
	);

	const handleContentChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			setEditedContent(e.target.value);
			setHasUnsavedChanges(e.target.value !== selectedPrompt?.content);
			setSuccessMessage(null);
		},
		[selectedPrompt]
	);

	const handleSave = useCallback(async () => {
		if (!selectedPrompt || !hasUnsavedChanges) return;

		setIsSaving(true);
		setError(null);
		setSuccessMessage(null);
		try {
			const result = await window.maestro.prompts.save(selectedPrompt.id, editedContent);
			if (result.success) {
				let reloadError: string | null = null;
				try {
					await reloadRendererPrompts();
				} catch (err) {
					reloadError = String(err);
				}

				setPrompts((prev) =>
					prev.map((p) =>
						p.id === selectedPrompt.id ? { ...p, content: editedContent, isModified: true } : p
					)
				);
				setHasUnsavedChanges(false);
				setSuccessMessage(
					reloadError ? 'Changes saved (runtime cache refresh failed)' : 'Changes saved and applied'
				);
				if (reloadError) {
					setError(reloadError);
				}
			} else {
				setError(result.error || 'Failed to save prompt');
			}
		} catch (err) {
			setError(String(err));
		} finally {
			setIsSaving(false);
		}
	}, [selectedPrompt, editedContent, hasUnsavedChanges]);

	const handleReset = useCallback(async () => {
		if (!selectedPrompt) return;

		setIsResetting(true);
		setError(null);
		setSuccessMessage(null);
		try {
			const result = await window.maestro.prompts.reset(selectedPrompt.id);
			if (result.success && result.content !== undefined) {
				let reloadError: string | null = null;
				try {
					await reloadRendererPrompts();
				} catch (err) {
					reloadError = String(err);
				}

				setPrompts((prev) =>
					prev.map((p) =>
						p.id === selectedPrompt.id
							? { ...p, content: result.content!, isModified: false }
							: p
					)
				);
				setEditedContent(result.content);
				setHasUnsavedChanges(false);
				setSuccessMessage(
					reloadError
						? 'Prompt reset (runtime cache refresh failed)'
						: 'Prompt reset to default'
				);
				if (reloadError) {
					setError(reloadError);
				}
			} else {
				setError(result.error || 'Failed to reset prompt');
			}
		} catch (err) {
			setError(String(err));
		} finally {
			setIsResetting(false);
		}
	}, [selectedPrompt]);

	if (isLoading) {
		return (
			<div
				className="flex items-center justify-center h-full"
				style={{ color: theme.colors.textDim }}
			>
				<span className="text-sm">Loading prompts...</span>
			</div>
		);
	}

	if (error && prompts.length === 0) {
		return (
			<div
				className="flex items-center justify-center h-full"
				style={{
					color: theme.colors.error,
					fontSize: '13px',
					padding: '16px',
				}}
			>
				{error}
			</div>
		);
	}

	return (
		<div className="flex h-full" style={{ gap: '0' }}>
			{/* Prompt List - Left side */}
			<div
				className="overflow-y-auto scrollbar-thin"
				style={{
					width: '180px',
					minWidth: '180px',
					borderRight: `1px solid ${theme.colors.border}`,
					paddingTop: '8px',
					paddingBottom: '8px',
				}}
			>
				{groupedPrompts.map(([category, categoryPrompts]) => (
					<div key={category} style={{ marginBottom: '4px' }}>
						<button
							className="flex items-center gap-1 w-full border-none bg-transparent cursor-pointer"
							style={{
								padding: '4px 12px',
								fontSize: '11px',
								fontWeight: 600,
								textTransform: 'uppercase' as const,
								color: theme.colors.textDim,
								letterSpacing: '0.5px',
							}}
							onClick={() => toggleCategory(category)}
						>
							{expandedCategories.has(category) ? (
								<ChevronDown className="w-3 h-3" />
							) : (
								<ChevronRight className="w-3 h-3" />
							)}
							{CATEGORY_INFO[category]?.label || category}
						</button>
						{expandedCategories.has(category) &&
							categoryPrompts.map((prompt) => (
								<button
									key={prompt.id}
									className="flex items-center justify-between w-full border-none cursor-pointer transition-colors"
									style={{
										padding: '5px 12px 5px 24px',
										fontSize: '12px',
										textAlign: 'left' as const,
										color:
											selectedPromptId === prompt.id
												? theme.colors.textMain
												: theme.colors.textDim,
										backgroundColor:
											selectedPromptId === prompt.id
												? theme.colors.bgActivity
												: 'transparent',
									}}
									onClick={() => handleSelectPrompt(prompt)}
									title={prompt.description}
								>
									<span
										style={{
											overflow: 'hidden',
											textOverflow: 'ellipsis',
											whiteSpace: 'nowrap' as const,
										}}
									>
										{prompt.id}
									</span>
									{prompt.isModified && (
										<span
											style={{
												color: theme.colors.warning,
												fontSize: '16px',
												lineHeight: '1',
												marginLeft: '4px',
											}}
										>
											&bull;
										</span>
									)}
								</button>
							))}
					</div>
				))}
			</div>

			{/* Editor Panel - Right side */}
			<div
				className="flex-1 flex flex-col overflow-hidden"
				style={{ padding: '16px' }}
			>
				{selectedPrompt ? (
					<>
						{/* Header */}
						<div style={{ marginBottom: '12px' }}>
							<h3
								style={{
									margin: '0 0 4px 0',
									fontSize: '14px',
									fontWeight: 600,
									color: theme.colors.textMain,
								}}
							>
								{selectedPrompt.id}
							</h3>
							<p
								style={{
									margin: 0,
									fontSize: '12px',
									color: theme.colors.textDim,
								}}
							>
								{selectedPrompt.description}
							</p>
							{selectedPrompt.isModified && (
								<span
									style={{
										display: 'inline-block',
										marginTop: '8px',
										padding: '2px 8px',
										backgroundColor: theme.colors.warning,
										color: 'white',
										fontSize: '10px',
										fontWeight: 600,
										borderRadius: '4px',
										textTransform: 'uppercase' as const,
									}}
								>
									Modified
								</span>
							)}
						</div>

						{/* Success / Error messages */}
						{successMessage && (
							<div
								style={{
									padding: '8px 12px',
									marginBottom: '12px',
									backgroundColor: theme.colors.success + '20',
									color: theme.colors.success,
									borderRadius: '4px',
									fontSize: '12px',
								}}
							>
								{successMessage}
							</div>
						)}
						{error && (
							<div
								style={{
									padding: '8px 12px',
									marginBottom: '12px',
									backgroundColor: theme.colors.error + '20',
									color: theme.colors.error,
									borderRadius: '4px',
									fontSize: '12px',
								}}
							>
								{error}
							</div>
						)}

						{/* Textarea editor */}
						<textarea
							className="flex-1 scrollbar-thin"
							value={editedContent}
							onChange={handleContentChange}
							spellCheck={false}
							style={{
								width: '100%',
								padding: '12px',
								border: `1px solid ${theme.colors.border}`,
								borderRadius: '4px',
								backgroundColor: theme.colors.bgMain,
								color: theme.colors.textMain,
								fontFamily: "'Monaco', 'Menlo', 'Consolas', monospace",
								fontSize: '12px',
								lineHeight: '1.5',
								resize: 'none' as const,
								outline: 'none',
							}}
						/>

						{/* Action buttons */}
						<div
							className="flex gap-2"
							style={{ marginTop: '12px', flexShrink: 0 }}
						>
							<button
								className="flex items-center gap-1 transition-opacity"
								style={{
									padding: '8px 16px',
									border: 'none',
									borderRadius: '4px',
									fontSize: '12px',
									fontWeight: 500,
									cursor: hasUnsavedChanges && !isSaving ? 'pointer' : 'not-allowed',
									backgroundColor: theme.colors.success,
									color: 'white',
									opacity: hasUnsavedChanges && !isSaving ? 1 : 0.5,
								}}
								onClick={handleSave}
								disabled={!hasUnsavedChanges || isSaving}
							>
								<Save className="w-3 h-3" />
								{isSaving ? 'Saving...' : 'Save'}
							</button>
							<button
								className="flex items-center gap-1 transition-opacity"
								style={{
									padding: '8px 16px',
									border: `1px solid ${theme.colors.border}`,
									borderRadius: '4px',
									fontSize: '12px',
									fontWeight: 500,
									cursor:
										selectedPrompt.isModified && !isResetting
											? 'pointer'
											: 'not-allowed',
									backgroundColor: 'transparent',
									color: theme.colors.textMain,
									opacity: selectedPrompt.isModified && !isResetting ? 1 : 0.5,
								}}
								onClick={handleReset}
								disabled={!selectedPrompt.isModified || isResetting}
							>
								<RotateCcw className="w-3 h-3" />
								{isResetting ? 'Resetting...' : 'Reset to Default'}
							</button>
						</div>
					</>
				) : (
					<div
						className="flex items-center justify-center h-full"
						style={{ color: theme.colors.textDim, fontSize: '13px' }}
					>
						Select a prompt to edit
					</div>
				)}
			</div>
		</div>
	);
}
