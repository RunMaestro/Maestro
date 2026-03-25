import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
	X,
	PenLine,
	Send,
	ImageIcon,
	History,
	Eye,
	Keyboard,
	Brain,
	Pin,
	Users,
} from 'lucide-react';
import type { Theme, ThinkingMode, Session, Group } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { estimateTokenCount } from '../../shared/formatters';
import {
	formatShortcutKeys,
	formatEnterToSend,
	formatEnterToSendTooltip,
} from '../utils/shortcutFormatter';
import { normalizeMentionName } from '../utils/participantColors';

const EMPTY_STAGED_IMAGES: string[] = [];

/** Union type for items shown in the @ mention dropdown */
type MentionItem =
	| { type: 'agent'; name: string; mentionName: string; agentId: string; sessionId: string }
	| {
			type: 'group';
			group: Group;
			mentionName: string;
			memberCount: number;
			memberMentions: string[];
	  };

interface PromptComposerModalProps {
	isOpen: boolean;
	onClose: () => void;
	theme: Theme;
	initialValue: string;
	onSubmit: (value: string) => void;
	onSend: (value: string) => void;
	sessionName?: string;
	// Image attachment props
	stagedImages?: string[];
	setStagedImages?: React.Dispatch<React.SetStateAction<string[]>>;
	onImageAttachBlocked?: () => void;
	onOpenLightbox?: (image: string, contextImages?: string[], source?: 'staged' | 'history') => void;
	// Bottom bar toggles
	tabSaveToHistory?: boolean;
	onToggleTabSaveToHistory?: () => void;
	tabReadOnlyMode?: boolean;
	onToggleTabReadOnlyMode?: () => void;
	tabShowThinking?: ThinkingMode;
	onToggleTabShowThinking?: () => void;
	supportsThinking?: boolean;
	enterToSend?: boolean;
	onToggleEnterToSend?: () => void;
	// @mention autocomplete (group chat mode)
	sessions?: Session[];
	groups?: Group[];
}

