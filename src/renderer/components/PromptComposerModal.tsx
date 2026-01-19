import React, { useEffect, useRef, useState } from 'react';
import { X, PenLine, Send, ImageIcon, History, Eye, Keyboard, Brain } from 'lucide-react';
import type { Theme } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { estimateTokenCount } from '../../shared/formatters';

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
	tabShowThinking?: boolean;
	onToggleTabShowThinking?: () => void;
	supportsThinking?: boolean;
	enterToSend?: boolean;
	onToggleEnterToSend?: () => void;
}

export function PromptComposerModal({
	isOpen,
	onClose,
	theme,
	initialValue,
	onSubmit,
	onSend,
	sessionName = 'Claude',
	stagedImages = [],
	setStagedImages,
	onImageAttachBlocked,
	onOpenLightbox,
	tabSaveToHistory = false,
	onToggleTabSaveToHistory,
	tabReadOnlyMode = false,
	onToggleTabReadOnlyMode,
	tabShowThinking = false,
	onToggleTabShowThinking,
	supportsThinking = false,
	enterToSend = false,
	onToggleEnterToSend,
}: PromptComposerModalProps) {
	const [value, setValue] = useState(initialValue);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const { registerLayer, unregisterLayer } = useLayerStack();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const onSubmitRef = useRef(onSubmit);
	onSubmitRef.current = onSubmit;
	const onSendRef = useRef(onSend);
	onSendRef.current = onSend;
	const valueRef = useRef(value);
	valueRef.current = value;

	// Sync value when modal opens with new initialValue
	useEffect(() => {
		if (isOpen) {
			setValue(initialValue);
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
					// Save the current value back before closing
					onSubmitRef.current(valueRef.current);
					onCloseRef.current();
				},
			});
			return () => unregisterLayer(id);
		}
	}, [isOpen, registerLayer, unregisterLayer]);

	if (!isOpen) return null;

	const handleSend = () => {
		if (!value.trim()) return;
		onSend(value);
		onClose();
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
			setValue(newValue);
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

	// Handle paste for images
	const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
		const items = e.clipboardData.items;
		const hasImage = Array.from(items).some((item) => item.type.startsWith('image/'));
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
			onClick={(e) => {
				if (e.target === e.currentTarget) {
					onSubmit(value);
					onClose();
				}
			}}
		>
			<div
				className="w-[90vw] h-[80vh] max-w-5xl rounded-xl border shadow-2xl flex flex-col overflow-hidden"
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
							<div key={idx} className="relative group shrink-0">
								<img
									src={img}
									className="h-16 rounded border cursor-pointer hover:opacity-80 transition-opacity"
									style={{
										borderColor: theme.colors.border,
										objectFit: 'contain',
										maxWidth: '200px',
									}}
									onClick={() => onOpenLightbox?.(img, stagedImages, 'staged')}
									title="Click to view (⌘+Shift+L)"
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
				<div className="flex-1 p-4 overflow-hidden">
					<textarea
						ref={textareaRef}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={handleKeyDown}
						onPaste={handlePaste}
						className="w-full h-full bg-transparent resize-none outline-none text-base leading-relaxed scrollbar-thin"
						style={{ color: theme.colors.textMain }}
						placeholder="Write your prompt here..."
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
							<span>~{tokenCount.toLocaleString()} tokens</span>
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
								title="Save to History (Cmd+S) - Synopsis added after each completion"
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

						{/* Show Thinking toggle - for agents that support it */}
						{supportsThinking && onToggleTabShowThinking && (
							<button
								onClick={onToggleTabShowThinking}
								className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-all ${
									tabShowThinking ? '' : 'opacity-40 hover:opacity-70'
								}`}
								style={{
									backgroundColor: tabShowThinking ? `${theme.colors.accentText}25` : 'transparent',
									color: tabShowThinking ? theme.colors.accentText : theme.colors.textDim,
									border: tabShowThinking
										? `1px solid ${theme.colors.accentText}50`
										: '1px solid transparent',
								}}
								title="Show Thinking - Stream AI reasoning in real-time"
							>
								<Brain className="w-3 h-3" />
								<span>Thinking</span>
							</button>
						)}

						{/* Enter to send toggle */}
						{onToggleEnterToSend && (
							<button
								onClick={onToggleEnterToSend}
								className="flex items-center gap-1 text-[10px] opacity-50 hover:opacity-100 px-2 py-1 rounded hover:bg-white/5"
								title={enterToSend ? 'Switch to Meta+Enter to send' : 'Switch to Enter to send'}
							>
								<Keyboard className="w-3 h-3" style={{ color: theme.colors.textDim }} />
								<span style={{ color: theme.colors.textDim }}>
									{enterToSend ? 'Enter' : '⌘ + Enter'}
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
