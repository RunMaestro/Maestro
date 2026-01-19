import React, { useEffect, useRef, useState } from 'react';
import { X, FileText, Variable, ChevronDown, ChevronRight } from 'lucide-react';
import type { Theme } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { TEMPLATE_VARIABLES } from '../utils/templateVariables';
import { useTemplateAutocomplete } from '../hooks';
import { TemplateAutocompleteDropdown } from './TemplateAutocompleteDropdown';
import { estimateTokenCount } from '../../shared/formatters';

interface AgentPromptComposerModalProps {
	isOpen: boolean;
	onClose: () => void;
	theme: Theme;
	initialValue: string;
	onSubmit: (value: string) => void;
}

export function AgentPromptComposerModal({
	isOpen,
	onClose,
	theme,
	initialValue,
	onSubmit,
}: AgentPromptComposerModalProps) {
	const [value, setValue] = useState(initialValue);
	const [variablesExpanded, setVariablesExpanded] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const { registerLayer, unregisterLayer } = useLayerStack();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const onSubmitRef = useRef(onSubmit);
	onSubmitRef.current = onSubmit;
	const valueRef = useRef(value);
	valueRef.current = value;

	// Template variable autocomplete
	const {
		autocompleteState,
		handleKeyDown: handleAutocompleteKeyDown,
		handleChange: handleAutocompleteChange,
		selectVariable,
		closeAutocomplete,
		autocompleteRef,
	} = useTemplateAutocomplete({
		textareaRef,
		value,
		onChange: setValue,
	});

	// Sync value when modal opens with new initialValue
	useEffect(() => {
		if (isOpen) {
			setValue(initialValue);
			closeAutocomplete();
		}
	}, [isOpen, initialValue, closeAutocomplete]);

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
				priority: MODAL_PRIORITIES.AGENT_PROMPT_COMPOSER,
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'strict',
				onEscape: () => {
					// If autocomplete is open, close it instead of the modal
					if (autocompleteState.isOpen) {
						closeAutocomplete();
						return;
					}
					// Save the current value back before closing
					onSubmitRef.current(valueRef.current);
					onCloseRef.current();
				},
			});
			return () => unregisterLayer(id);
		}
	}, [isOpen, registerLayer, unregisterLayer, autocompleteState.isOpen, closeAutocomplete]);

	if (!isOpen) return null;

	const handleDone = () => {
		onSubmit(value);
		onClose();
	};

	const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		// Let autocomplete handle keys first
		if (handleAutocompleteKeyDown(e)) {
			return;
		}

		// Insert actual tab character instead of moving focus
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
		}
	};

	const tokenCount = estimateTokenCount(value);

	return (
		<div
			className="fixed inset-0 z-[10001] flex items-center justify-center"
			style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}
			onClick={(e) => {
				if (e.target === e.currentTarget) {
					onSubmit(value);
					onClose();
				}
			}}
		>
			<div
				className="w-[90vw] h-[85vh] max-w-5xl rounded-xl border shadow-2xl flex flex-col overflow-hidden"
				style={{
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.border,
				}}
			>
				{/* Header */}
				<div
					className="flex items-center justify-between px-4 py-3 border-b shrink-0"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
				>
					<div className="flex items-center gap-2">
						<FileText className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<span className="font-medium" style={{ color: theme.colors.textMain }}>
							Agent Prompt Editor
						</span>
					</div>
					<div className="flex items-center gap-3">
						<button
							onClick={handleDone}
							className="p-1.5 rounded hover:bg-white/10 transition-colors"
							title="Close (Escape)"
						>
							<X className="w-5 h-5" style={{ color: theme.colors.textDim }} />
						</button>
					</div>
				</div>

				{/* Template Variables - Collapsible */}
				<div
					className="border-b shrink-0"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
				>
					<button
						onClick={() => setVariablesExpanded(!variablesExpanded)}
						className="w-full px-4 py-2 flex items-center justify-between hover:bg-white/5 transition-colors"
					>
						<div className="flex items-center gap-2">
							<Variable className="w-4 h-4" style={{ color: theme.colors.accent }} />
							<span className="text-xs font-bold uppercase" style={{ color: theme.colors.textDim }}>
								Template Variables
							</span>
						</div>
						{variablesExpanded ? (
							<ChevronDown className="w-4 h-4" style={{ color: theme.colors.textDim }} />
						) : (
							<ChevronRight className="w-4 h-4" style={{ color: theme.colors.textDim }} />
						)}
					</button>
					{variablesExpanded && (
						<div className="px-4 pb-3 pt-1">
							<p className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
								Use these variables in your prompt. They will be replaced with actual values at
								runtime.
							</p>
							<div className="grid grid-cols-2 gap-x-6 gap-y-1 max-h-40 overflow-y-auto scrollbar-thin">
								{TEMPLATE_VARIABLES.map(({ variable, description }) => (
									<div key={variable} className="flex items-center gap-2 py-0.5 min-w-0">
										<code
											className="text-xs font-mono px-1.5 py-0.5 rounded shrink-0 cursor-pointer hover:opacity-80"
											style={{
												backgroundColor: theme.colors.bgActivity,
												color: theme.colors.accent,
											}}
											onClick={() => {
												// Insert variable at cursor position
												if (textareaRef.current) {
													const start = textareaRef.current.selectionStart;
													const end = textareaRef.current.selectionEnd;
													const newValue =
														value.substring(0, start) + variable + value.substring(end);
													setValue(newValue);
													// Restore focus and set cursor position after the inserted variable
													requestAnimationFrame(() => {
														if (textareaRef.current) {
															textareaRef.current.focus();
															textareaRef.current.selectionStart = start + variable.length;
															textareaRef.current.selectionEnd = start + variable.length;
														}
													});
												}
											}}
											title="Click to insert"
										>
											{variable}
										</code>
										<span className="text-xs" style={{ color: theme.colors.textDim }}>
											{description}
										</span>
									</div>
								))}
							</div>
						</div>
					)}
				</div>

				{/* Textarea */}
				<div className="flex-1 p-4 overflow-hidden relative">
					<textarea
						ref={textareaRef}
						value={value}
						onChange={handleAutocompleteChange}
						onKeyDown={handleTextareaKeyDown}
						className="w-full h-full bg-transparent resize-none outline-none text-sm leading-relaxed scrollbar-thin font-mono"
						style={{ color: theme.colors.textMain }}
						placeholder="Enter your agent prompt... (type {{ for variables)"
					/>
					{/* Template Variable Autocomplete Dropdown */}
					<TemplateAutocompleteDropdown
						ref={autocompleteRef}
						theme={theme}
						state={autocompleteState}
						onSelect={selectVariable}
					/>
				</div>

				{/* Footer */}
				<div
					className="flex items-center justify-between px-4 py-3 border-t shrink-0"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
				>
					<div className="text-xs flex items-center gap-3" style={{ color: theme.colors.textDim }}>
						<span>{value.length.toLocaleString()} characters</span>
						<span>~{tokenCount.toLocaleString()} tokens</span>
					</div>
					<button
						onClick={handleDone}
						className="flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all hover:opacity-90"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						Done
					</button>
				</div>
			</div>
		</div>
	);
}