export function PromptComposerModal({
	isOpen,
	onClose,
	theme,
	initialValue,
	onSubmit,
	onSend,
	sessionName = 'Claude',
	stagedImages = EMPTY_STAGED_IMAGES,
	setStagedImages,
	onImageAttachBlocked,
	onOpenLightbox,
	tabSaveToHistory = false,
	onToggleTabSaveToHistory,
	tabReadOnlyMode = false,
	onToggleTabReadOnlyMode,
	tabShowThinking = 'off',
	onToggleTabShowThinking,
	supportsThinking = false,
	enterToSend = false,
	onToggleEnterToSend,
	sessions,
	groups,
}: PromptComposerModalProps) {
	const [value, setValue] = useState('');
	const [showMentions, setShowMentions] = useState(false);
	const [mentionFilter, setMentionFilter] = useState('');
	const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const mentionListRef = useRef<HTMLDivElement>(null);
	const selectedMentionRef = useRef<HTMLButtonElement>(null);
	const { registerLayer, unregisterLayer } = useLayerStack();
	const hasMentions = sessions != null && sessions.length > 0;
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const onSubmitRef = useRef(onSubmit);
	onSubmitRef.current = onSubmit;
	const onSendRef = useRef(onSend);
	onSendRef.current = onSend;
	const valueRef = useRef(value);
	valueRef.current = value;
	const showMentionsRef = useRef(showMentions);
	showMentionsRef.current = showMentions;

	// Sync value when modal opens with new initialValue
	useEffect(() => {
		if (isOpen) {
			setValue(initialValue);
			setShowMentions(false);
		}
	}, [isOpen, initialValue]);

	// Focus textarea when modal opens
	useEffect(() => {
		if (isOpen && textareaRef.current) {
			textareaRef.current.focus();
			// Move cursor to end
			textareaRef.current.selectionStart = textareaRef.current.value.length;
			textareaRef.current.selectionEnd = textareaRef.current.value.length;
		}
	}, [isOpen]);

	// Register with layer stack for Escape handling
	useEffect(() => {
		if (isOpen) {
			const id = registerLayer({
				type: 'modal',
				priority: MODAL_PRIORITIES.PROMPT_COMPOSER,
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'strict',
				onEscape: () => {
					// If mention dropdown is open, close it instead of the modal
					if (showMentionsRef.current) {
						setShowMentions(false);
						return;
					}
					// Save the current value back before closing
					onSubmitRef.current(valueRef.current);
					onCloseRef.current();
				},
			});
			return () => unregisterLayer(id);
		}
	}, [isOpen, registerLayer, unregisterLayer]);

	// Build mentionable items from sessions and groups (same logic as GroupChatInput)
	const mentionItems = useMemo(() => {
		if (!sessions) return [];
		const items: MentionItem[] = [];
		if (groups) {
			for (const group of groups) {
				const members = sessions.filter((s) => s.groupId === group.id && s.toolType !== 'terminal');
				if (members.length > 0) {
					items.push({
						type: 'group',
						group,
						mentionName: normalizeMentionName(group.name),
						memberCount: members.length,
						memberMentions: members.map((m) => `@${normalizeMentionName(m.name)}`),
					});
				}
			}
		}
		for (const s of sessions) {
			if (s.toolType !== 'terminal') {
				items.push({
					type: 'agent',
					name: s.name,
					mentionName: normalizeMentionName(s.name),
					agentId: s.toolType,
					sessionId: s.id,
				});
			}
		}
		return items;
	}, [sessions, groups]);

	const filteredMentions = useMemo(() => {
		if (!mentionFilter) return mentionItems;
		return mentionItems.filter((item) => {
			if (item.type === 'group') {
				return (
					item.group.name.toLowerCase().includes(mentionFilter) ||
					item.mentionName.toLowerCase().includes(mentionFilter)
				);
			}
			return (
				item.name.toLowerCase().includes(mentionFilter) ||
				item.mentionName.toLowerCase().includes(mentionFilter)
			);
		});
	}, [mentionItems, mentionFilter]);

	// Scroll selected mention into view
	useEffect(() => {
		if (showMentions) {
			requestAnimationFrame(() => {
				if (selectedMentionRef.current) {
					selectedMentionRef.current.scrollIntoView({
						block: 'nearest',
						behavior: 'smooth',
					});
				}
			});
		}
	}, [selectedMentionIndex, showMentions]);

	const insertMention = useCallback(
		(item: MentionItem) => {
			const lastAtIndex = value.lastIndexOf('@');
			const prefix = value.slice(0, lastAtIndex);
			let insertion: string;
			if (item.type === 'group') {
				insertion = item.memberMentions.join(' ') + ' ';
			} else {
				insertion = `@${item.mentionName} `;
			}
			const newValue = prefix + insertion;
			setValue(newValue);
			// Persist the draft so the mention survives an abrupt modal close
			onSubmitRef.current(newValue);
			setShowMentions(false);
			textareaRef.current?.focus();
		},
		[value]
	);

	const handleValueChange = useCallback(
		(newValue: string) => {
			setValue(newValue);

			if (!hasMentions) return;

			// Check for @mention trigger
			const lastAtIndex = newValue.lastIndexOf('@');
			if (lastAtIndex !== -1 && lastAtIndex === newValue.length - 1) {
				setShowMentions(true);
				setMentionFilter('');
				setSelectedMentionIndex(0);
			} else if (lastAtIndex !== -1) {
				const afterAt = newValue.slice(lastAtIndex + 1);
				if (!/\s/.test(afterAt)) {
					setShowMentions(true);
					setMentionFilter(afterAt.toLowerCase());
					setSelectedMentionIndex(0);
				} else {
					setShowMentions(false);
				}
			} else {
				setShowMentions(false);
			}
		},
		[hasMentions]
	);

	if (!isOpen) return null;

	const handleSend = () => {
		if (!value.trim()) return;
		onSend(value);
		onClose();
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		// Handle mention dropdown navigation
		if (showMentions && filteredMentions.length > 0) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				setSelectedMentionIndex((prev) => (prev < filteredMentions.length - 1 ? prev + 1 : 0));
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				setSelectedMentionIndex((prev) => (prev > 0 ? prev - 1 : filteredMentions.length - 1));
				return;
			}
			if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey)) {
				e.preventDefault();
				insertMention(filteredMentions[selectedMentionIndex]);
				return;
			}
		}

		// Cmd/Ctrl + Enter to send the message
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			handleSend();
			return;
		}

		// Tab key inserts a tab character instead of moving focus
		if (e.key === 'Tab') {
			e.preventDefault();
			const textarea = e.currentTarget;
			const start = textarea.selectionStart;
			const end = textarea.selectionEnd;
			const newValue = value.substring(0, start) + '\t' + value.substring(end);
			handleValueChange(newValue);
			// Restore cursor position after the tab
			requestAnimationFrame(() => {
				textarea.selectionStart = start + 1;
				textarea.selectionEnd = start + 1;
			});
			return;
		}

		// Cmd/Ctrl + Shift + L to open lightbox (if images are staged)
		if (e.key === 'l' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
			e.preventDefault();
			if (stagedImages.length > 0 && onOpenLightbox) {
				onOpenLightbox(stagedImages[0], stagedImages, 'staged');
			}
			return;
		}

		// Cmd/Ctrl + S to toggle Save to History
		if (e.key === 's' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
			e.preventDefault();
			onToggleTabSaveToHistory?.();
			return;
		}

		// Cmd/Ctrl + R to toggle Read-only mode
		if (e.key === 'r' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
			e.preventDefault();
			onToggleTabReadOnlyMode?.();
			return;
		}
	};

	// Handle paste for images and text (with whitespace trimming)
	const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
		const items = e.clipboardData.items;
		const hasImage = Array.from(items).some((item) => item.type.startsWith('image/'));

		// Handle text paste with whitespace trimming (when no images)
		if (!hasImage) {
			const text = e.clipboardData.getData('text/plain');
			if (text) {
				const trimmedText = text.trim();
				// Only intercept if trimming actually changed the text
				if (trimmedText !== text) {
					e.preventDefault();
					const target = e.target as HTMLTextAreaElement;
					const start = target.selectionStart ?? 0;
					const end = target.selectionEnd ?? 0;
					const currentValue = target.value;
					const pastedValue = currentValue.slice(0, start) + trimmedText + currentValue.slice(end);
					handleValueChange(pastedValue);
					// Set cursor position after the pasted text
					requestAnimationFrame(() => {
						target.selectionStart = target.selectionEnd = start + trimmedText.length;
					});
				}
			}
			return;
		}

		if (!setStagedImages) {
			if (hasImage) {
				e.preventDefault();
				onImageAttachBlocked?.();
			}
			return;
		}

		for (let i = 0; i < items.length; i++) {
			if (items[i].type.indexOf('image') !== -1) {
				e.preventDefault();
				const blob = items[i].getAsFile();
				if (blob) {
					const reader = new FileReader();
					reader.onload = (event) => {
						if (event.target?.result) {
							setStagedImages((prev) => [...prev, event.target!.result as string]);
						}
					};
					reader.readAsDataURL(blob);
				}
			}
		}
	};

	// Handle file input change for image attachment
	const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		if (!setStagedImages) return;

		const files = Array.from(e.target.files || []);
		files.forEach((file) => {
			const reader = new FileReader();
			reader.onload = (event) => {
				if (event.target?.result) {
					setStagedImages((prev) => [...prev, event.target!.result as string]);
				}
			};
			reader.readAsDataURL(file);
		});
		e.target.value = '';
	};

	const tokenCount = estimateTokenCount(value);

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center"
			style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}
			onClick={() => {
				onSubmit(value);
				onClose();
			}}
		>
			<button
				type="button"
				className="absolute inset-0"
				tabIndex={-1}
				onClick={(e) => {
					e.stopPropagation();
					onSubmit(value);
					onClose();
				}}
				aria-label="Close prompt composer"
			/>
			<div
				className="relative z-10 w-[90vw] h-[80vh] max-w-5xl rounded-xl border shadow-2xl flex flex-col overflow-hidden"
				onClick={(e) => e.stopPropagation()}
				style={{
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.border,
				}}
			>
				{/* Header */}
				<div
					className="flex items-center justify-between px-4 py-3 border-b"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
				>
					<div className="flex items-center gap-2">
						<PenLine className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<span className="font-medium" style={{ color: theme.colors.textMain }}>
							Prompt Composer
						</span>
						<span className="text-sm opacity-60" style={{ color: theme.colors.textDim }}>
							— {sessionName}
						</span>
					</div>
					<div className="flex items-center gap-3">
						<button
							onClick={() => {
								onSubmit(value);
								onClose();
							}}
							className="p-1.5 rounded hover:bg-white/10 transition-colors"
							title="Close (Escape)"
						>
							<X className="w-5 h-5" style={{ color: theme.colors.textDim }} />
						</button>
					</div>
				</div>

				{/* Staged Images Thumbnails */}
				{stagedImages.length > 0 && (
					<div
						className="flex gap-2 px-4 py-3 overflow-x-auto overflow-y-visible scrollbar-thin border-b"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
					>
						{stagedImages.map((img, idx) => (
							<div key={img} className="relative group shrink-0">
								<img
									src={img}
									alt={`Prompt composer staged image ${idx + 1}`}
									className="h-16 rounded border cursor-pointer hover:opacity-80 transition-opacity"
									style={{
										borderColor: theme.colors.border,
										objectFit: 'contain',
										maxWidth: '200px',
									}}
									role="button"
									tabIndex={0}
									onClick={() => onOpenLightbox?.(img, stagedImages, 'staged')}
									onKeyDown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											onOpenLightbox?.(img, stagedImages, 'staged');
										}
									}}
									title={`Click to view (${formatShortcutKeys(['Meta', 'Shift', 'l'])})`}
								/>
								{setStagedImages && (
									<button
										onClick={(e) => {
											e.stopPropagation();
											setStagedImages((prev) => prev.filter((_, i) => i !== idx));
										}}
										className="absolute top-0.5 right-0.5 bg-red-500 text-white rounded-full p-1 shadow-md hover:bg-red-600 transition-colors opacity-90 hover:opacity-100"
									>
										<X className="w-3 h-3" />
									</button>
								)}
							</div>
						))}
					</div>
				)}

				{/* Textarea */}
				<div className="flex-1 p-4 overflow-hidden relative flex flex-col">
					{/* Mention dropdown (positioned above textarea) */}
					{showMentions && filteredMentions.length > 0 && (
						<div
							ref={mentionListRef}
							className="rounded-lg border p-1 max-h-48 overflow-y-auto mb-2 shrink-0"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								borderColor: theme.colors.border,
							}}
						>
							{filteredMentions.map((item, index) => (
								<button
									key={item.type === 'group' ? `group-${item.group.id}` : item.sessionId}
									ref={index === selectedMentionIndex ? selectedMentionRef : null}
									onClick={() => insertMention(item)}
									className="w-full text-left px-3 py-1.5 rounded text-sm transition-colors flex items-center gap-2"
									style={{
										color: theme.colors.textMain,
										backgroundColor:
											index === selectedMentionIndex ? `${theme.colors.accent}20` : 'transparent',
									}}
								>
									{item.type === 'group' ? (
										<>
											<Users
												className="w-3.5 h-3.5 shrink-0"
												style={{ color: theme.colors.accent }}
											/>
											<span>{item.group.emoji}</span>
											<span>@{item.mentionName}</span>
											<span
												className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full"
												style={{
													backgroundColor: `${theme.colors.accent}20`,
													color: theme.colors.accent,
												}}
											>
												group · {item.memberCount}
											</span>
										</>
									) : (
										<>
											<span>@{item.mentionName}</span>
											{item.name !== item.mentionName && (
												<span className="text-xs" style={{ color: theme.colors.textDim }}>
													({item.name})
												</span>
											)}
											<span className="ml-auto text-xs" style={{ color: theme.colors.textDim }}>
												{item.agentId}
											</span>
										</>
									)}
								</button>
							))}
						</div>
					)}
					<textarea
						ref={textareaRef}
						value={value}
						onChange={(e) => handleValueChange(e.target.value)}
						onKeyDown={handleKeyDown}
						onPaste={handlePaste}
						className="w-full h-full bg-transparent resize-none outline-none text-base leading-relaxed scrollbar-thin"
						style={{ color: theme.colors.textMain }}
						placeholder={
							hasMentions
								? 'Write your prompt here... (@ to mention agent)'
								: 'Write your prompt here...'
						}
					/>
				</div>

				{/* Footer */}
				<div
					className="flex items-center justify-between px-4 py-3 border-t"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
				>
					{/* Left side: stats and image button */}
					<div className="flex items-center gap-3">
						{/* Image attachment button */}
						{setStagedImages && (
							<>
								<button
									onClick={() => fileInputRef.current?.click()}
									className="p-1.5 rounded hover:bg-white/10 transition-colors opacity-60 hover:opacity-100"
									title="Attach Image"
								>
									<ImageIcon className="w-4 h-4" style={{ color: theme.colors.textDim }} />
								</button>
								<input
									ref={fileInputRef}
									type="file"
									accept="image/*"
									multiple
									className="hidden"
									onChange={handleFileInputChange}
								/>
							</>
						)}
						<div
							className="text-xs flex items-center gap-3"
							style={{ color: theme.colors.textDim }}
						>
							<span>{value.length} characters</span>
							<span>~{tokenCount.toLocaleString('en-US')} tokens</span>
						</div>
					</div>

					{/* Right side: toggles and send button */}
					<div className="flex items-center gap-2">
						{/* Save to History toggle */}
						{onToggleTabSaveToHistory && (
							<button
								onClick={onToggleTabSaveToHistory}
								className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-all ${
									tabSaveToHistory ? '' : 'opacity-40 hover:opacity-70'
								}`}
								style={{
									backgroundColor: tabSaveToHistory ? `${theme.colors.accent}25` : 'transparent',
									color: tabSaveToHistory ? theme.colors.accent : theme.colors.textDim,
									border: tabSaveToHistory
										? `1px solid ${theme.colors.accent}50`
										: '1px solid transparent',
								}}
								title={`Save to History (${formatShortcutKeys(['Meta', 's'])}) - Synopsis added after each completion`}
							>
								<History className="w-3 h-3" />
								<span>History</span>
							</button>
						)}

						{/* Read-only mode toggle */}
						{onToggleTabReadOnlyMode && (
							<button
								onClick={onToggleTabReadOnlyMode}
								className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-all ${
									tabReadOnlyMode ? '' : 'opacity-40 hover:opacity-70'
								}`}
								style={{
									backgroundColor: tabReadOnlyMode ? `${theme.colors.warning}25` : 'transparent',
									color: tabReadOnlyMode ? theme.colors.warning : theme.colors.textDim,
									border: tabReadOnlyMode
										? `1px solid ${theme.colors.warning}50`
										: '1px solid transparent',
								}}
								title="Toggle read-only mode (Claude won't modify files)"
							>
								<Eye className="w-3 h-3" />
								<span>Read-only</span>
							</button>
						)}

						{/* Show Thinking toggle - three states: 'off' | 'on' | 'sticky' */}
						{supportsThinking && onToggleTabShowThinking && (
							<button
								onClick={onToggleTabShowThinking}
								className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-all ${
									tabShowThinking !== 'off' ? '' : 'opacity-40 hover:opacity-70'
								}`}
								style={{
									backgroundColor:
										tabShowThinking === 'sticky'
											? `${theme.colors.warning}30`
											: tabShowThinking === 'on'
												? `${theme.colors.accentText}25`
												: 'transparent',
									color:
										tabShowThinking === 'sticky'
											? theme.colors.warning
											: tabShowThinking === 'on'
												? theme.colors.accentText
												: theme.colors.textDim,
									border:
										tabShowThinking === 'sticky'
											? `1px solid ${theme.colors.warning}50`
											: tabShowThinking === 'on'
												? `1px solid ${theme.colors.accentText}50`
												: '1px solid transparent',
								}}
								title={
									tabShowThinking === 'off'
										? 'Show Thinking - Click to stream AI reasoning'
										: tabShowThinking === 'on'
											? 'Thinking (temporary) - Click for sticky mode'
											: 'Thinking (sticky) - Click to turn off'
								}
							>
								<Brain className="w-3 h-3" />
								<span>Thinking</span>
								{tabShowThinking === 'sticky' && <Pin className="w-2.5 h-2.5" />}
							</button>
						)}

						{/* Enter to send toggle */}
						{onToggleEnterToSend && (
							<button
								onClick={onToggleEnterToSend}
								className="flex items-center gap-1 text-[10px] opacity-50 hover:opacity-100 px-2 py-1 rounded hover:bg-white/5"
								title={formatEnterToSendTooltip(enterToSend)}
							>
								<Keyboard className="w-3 h-3" style={{ color: theme.colors.textDim }} />
								<span style={{ color: theme.colors.textDim }}>
									{formatEnterToSend(enterToSend)}
								</span>
							</button>
						)}

						{/* Send button */}
						<button
							onClick={handleSend}
							disabled={!value.trim()}
							className="flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed ml-2"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
							}}
						>
							<Send className="w-4 h-4" />
							Send
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
