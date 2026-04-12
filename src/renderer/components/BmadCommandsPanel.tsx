import { useState, useRef, useEffect } from 'react';
import {
	Edit2,
	Save,
	X,
	RotateCcw,
	RefreshCw,
	ExternalLink,
	ChevronDown,
	ChevronRight,
} from 'lucide-react';
import type { Theme, BmadCommand, BmadMetadata } from '../types';
import { useTemplateAutocomplete } from '../hooks';
import { captureException } from '../utils/sentry';
import { TemplateAutocompleteDropdown } from './TemplateAutocompleteDropdown';
import { openUrl } from '../utils/openUrl';

interface BmadCommandsPanelProps {
	theme: Theme;
}

interface EditingCommand {
	id: string;
	prompt: string;
}

export function BmadCommandsPanel({ theme }: BmadCommandsPanelProps) {
	const [commands, setCommands] = useState<BmadCommand[]>([]);
	const [metadata, setMetadata] = useState<BmadMetadata | null>(null);
	const [editingCommand, setEditingCommand] = useState<EditingCommand | null>(null);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [expandedCommands, setExpandedCommands] = useState<Set<string>>(new Set());
	const [isLoading, setIsLoading] = useState(true);

	const editCommandTextareaRef = useRef<HTMLTextAreaElement>(null);

	const {
		autocompleteState: editAutocompleteState,
		handleKeyDown: handleEditAutocompleteKeyDown,
		handleChange: handleEditAutocompleteChange,
		selectVariable: selectEditVariable,
		autocompleteRef: editAutocompleteRef,
	} = useTemplateAutocomplete({
		textareaRef: editCommandTextareaRef,
		value: editingCommand?.prompt ?? '',
		onChange: (value: string) => {
			if (editingCommand) {
				setEditingCommand({ ...editingCommand, prompt: value });
			}
		},
	});

	useEffect(() => {
		const loadData = async () => {
			try {
				const [promptsResult, metadataResult] = await Promise.all([
					window.maestro.bmad.getPrompts(),
					window.maestro.bmad.getMetadata(),
				]);

				if (promptsResult.success && promptsResult.commands) {
					setCommands(promptsResult.commands);
				}
				if (metadataResult.success && metadataResult.metadata) {
					setMetadata(metadataResult.metadata);
				}
			} catch (error) {
				captureException(error, { extra: { context: 'BmadCommandsPanel.loadData' } });
			} finally {
				setIsLoading(false);
			}
		};

		loadData();
	}, []);

	const handleSaveEdit = async () => {
		if (!editingCommand) return;

		try {
			const result = await window.maestro.bmad.savePrompt(editingCommand.id, editingCommand.prompt);
			if (result.success) {
				setCommands(
					commands.map((cmd) =>
						cmd.id === editingCommand.id
							? { ...cmd, prompt: editingCommand.prompt, isModified: true }
							: cmd
					)
				);
				setEditingCommand(null);
			}
		} catch (error) {
			captureException(error, { extra: { context: 'BmadCommandsPanel.handleSaveEdit' } });
		}
	};

	const handleReset = async (id: string) => {
		try {
			const result = await window.maestro.bmad.resetPrompt(id);
			if (result.success && result.prompt) {
				setCommands(
					commands.map((cmd) =>
						cmd.id === id ? { ...cmd, prompt: result.prompt!, isModified: false } : cmd
					)
				);
			}
		} catch (error) {
			captureException(error, { extra: { context: 'BmadCommandsPanel.handleReset' } });
		}
	};

	const handleRefresh = async () => {
		setIsRefreshing(true);
		try {
			const result = await window.maestro.bmad.refresh();
			if (result.success && result.metadata) {
				setMetadata(result.metadata);
				const promptsResult = await window.maestro.bmad.getPrompts();
				if (promptsResult.success && promptsResult.commands) {
					setCommands(promptsResult.commands);
				}
			}
		} catch (error) {
			captureException(error, { extra: { context: 'BmadCommandsPanel.handleRefresh' } });
		} finally {
			setIsRefreshing(false);
		}
	};

	const handleCancelEdit = () => {
		setEditingCommand(null);
	};

	const toggleExpanded = (id: string) => {
		const newExpanded = new Set(expandedCommands);
		if (newExpanded.has(id)) {
			newExpanded.delete(id);
		} else {
			newExpanded.add(id);
		}
		setExpandedCommands(newExpanded);
	};

	const formatDate = (isoDate: string) => {
		try {
			return new Date(isoDate).toLocaleDateString(undefined, {
				year: 'numeric',
				month: 'short',
				day: 'numeric',
			});
		} catch {
			return isoDate;
		}
	};

	if (isLoading) {
		return (
			<div className="space-y-4">
				<div>
					<label className="block text-xs font-bold opacity-70 uppercase mb-1">BMAD Commands</label>
					<p className="text-xs opacity-50" style={{ color: theme.colors.textDim }}>
						Loading BMAD commands...
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<div>
				<label className="block text-xs font-bold opacity-70 uppercase mb-1">BMAD Commands</label>
				<p className="text-xs opacity-50" style={{ color: theme.colors.textDim }}>
					Bundled commands from{' '}
					<button
						onClick={() => openUrl('https://github.com/bmad-code-org/BMAD-METHOD')}
						className="underline hover:opacity-80 inline-flex items-center gap-1"
						style={{
							color: theme.colors.accent,
							background: 'none',
							border: 'none',
							cursor: 'pointer',
							padding: 0,
						}}
					>
						bmad-code-org/BMAD-METHOD
						<ExternalLink className="w-2.5 h-2.5" />
					</button>{' '}
					for methodology-guided planning, delivery, and review workflows.
				</p>
			</div>

			{metadata && (
				<div
					className="flex items-center justify-between p-3 rounded-lg border"
					style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
				>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						<span>Version: </span>
						<span className="font-mono" style={{ color: theme.colors.textMain }}>
							{metadata.sourceVersion}
						</span>
						<span className="mx-2">•</span>
						<span>Updated: </span>
						<span style={{ color: theme.colors.textMain }}>
							{formatDate(metadata.lastRefreshed)}
						</span>
					</div>
					<button
						onClick={handleRefresh}
						disabled={isRefreshing}
						className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-all disabled:opacity-50"
						style={{
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textMain,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						<RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
						{isRefreshing ? 'Checking...' : 'Check for Updates'}
					</button>
				</div>
			)}

			<div className="space-y-2 max-h-[500px] overflow-y-auto pr-1 scrollbar-thin">
				{commands.map((cmd) => (
					<div
						key={cmd.id}
						className="rounded-lg border overflow-hidden"
						style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
					>
						{editingCommand?.id === cmd.id ? (
							<div className="p-3 space-y-3">
								<div className="flex items-center justify-between">
									<span
										className="font-mono font-bold text-sm"
										style={{ color: theme.colors.accent }}
									>
										{cmd.command}
									</span>
									<div className="flex items-center gap-1">
										<button
											onClick={handleCancelEdit}
											className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-all"
											style={{
												backgroundColor: theme.colors.bgActivity,
												color: theme.colors.textMain,
												border: `1px solid ${theme.colors.border}`,
											}}
										>
											<X className="w-3 h-3" />
											Cancel
										</button>
										<button
											onClick={handleSaveEdit}
											className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-all"
											style={{
												backgroundColor: theme.colors.success,
												color: '#000000',
											}}
										>
											<Save className="w-3 h-3" />
											Save
										</button>
									</div>
								</div>
								<div className="relative">
									<textarea
										ref={editCommandTextareaRef}
										value={editingCommand.prompt}
										onChange={handleEditAutocompleteChange}
										onKeyDown={(e) => {
											if (handleEditAutocompleteKeyDown(e)) {
												return;
											}
											if (e.key === 'Tab') {
												e.preventDefault();
												const textarea = e.currentTarget;
												const start = textarea.selectionStart;
												const end = textarea.selectionEnd;
												const value = textarea.value;
												const newValue = value.substring(0, start) + '\t' + value.substring(end);
												setEditingCommand({ ...editingCommand, prompt: newValue });
												setTimeout(() => {
													textarea.selectionStart = textarea.selectionEnd = start + 1;
												}, 0);
											}
										}}
										rows={15}
										className="w-full p-2 rounded border bg-transparent outline-none text-sm resize-y scrollbar-thin min-h-[300px] font-mono"
										style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
									/>
									<TemplateAutocompleteDropdown
										ref={editAutocompleteRef}
										theme={theme}
										state={editAutocompleteState}
										onSelect={selectEditVariable}
									/>
								</div>
							</div>
						) : (
							<>
								<button
									onClick={() => toggleExpanded(cmd.id)}
									className="w-full px-3 py-2.5 flex items-center justify-between hover:bg-white/5 transition-colors"
								>
									<div className="flex items-center gap-2">
										{expandedCommands.has(cmd.id) ? (
											<ChevronDown
												className="w-3.5 h-3.5"
												style={{ color: theme.colors.textDim }}
											/>
										) : (
											<ChevronRight
												className="w-3.5 h-3.5"
												style={{ color: theme.colors.textDim }}
											/>
										)}
										<span
											className="font-mono font-bold text-sm"
											style={{ color: theme.colors.accent }}
										>
											{cmd.command}
										</span>
										{cmd.isModified && (
											<span
												className="px-1.5 py-0.5 rounded text-[10px] font-medium"
												style={{
													backgroundColor: `color-mix(in srgb, ${theme.colors.warning} 12.5%, transparent)`,
													color: theme.colors.warning,
												}}
											>
												Modified
											</span>
										)}
									</div>
									<span
										className="text-xs truncate max-w-[300px]"
										style={{ color: theme.colors.textDim }}
									>
										{cmd.description}
									</span>
								</button>
								{expandedCommands.has(cmd.id) && (
									<div
										className="px-3 pb-3 pt-1 border-t"
										style={{ borderColor: theme.colors.border }}
									>
										<div className="flex items-center justify-end gap-1 mb-2">
											{cmd.isModified && (
												<button
													onClick={() => handleReset(cmd.id)}
													className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-all hover:bg-white/10"
													style={{ color: theme.colors.textDim }}
													title="Reset to bundled default"
												>
													<RotateCcw className="w-3 h-3" />
													Reset
												</button>
											)}
											<button
												onClick={() => setEditingCommand({ id: cmd.id, prompt: cmd.prompt })}
												className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-all hover:bg-white/10"
												style={{ color: theme.colors.textDim }}
											>
												<Edit2 className="w-3 h-3" />
												Edit
											</button>
										</div>
										<pre
											className="text-xs whitespace-pre-wrap font-mono max-h-[400px] overflow-y-auto scrollbar-thin p-3 rounded"
											style={{
												backgroundColor: theme.colors.bgActivity,
												color: theme.colors.textMain,
											}}
										>
											{cmd.prompt}
										</pre>
									</div>
								)}
							</>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
