/**
 * Maestro Prompts Tab - Edit core system prompts
 *
 * Settings tab for browsing and editing core prompts.
 * Edits are saved to customizations file AND applied immediately in memory.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { Theme } from '../../../constants/themes';
import { refreshRendererPrompts } from '../../../services/promptInit';
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
}

// Category display names and order
const CATEGORY_INFO: Record<string, { label: string; order: number }> = {
	wizard: { label: 'Wizard', order: 1 },
	'inline-wizard': { label: 'Inline Wizard', order: 2 },
	autorun: { label: 'Auto Run', order: 3 },
	'group-chat': { label: 'Group Chat', order: 4 },
	context: { label: 'Context', order: 5 },
	commands: { label: 'Commands', order: 6 },
	system: { label: 'System', order: 7 },
};

export function MaestroPromptsTab({
	theme,
	initialSelectedPromptId,
}: MaestroPromptsTabProps): JSX.Element {
	const [prompts, setPrompts] = useState<CorePrompt[]>([]);
	const [selectedPrompt, setSelectedPrompt] = useState<CorePrompt | null>(null);
	const [editedContent, setEditedContent] = useState('');
	const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [isResetting, setIsResetting] = useState(false);
	const [successMessage, setSuccessMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Auto-dismiss success message after 3 seconds
	useEffect(() => {
		if (!successMessage) return;
		const timer = setTimeout(() => setSuccessMessage(null), 3000);
		return () => clearTimeout(timer);
	}, [successMessage]);

	// Load prompts on mount and select initial prompt (or first)
	useEffect(() => {
		(async () => {
			try {
				const result = await window.maestro.prompts.getAll();
				if (result.success && result.prompts) {
					setPrompts(result.prompts);
					const initial = initialSelectedPromptId
						? result.prompts.find((p) => p.id === initialSelectedPromptId)
						: undefined;
					const target = initial || result.prompts[0];
					if (target) {
						setSelectedPrompt(target);
						setEditedContent(target.content);
					}
				} else {
					setError(result.error || 'Failed to load prompts');
				}
			} catch (err) {
				setError(String(err));
			}
		})();
	}, []);

	// Group prompts by category
	const groupedPrompts = useMemo(() => {
		const groups: Record<string, CorePrompt[]> = {};
		for (const prompt of prompts) {
			if (!groups[prompt.category]) {
				groups[prompt.category] = [];
			}
			groups[prompt.category].push(prompt);
		}
		// Sort categories by order
		return Object.entries(groups).sort(([a], [b]) => {
			const orderA = CATEGORY_INFO[a]?.order ?? 99;
			const orderB = CATEGORY_INFO[b]?.order ?? 99;
			return orderA - orderB;
		});
	}, [prompts]);

	const handleSelectPrompt = useCallback(
		(prompt: CorePrompt) => {
			if (hasUnsavedChanges) {
				const discard = window.confirm('You have unsaved changes. Discard them?');
				if (!discard) return;
			}
			setSelectedPrompt(prompt);
			setEditedContent(prompt.content);
			setHasUnsavedChanges(false);
			setSuccessMessage(null);
		},
		[hasUnsavedChanges]
	);

	const handleContentChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			setEditedContent(e.target.value);
			setHasUnsavedChanges(e.target.value !== selectedPrompt?.content);
		},
		[selectedPrompt]
	);

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
				setError(result.error || 'Failed to reset prompt');
			}
		} catch (err) {
			setError(String(err));
		} finally {
			setIsResetting(false);
		}
	}, [selectedPrompt]);

	return (
		<div className="maestro-prompts-settings-tab">
			<div className="text-xs font-bold opacity-70 uppercase mb-3">Core System Prompts</div>
			<p className="text-xs opacity-50 mb-4">
				Customize the system prompts used by Maestro features. Changes take effect immediately.
			</p>

			<div className="prompts-split-view" style={{ borderColor: theme.colors.border }}>
				{/* Prompt List */}
				<div className="prompts-list" style={{ borderColor: theme.colors.border }}>
					{groupedPrompts.map(([category, categoryPrompts]) => (
						<div key={category} className="prompt-category">
							<div className="category-header" style={{ color: theme.colors.textDim }}>
								{CATEGORY_INFO[category]?.label || category}
							</div>
							{categoryPrompts.map((prompt) => (
								<button
									key={prompt.id}
									className={`prompt-item ${selectedPrompt?.id === prompt.id ? 'selected' : ''}`}
									onClick={() => handleSelectPrompt(prompt)}
									title={prompt.description}
									style={{
										backgroundColor:
											selectedPrompt?.id === prompt.id ? theme.colors.accent + '20' : 'transparent',
										color: theme.colors.textMain,
									}}
								>
									<span className="prompt-name">{prompt.id}</span>
									{prompt.isModified && (
										<span className="modified-indicator" style={{ color: theme.colors.accent }}>
											&bull;
										</span>
									)}
								</button>
							))}
						</div>
					))}
				</div>

				{/* Editor Panel */}
				<div className="prompt-editor">
					{selectedPrompt ? (
						<>
							<div className="editor-header">
								<h3 style={{ color: theme.colors.textMain }}>{selectedPrompt.id}</h3>
								<p className="prompt-description" style={{ color: theme.colors.textDim }}>
									{selectedPrompt.description}
								</p>
								{selectedPrompt.isModified && (
									<span className="modified-badge" style={{ backgroundColor: theme.colors.accent }}>
										Modified
									</span>
								)}
							</div>

							{successMessage && (
								<div
									className="success-message"
									style={{
										backgroundColor: theme.colors.success + '20',
										color: theme.colors.success,
									}}
								>
									{successMessage}
								</div>
							)}

							{error && (
								<div
									className="error-message"
									style={{
										backgroundColor: theme.colors.error + '20',
										color: theme.colors.error,
									}}
								>
									{error}
								</div>
							)}

							<textarea
								className="prompt-textarea"
								value={editedContent}
								onChange={handleContentChange}
								spellCheck={false}
								style={{
									borderColor: theme.colors.border,
									backgroundColor: theme.colors.bgMain,
									color: theme.colors.textMain,
								}}
							/>

							<div className="editor-actions">
								<button
									className="save-button"
									onClick={handleSave}
									disabled={!hasUnsavedChanges || isSaving}
									style={{
										backgroundColor: theme.colors.accent,
										color: theme.colors.accentForeground,
									}}
								>
									{isSaving ? 'Saving...' : 'Save'}
								</button>
								<button
									className="reset-button"
									onClick={handleReset}
									disabled={(!selectedPrompt.isModified && !hasUnsavedChanges) || isResetting}
									style={{
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
									}}
								>
									{isResetting ? 'Resetting...' : 'Reset to Default'}
								</button>
							</div>
						</>
					) : (
						<div className="no-selection" style={{ color: theme.colors.textDim }}>
							Select a prompt to edit
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
