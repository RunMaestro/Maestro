/**
 * DocumentGenerationView.tsx
 *
 * The main takeover component for document generation in the inline wizard.
 * Takes over the AI terminal area (not a modal) when confidence reaches threshold
 * and user proceeds. Displays:
 * - Document selector dropdown at top
 * - Main content area showing streaming preview or final document
 * - Austin facts rotating in corner during generation
 * - Completion overlay with confetti when generation finishes
 *
 * This component is extracted/shared with PhaseReviewScreen.tsx to maintain consistency.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Eye, Edit, ChevronDown, ChevronRight, X, Loader2, FileText, Check } from 'lucide-react';
import type { Theme } from '../../types';
import type { GeneratedDocument } from '../Wizard/WizardContext';
import { MermaidRenderer } from '../MermaidRenderer';
import { useClickOutside } from '../../hooks';
import { AustinFactsDisplay } from './AustinFactsDisplay';
import { formatSize, formatElapsedTime } from '../../../shared/formatters';

// Memoize remarkPlugins array - it never changes
const REMARK_PLUGINS = [remarkGfm];

/**
 * Props for DocumentGenerationView
 */
export interface DocumentGenerationViewProps {
	/** Theme for styling */
	theme: Theme;
	/** Array of generated documents */
	documents: GeneratedDocument[];
	/** Index of the currently selected document */
	currentDocumentIndex: number;
	/** Whether documents are still being generated */
	isGenerating: boolean;
	/** Streaming content being generated (shown during generation) */
	streamingContent?: string;
	/** Called when generation completes and user clicks Done */
	onComplete: () => void;
	/** Called when user selects a different document */
	onDocumentSelect: (index: number) => void;
	/** Folder path for Auto Run docs */
	folderPath?: string;
	/** Called when document content changes (for editing) */
	onContentChange?: (content: string, docIndex: number) => void;
	/** Progress message to show during generation */
	progressMessage?: string;
	/** Current document being generated (for progress indicator) */
	currentGeneratingIndex?: number;
	/** Total number of documents to generate (for progress indicator) */
	totalDocuments?: number;
	/** Called when user wants to cancel generation */
	onCancel?: () => void;
	/** Subfolder name where documents are saved (for completion message) */
	subfolderName?: string;
}

/**
 * Document selector dropdown for switching between generated documents
 */
function DocumentSelector({
	documents,
	selectedIndex,
	onSelect,
	theme,
	disabled,
}: {
	documents: GeneratedDocument[];
	selectedIndex: number;
	onSelect: (index: number) => void;
	theme: Theme;
	disabled?: boolean;
}): JSX.Element {
	const [isOpen, setIsOpen] = useState(false);
	const dropdownRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);

	// Close dropdown when clicking outside
	useClickOutside(dropdownRef, () => setIsOpen(false), isOpen);

	// Close dropdown on Escape
	useEffect(() => {
		function handleKeyDown(event: KeyboardEvent) {
			if (event.key === 'Escape' && isOpen) {
				event.preventDefault();
				event.stopPropagation();
				setIsOpen(false);
				buttonRef.current?.focus();
			}
		}
		if (isOpen) {
			document.addEventListener('keydown', handleKeyDown, true);
			return () => document.removeEventListener('keydown', handleKeyDown, true);
		}
	}, [isOpen]);

	const selectedDoc = documents[selectedIndex];

	return (
		<div ref={dropdownRef} className="relative flex-1 min-w-0">
			<button
				ref={buttonRef}
				onClick={() => !disabled && setIsOpen(!isOpen)}
				disabled={disabled}
				className={`w-full min-w-0 flex items-center justify-between px-3 py-2 rounded text-sm transition-colors ${
					disabled ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-90'
				}`}
				style={{
					backgroundColor: theme.colors.bgActivity,
					color: theme.colors.textMain,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				<span className="truncate min-w-0 flex-1">
					{selectedDoc?.filename || 'Select document...'}
				</span>
				<ChevronDown
					className={`w-4 h-4 ml-2 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
					style={{ color: theme.colors.textDim }}
				/>
			</button>

			{/* Dropdown Menu */}
			{isOpen && !disabled && (
				<div
					className="absolute top-full left-0 right-0 mt-1 rounded shadow-lg overflow-hidden z-50"
					style={{
						backgroundColor: theme.colors.bgSidebar,
						border: `1px solid ${theme.colors.border}`,
						maxHeight: '300px',
						overflowY: 'auto',
					}}
				>
					{documents.length === 0 ? (
						<div className="px-3 py-2 text-sm" style={{ color: theme.colors.textDim }}>
							No documents generated
						</div>
					) : (
						documents.map((doc, index) => (
							<button
								key={doc.filename}
								onClick={() => {
									onSelect(index);
									setIsOpen(false);
								}}
								className="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-white/5"
								style={{
									color: index === selectedIndex ? theme.colors.accent : theme.colors.textMain,
									backgroundColor:
										index === selectedIndex ? theme.colors.bgActivity : 'transparent',
								}}
							>
								<div className="flex items-center justify-between">
									<span>{doc.filename}</span>
									{doc.taskCount > 0 && (
										<span
											className="text-xs px-1.5 py-0.5 rounded"
											style={{
												backgroundColor: `${theme.colors.accent}20`,
												color: theme.colors.accent,
											}}
										>
											{doc.taskCount} tasks
										</span>
									)}
								</div>
							</button>
						))
					)}
				</div>
			)}
		</div>
	);
}

/**
 * Image preview thumbnail for staged images
 */
function ImagePreview({
	src,
	filename,
	theme,
	onRemove,
}: {
	src: string;
	filename: string;
	theme: Theme;
	onRemove: () => void;
}): JSX.Element {
	return (
		<div className="relative inline-block group" style={{ margin: '4px' }}>
			<img
				src={src}
				alt={filename}
				className="w-20 h-20 object-cover rounded hover:opacity-80 transition-opacity"
				style={{ border: `1px solid ${theme.colors.border}` }}
			/>
			<button
				onClick={(e) => {
					e.stopPropagation();
					onRemove();
				}}
				className="absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
				style={{
					backgroundColor: theme.colors.error,
					color: 'white',
				}}
				title="Remove image"
			>
				<X className="w-3 h-3" />
			</button>
			<div
				className="absolute bottom-0 left-0 right-0 px-1 py-0.5 text-[9px] truncate rounded-b"
				style={{
					backgroundColor: 'rgba(0,0,0,0.6)',
					color: 'white',
				}}
			>
				{filename}
			</div>
		</div>
	);
}

/**
 * Custom image component for markdown preview
 */
function MarkdownImage({
	src,
	alt,
	folderPath,
	theme,
}: {
	src?: string;
	alt?: string;
	folderPath?: string;
	theme: Theme;
}): JSX.Element | null {
	const [dataUrl, setDataUrl] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!src) {
			setLoading(false);
			return;
		}

		if (src.startsWith('images/') && folderPath) {
			const absolutePath = `${folderPath}/${src}`;
			window.maestro.fs
				.readFile(absolutePath)
				.then((result: string) => {
					if (result.startsWith('data:')) {
						setDataUrl(result);
					} else {
						setError('Invalid image data');
					}
					setLoading(false);
				})
				.catch((err: Error) => {
					setError(`Failed to load: ${err.message}`);
					setLoading(false);
				});
		} else if (src.startsWith('data:') || src.startsWith('http')) {
			setDataUrl(src);
			setLoading(false);
		} else {
			setLoading(false);
		}
	}, [src, folderPath]);

	if (loading) {
		return (
			<span
				className="inline-flex items-center gap-2 px-3 py-2 rounded"
				style={{ backgroundColor: theme.colors.bgActivity }}
			>
				<Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.colors.textDim }} />
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Loading...
				</span>
			</span>
		);
	}

	if (error || !dataUrl) {
		return null;
	}

	return (
		<img
			src={dataUrl}
			alt={alt || ''}
			className="rounded border my-2"
			style={{
				maxHeight: '200px',
				maxWidth: '100%',
				objectFit: 'contain',
				borderColor: theme.colors.border,
			}}
		/>
	);
}

/**
 * Document editor component with edit/preview modes
 */
function DocumentEditor({
	content,
	onContentChange,
	mode,
	onModeChange,
	folderPath,
	selectedFile,
	attachments,
	onAddAttachment,
	onRemoveAttachment,
	theme,
	isLocked,
	textareaRef,
	previewRef,
}: {
	content: string;
	onContentChange: (content: string) => void;
	mode: 'edit' | 'preview';
	onModeChange: (mode: 'edit' | 'preview') => void;
	folderPath?: string;
	selectedFile?: string;
	attachments: Array<{ filename: string; dataUrl: string }>;
	onAddAttachment: (filename: string, dataUrl: string) => void;
	onRemoveAttachment: (filename: string) => void;
	theme: Theme;
	isLocked: boolean;
	textareaRef: React.RefObject<HTMLTextAreaElement>;
	previewRef: React.RefObject<HTMLDivElement>;
}): JSX.Element {
	const [attachmentsExpanded, setAttachmentsExpanded] = useState(true);

	// Handle image paste
	const handlePaste = useCallback(
		async (e: React.ClipboardEvent) => {
			if (isLocked || !folderPath || !selectedFile) return;

			const items = e.clipboardData?.items;
			if (!items) return;

			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (item.type.startsWith('image/')) {
					e.preventDefault();

					const file = item.getAsFile();
					if (!file) continue;

					const reader = new FileReader();
					reader.onload = async (event) => {
						const base64Data = event.target?.result as string;
						if (!base64Data) return;

						const base64Content = base64Data.replace(/^data:image\/\w+;base64,/, '');
						const extension = item.type.split('/')[1] || 'png';

						const result = await window.maestro.autorun.saveImage(
							folderPath,
							selectedFile,
							base64Content,
							extension
						);

						if (result.success && result.relativePath) {
							const filename = result.relativePath.split('/').pop() || result.relativePath;
							onAddAttachment(result.relativePath, base64Data);

							// Insert markdown reference at cursor
							const textarea = textareaRef.current;
							if (textarea) {
								const cursorPos = textarea.selectionStart;
								const textBefore = content.substring(0, cursorPos);
								const textAfter = content.substring(cursorPos);
								const imageMarkdown = `![${filename}](${result.relativePath})`;

								let prefix = '';
								let suffix = '';
								if (textBefore.length > 0 && !textBefore.endsWith('\n')) {
									prefix = '\n';
								}
								if (textAfter.length > 0 && !textAfter.startsWith('\n')) {
									suffix = '\n';
								}

								const newContent = textBefore + prefix + imageMarkdown + suffix + textAfter;
								onContentChange(newContent);

								const newCursorPos =
									cursorPos + prefix.length + imageMarkdown.length + suffix.length;
								setTimeout(() => {
									textarea.setSelectionRange(newCursorPos, newCursorPos);
									textarea.focus();
								}, 0);
							}
						}
					};
					reader.readAsDataURL(file);
					break;
				}
			}
		},
		[content, folderPath, selectedFile, isLocked, onContentChange, onAddAttachment, textareaRef]
	);

	// Handle key events
	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		// Insert tab character
		if (e.key === 'Tab') {
			e.preventDefault();
			const textarea = e.currentTarget;
			const start = textarea.selectionStart;
			const end = textarea.selectionEnd;
			const newContent = content.substring(0, start) + '\t' + content.substring(end);
			onContentChange(newContent);
			requestAnimationFrame(() => {
				textarea.selectionStart = start + 1;
				textarea.selectionEnd = start + 1;
			});
			return;
		}

		// Toggle mode with Cmd+E
		if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
			e.preventDefault();
			e.stopPropagation();
			onModeChange(mode === 'edit' ? 'preview' : 'edit');
			return;
		}

		// Insert checkbox with Cmd+L
		if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
			e.preventDefault();
			e.stopPropagation();
			const textarea = e.currentTarget;
			const cursorPos = textarea.selectionStart;
			const textBeforeCursor = content.substring(0, cursorPos);
			const textAfterCursor = content.substring(cursorPos);

			const lastNewline = textBeforeCursor.lastIndexOf('\n');
			const lineStart = lastNewline === -1 ? 0 : lastNewline + 1;
			const textOnCurrentLine = textBeforeCursor.substring(lineStart);

			let newContent: string;
			let newCursorPos: number;

			if (textOnCurrentLine.length === 0) {
				newContent = textBeforeCursor + '- [ ] ' + textAfterCursor;
				newCursorPos = cursorPos + 6;
			} else {
				newContent = textBeforeCursor + '\n- [ ] ' + textAfterCursor;
				newCursorPos = cursorPos + 7;
			}

			onContentChange(newContent);
			setTimeout(() => {
				if (textareaRef.current) {
					textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
				}
			}, 0);
			return;
		}

		// Handle Enter in lists
		if (e.key === 'Enter' && !e.shiftKey) {
			const textarea = e.currentTarget;
			const cursorPos = textarea.selectionStart;
			const textBeforeCursor = content.substring(0, cursorPos);
			const textAfterCursor = content.substring(cursorPos);
			const currentLineStart = textBeforeCursor.lastIndexOf('\n') + 1;
			const currentLine = textBeforeCursor.substring(currentLineStart);

			const taskListMatch = currentLine.match(/^(\s*)- \[([ x])\]\s+/);
			const unorderedListMatch = currentLine.match(/^(\s*)([-*])\s+/);

			if (taskListMatch) {
				const indent = taskListMatch[1];
				e.preventDefault();
				const newContent = textBeforeCursor + '\n' + indent + '- [ ] ' + textAfterCursor;
				onContentChange(newContent);
				setTimeout(() => {
					if (textareaRef.current) {
						const newPos = cursorPos + indent.length + 7;
						textareaRef.current.setSelectionRange(newPos, newPos);
					}
				}, 0);
			} else if (unorderedListMatch) {
				const indent = unorderedListMatch[1];
				const marker = unorderedListMatch[2];
				e.preventDefault();
				const newContent = textBeforeCursor + '\n' + indent + marker + ' ' + textAfterCursor;
				onContentChange(newContent);
				setTimeout(() => {
					if (textareaRef.current) {
						const newPos = cursorPos + indent.length + 3;
						textareaRef.current.setSelectionRange(newPos, newPos);
					}
				}, 0);
			}
		}
	};

	// Prose styles for markdown preview
	const proseStyles = useMemo(
		() => `
    .doc-gen-view .prose h1 { color: ${theme.colors.textMain}; font-size: 2em; font-weight: bold; margin: 0.67em 0; }
    .doc-gen-view .prose h2 { color: ${theme.colors.textMain}; font-size: 1.5em; font-weight: bold; margin: 0.75em 0; }
    .doc-gen-view .prose h3 { color: ${theme.colors.textMain}; font-size: 1.17em; font-weight: bold; margin: 0.83em 0; }
    .doc-gen-view .prose p { color: ${theme.colors.textMain}; margin: 0.5em 0; }
    .doc-gen-view .prose ul, .doc-gen-view .prose ol { color: ${theme.colors.textMain}; margin: 0.5em 0; padding-left: 1.5em; }
    .doc-gen-view .prose ul { list-style-type: disc; }
    .doc-gen-view .prose li { margin: 0.25em 0; display: list-item; }
    .doc-gen-view .prose code { background-color: ${theme.colors.bgActivity}; color: ${theme.colors.textMain}; padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.9em; }
    .doc-gen-view .prose pre { background-color: ${theme.colors.bgActivity}; color: ${theme.colors.textMain}; padding: 1em; border-radius: 6px; overflow-x: auto; }
    .doc-gen-view .prose pre code { background: none; padding: 0; }
    .doc-gen-view .prose blockquote { border-left: 4px solid ${theme.colors.border}; padding-left: 1em; margin: 0.5em 0; color: ${theme.colors.textDim}; }
    .doc-gen-view .prose a { color: ${theme.colors.accent}; text-decoration: underline; }
    .doc-gen-view .prose strong { font-weight: bold; }
    .doc-gen-view .prose em { font-style: italic; }
    .doc-gen-view .prose input[type="checkbox"] {
      appearance: none;
      -webkit-appearance: none;
      width: 16px;
      height: 16px;
      border: 2px solid ${theme.colors.accent};
      border-radius: 3px;
      background-color: transparent;
      cursor: pointer;
      vertical-align: middle;
      margin-right: 8px;
      position: relative;
    }
    .doc-gen-view .prose input[type="checkbox"]:checked {
      background-color: ${theme.colors.accent};
      border-color: ${theme.colors.accent};
    }
    .doc-gen-view .prose input[type="checkbox"]:checked::after {
      content: '';
      position: absolute;
      left: 4px;
      top: 1px;
      width: 5px;
      height: 9px;
      border: solid ${theme.colors.bgMain};
      border-width: 0 2px 2px 0;
      transform: rotate(45deg);
    }
    .doc-gen-view .prose li:has(> input[type="checkbox"]) {
      list-style-type: none;
      margin-left: -1.5em;
    }
  `,
		[theme]
	);

	// Markdown components
	const markdownComponents = useMemo(
		() => ({
			code: ({ inline, className, children, ...props }: any) => {
				const match = (className || '').match(/language-(\w+)/);
				const language = match ? match[1] : 'text';
				const codeContent = String(children).replace(/\n$/, '');

				if (!inline && language === 'mermaid') {
					return <MermaidRenderer chart={codeContent} theme={theme} />;
				}

				return !inline && match ? (
					<SyntaxHighlighter
						language={language}
						style={vscDarkPlus}
						customStyle={{
							margin: '0.5em 0',
							padding: '1em',
							background: theme.colors.bgActivity,
							fontSize: '0.9em',
							borderRadius: '6px',
						}}
						PreTag="div"
					>
						{codeContent}
					</SyntaxHighlighter>
				) : (
					<code className={className} {...props}>
						{children}
					</code>
				);
			},
			img: ({ src, alt, ...props }: any) => (
				<MarkdownImage src={src} alt={alt} folderPath={folderPath} theme={theme} {...props} />
			),
			a: ({ href, children }: any) => (
				<a
					href={href}
					onClick={(e) => {
						e.preventDefault();
						if (href) window.maestro.shell.openExternal(href);
					}}
					style={{ color: theme.colors.accent, textDecoration: 'underline', cursor: 'pointer' }}
				>
					{children}
				</a>
			),
		}),
		[theme, folderPath]
	);

	return (
		<div className="flex flex-col flex-1 min-h-0">
			{/* Toolbar row: Edit/Preview buttons */}
			<div className="flex items-center justify-center gap-2 mb-3">
				<button
					onClick={() => !isLocked && onModeChange('edit')}
					disabled={isLocked}
					className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors ${
						mode === 'edit' && !isLocked ? 'font-semibold' : ''
					} ${isLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
					style={{
						backgroundColor: mode === 'edit' && !isLocked ? theme.colors.bgActivity : 'transparent',
						color: isLocked
							? theme.colors.textDim
							: mode === 'edit'
								? theme.colors.textMain
								: theme.colors.textDim,
						border: `1px solid ${
							mode === 'edit' && !isLocked ? theme.colors.accent : theme.colors.border
						}`,
					}}
					title="Edit document (⌘E)"
				>
					<Edit className="w-3.5 h-3.5" />
					Edit
				</button>
				<button
					onClick={() => onModeChange('preview')}
					className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors ${
						mode === 'preview' ? 'font-semibold' : ''
					}`}
					style={{
						backgroundColor: mode === 'preview' ? theme.colors.bgActivity : 'transparent',
						color: mode === 'preview' ? theme.colors.textMain : theme.colors.textDim,
						border: `1px solid ${mode === 'preview' ? theme.colors.accent : theme.colors.border}`,
					}}
					title="Preview document (⌘E)"
				>
					<Eye className="w-3.5 h-3.5" />
					Preview
				</button>
			</div>

			{/* Attached Images Preview (edit mode) */}
			{mode === 'edit' && attachments.length > 0 && (
				<div
					className="px-2 py-2 mb-2 rounded"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					<button
						onClick={() => setAttachmentsExpanded(!attachmentsExpanded)}
						className="w-full flex items-center gap-1 text-[10px] uppercase font-semibold hover:opacity-80 transition-opacity"
						style={{ color: theme.colors.textDim }}
					>
						{attachmentsExpanded ? (
							<ChevronDown className="w-3 h-3" />
						) : (
							<ChevronRight className="w-3 h-3" />
						)}
						Attached Images ({attachments.length})
					</button>
					{attachmentsExpanded && (
						<div className="flex flex-wrap gap-1 mt-2">
							{attachments.map((att) => (
								<ImagePreview
									key={att.filename}
									src={att.dataUrl}
									filename={att.filename}
									theme={theme}
									onRemove={() => onRemoveAttachment(att.filename)}
								/>
							))}
						</div>
					)}
				</div>
			)}

			{/* Content area */}
			<div className="flex-1 min-h-0 flex flex-col overflow-hidden">
				{mode === 'edit' ? (
					<textarea
						ref={textareaRef}
						value={content}
						onChange={(e) => !isLocked && onContentChange(e.target.value)}
						onKeyDown={!isLocked ? handleKeyDown : undefined}
						onPaste={handlePaste}
						readOnly={isLocked}
						placeholder="Your task document will appear here..."
						className={`w-full h-full border rounded p-4 bg-transparent outline-none resize-none font-mono text-sm overflow-y-auto ${
							isLocked ? 'cursor-not-allowed opacity-70' : ''
						}`}
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					/>
				) : (
					<div
						ref={previewRef}
						className="doc-gen-view h-full overflow-y-auto border rounded p-4 prose prose-sm max-w-none outline-none"
						tabIndex={0}
						onKeyDown={(e) => {
							if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
								e.preventDefault();
								e.stopPropagation();
								onModeChange('edit');
							}
						}}
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
							fontSize: '13px',
						}}
					>
						<style>{proseStyles}</style>
						<ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
							{content || '*No content yet.*'}
						</ReactMarkdown>
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * Count tasks in markdown content
 */
function countTasks(content: string): number {
	const matches = content.match(/^- \[([ x])\]/gm);
	return matches ? matches.length : 0;
}

/**
 * Individual file entry in the created files list
 */
function CreatedFileEntry({
	doc,
	isExpanded,
	isNewest,
	theme,
	onToggle,
}: {
	doc: GeneratedDocument;
	isExpanded: boolean;
	isNewest: boolean;
	theme: Theme;
	onToggle: () => void;
}): JSX.Element {
	const taskCount = countTasks(doc.content);
	const fileSize = new Blob([doc.content]).size;

	// Extract first paragraph as description
	const description = useMemo(() => {
		const lines = doc.content.split('\n');
		for (const line of lines) {
			const trimmed = line.trim();
			// Skip headers and empty lines
			if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
			// Return first paragraph, truncated
			return trimmed.length > 150 ? trimmed.slice(0, 147) + '...' : trimmed;
		}
		return null;
	}, [doc.content]);

	return (
		<div
			className="overflow-hidden transition-all duration-300"
			style={{
				animation: isNewest ? 'fadeSlideIn 0.3s ease-out' : undefined,
			}}
		>
			{/* Header row - clickable to expand/collapse */}
			<button
				onClick={onToggle}
				className="w-full px-4 py-2.5 flex items-center justify-between text-sm text-left hover:opacity-80 transition-opacity"
				style={{
					backgroundColor: isExpanded ? `${theme.colors.accent}10` : 'transparent',
				}}
			>
				<div className="flex items-center gap-2 min-w-0">
					{isExpanded ? (
						<ChevronDown
							className="w-4 h-4 shrink-0 transition-transform duration-200"
							style={{ color: theme.colors.textDim }}
						/>
					) : (
						<ChevronRight
							className="w-4 h-4 shrink-0 transition-transform duration-200"
							style={{ color: theme.colors.textDim }}
						/>
					)}
					<span style={{ color: theme.colors.success }}>✓</span>
					<span
						className="truncate font-medium"
						style={{ color: theme.colors.textMain }}
						title={doc.filename}
					>
						{doc.filename}
					</span>
				</div>
				<div className="flex items-center gap-3 shrink-0 ml-2">
					{/* Task count badge */}
					{taskCount > 0 && (
						<span
							className="text-xs font-medium px-1.5 py-0.5 rounded"
							style={{
								backgroundColor: `${theme.colors.accent}20`,
								color: theme.colors.accent,
							}}
						>
							{taskCount} {taskCount === 1 ? 'task' : 'tasks'}
						</span>
					)}
					{/* File size */}
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{formatSize(fileSize)}
					</span>
				</div>
			</button>

			{/* Description - shown when expanded */}
			<div
				className="overflow-hidden transition-all duration-300 ease-out"
				style={{
					maxHeight: isExpanded ? '120px' : '0px',
					opacity: isExpanded ? 1 : 0,
				}}
			>
				{description && (
					<div
						className="px-4 pb-3 pl-12 text-xs leading-relaxed"
						style={{ color: theme.colors.textDim }}
					>
						{description}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * List of created files during generation
 */
function CreatedFilesList({
	documents,
	theme,
}: {
	documents: GeneratedDocument[];
	theme: Theme;
}): JSX.Element | null {
	const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
	const userToggledFilesRef = useRef<Set<string>>(new Set());
	const lastAutoExpandedRef = useRef<string | null>(null);

	// Auto-expand newest file when it's added
	const prevFilesCountRef = useRef(documents.length);
	useEffect(() => {
		if (documents.length > prevFilesCountRef.current && documents.length > 0) {
			const newestFile = documents[documents.length - 1];

			setExpandedFiles((prev) => {
				const next = new Set(prev);

				// Collapse the previous auto-expanded file (only if user hasn't touched it)
				if (
					lastAutoExpandedRef.current &&
					!userToggledFilesRef.current.has(lastAutoExpandedRef.current)
				) {
					next.delete(lastAutoExpandedRef.current);
				}

				// Expand the new file
				next.add(newestFile.filename);
				return next;
			});

			lastAutoExpandedRef.current = newestFile.filename;
		}
		prevFilesCountRef.current = documents.length;
	}, [documents]);

	const toggleFile = useCallback((filename: string) => {
		userToggledFilesRef.current.add(filename);
		setExpandedFiles((prev) => {
			const next = new Set(prev);
			if (next.has(filename)) {
				next.delete(filename);
			} else {
				next.add(filename);
			}
			return next;
		});
	}, []);

	if (documents.length === 0) return null;

	const newestIndex = documents.length - 1;

	return (
		<div
			className="mt-6 mx-auto rounded-lg overflow-hidden"
			style={{
				backgroundColor: theme.colors.bgActivity,
				border: `1px solid ${theme.colors.border}`,
				width: '600px',
				maxWidth: '100%',
			}}
		>
			<div
				className="px-4 py-2.5 border-b flex items-center gap-2"
				style={{
					backgroundColor: `${theme.colors.success}15`,
					borderColor: theme.colors.border,
				}}
			>
				<FileText className="w-4 h-4" style={{ color: theme.colors.success }} />
				<span
					className="text-xs font-medium uppercase tracking-wide"
					style={{ color: theme.colors.success }}
				>
					Work Plans Drafted ({documents.length})
				</span>
			</div>
			<div
				className="overflow-y-auto"
				style={{
					maxHeight: 'calc(40vh - 100px)',
				}}
			>
				{documents.map((doc, index) => (
					<div
						key={doc.filename}
						style={{
							borderBottom:
								index < documents.length - 1 ? `1px solid ${theme.colors.border}` : undefined,
						}}
					>
						<CreatedFileEntry
							doc={doc}
							isExpanded={expandedFiles.has(doc.filename)}
							isNewest={index === newestIndex}
							theme={theme}
							onToggle={() => toggleFile(doc.filename)}
						/>
					</div>
				))}
			</div>

			{/* Animation styles */}
			<style>{`
        @keyframes fadeSlideIn {
          from {
            opacity: 0;
            transform: translateY(-8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
		</div>
	);
}

/**
 * DocumentGenerationView - Main component for document generation takeover
 */
export function DocumentGenerationView({
	theme,
	documents,
	currentDocumentIndex: _currentDocumentIndex,
	isGenerating,
	streamingContent: _streamingContent,
	onComplete,
	onDocumentSelect: _onDocumentSelect,
	folderPath: _folderPath,
	onContentChange: _onContentChange,
	progressMessage: _progressMessage,
	currentGeneratingIndex: _currentGeneratingIndex,
	totalDocuments: _totalDocuments,
	onCancel,
	subfolderName,
}: DocumentGenerationViewProps): JSX.Element {
	// Calculate total tasks
	const totalTasks = documents.reduce((sum, doc) => sum + countTasks(doc.content), 0);

	// Track elapsed time for generation
	const [startTime] = useState(() => Date.now());
	const [elapsedMs, setElapsedMs] = useState(0);

	useEffect(() => {
		if (!isGenerating) return;

		// Update immediately
		setElapsedMs(Date.now() - startTime);

		// Update every second
		const interval = setInterval(() => {
			setElapsedMs(Date.now() - startTime);
		}, 1000);

		return () => clearInterval(interval);
	}, [isGenerating, startTime]);

	// Determine if generation is complete
	const isComplete = !isGenerating && documents.length > 0;

	// Fallback - no documents and not generating
	if (!isGenerating && documents.length === 0) {
		return (
			<div
				className="flex flex-col h-full items-center justify-center p-6"
				style={{ backgroundColor: theme.colors.bgMain }}
			>
				<p style={{ color: theme.colors.textDim }}>No documents generated yet.</p>
				{onCancel && (
					<button
						onClick={onCancel}
						className="mt-4 px-4 py-2 text-sm rounded"
						style={{
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textDim,
						}}
					>
						Cancel
					</button>
				)}
			</div>
		);
	}

	// Main view - same layout for generating and complete states
	// Only difference: Austin Facts vs completion button at bottom
	return (
		<div
			className="flex flex-col h-full items-center justify-center p-6 overflow-y-auto"
			style={{ backgroundColor: theme.colors.bgMain }}
		>
			{/* Main content - centered vertically */}
			<div className="flex flex-col items-center">
				{/* Header: Spinner when generating, Checkmark when complete */}
				{isComplete ? (
					<div
						className="w-14 h-14 rounded-full flex items-center justify-center mb-4"
						style={{ backgroundColor: `${theme.colors.success}20` }}
					>
						<Check className="w-7 h-7" style={{ color: theme.colors.success }} />
					</div>
				) : (
					<div className="relative mb-4">
						<div
							className="w-14 h-14 rounded-full border-4 border-t-transparent animate-spin"
							style={{
								borderColor: `${theme.colors.border}`,
								borderTopColor: theme.colors.accent,
							}}
						/>
						{/* Inner pulsing circle */}
						<div className="absolute inset-0 flex items-center justify-center">
							<div
								className="w-7 h-7 rounded-full animate-pulse"
								style={{ backgroundColor: `${theme.colors.accent}30` }}
							/>
						</div>
					</div>
				)}

				{/* Title */}
				<h3
					className="text-lg font-semibold mb-1 text-center"
					style={{ color: theme.colors.textMain }}
				>
					{isComplete ? 'Documentation generation complete.' : 'Generating Auto Run Documents...'}
				</h3>

				{/* Subtitle: location message when complete, elapsed time during generation */}
				{isComplete ? (
					<p className="text-sm text-center max-w-md" style={{ color: theme.colors.textDim }}>
						Available under{' '}
						<span style={{ color: theme.colors.accent, fontWeight: 500 }}>
							{subfolderName || 'Auto Run Docs'}/
						</span>
					</p>
				) : (
					<>
						<p className="text-sm text-center max-w-md" style={{ color: theme.colors.textDim }}>
							This may take a while. We're creating detailed task documents based on your project
							requirements.
						</p>
						{elapsedMs > 0 && (
							<p className="text-xs mt-1 font-mono" style={{ color: theme.colors.textDim }}>
								Elapsed: {formatElapsedTime(elapsedMs)}
							</p>
						)}
					</>
				)}

				{/* Total task count */}
				{totalTasks > 0 ? (
					<div className="mt-4 flex items-center gap-2">
						<span className="text-3xl font-bold" style={{ color: theme.colors.accent }}>
							{totalTasks}
						</span>
						<span className="text-lg font-medium" style={{ color: theme.colors.textMain }}>
							{totalTasks === 1 ? 'Task' : 'Tasks'} Planned
						</span>
					</div>
				) : !isComplete ? (
					<div className="flex items-center gap-1 mt-3">
						{[0, 1, 2].map((i) => (
							<div
								key={i}
								className="w-2 h-2 rounded-full"
								style={{
									backgroundColor: theme.colors.accent,
									animation: `bounce-dot 0.8s infinite ${i * 150}ms`,
								}}
							/>
						))}
					</div>
				) : null}

				{/* Created files list */}
				<CreatedFilesList documents={documents} theme={theme} />

				{/* Bottom section: Austin Facts during generation, Exit Wizard button when done */}
				{isComplete ? (
					<button
						onClick={onComplete}
						className="mt-8 px-6 py-3 text-base font-semibold rounded-lg transition-all hover:opacity-90 hover:scale-105"
						style={{
							backgroundColor: theme.colors.success,
							color: 'white',
						}}
					>
						Exit Wizard
					</button>
				) : (
					<>
						{/* Cancel button */}
						{onCancel && (
							<button
								onClick={onCancel}
								className="mt-4 px-4 py-2 text-sm rounded transition-colors hover:opacity-80"
								style={{
									backgroundColor: theme.colors.bgActivity,
									color: theme.colors.textDim,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								Cancel
							</button>
						)}

						{/* Austin Facts - shown during generation */}
						<div className="mt-8">
							<AustinFactsDisplay theme={theme} isVisible={true} centered />
						</div>
					</>
				)}
			</div>

			{/* Animation styles */}
			<style>{`
        @keyframes bounce-dot {
          0%, 100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(-6px);
          }
        }
      `}</style>
		</div>
	);
}

// Export individual components for reuse
export { DocumentSelector, DocumentEditor };

// Re-export standalone components from their files
export { AustinFactsDisplay } from './AustinFactsDisplay';
export { StreamingDocumentPreview } from './StreamingDocumentPreview';
export { GenerationCompleteOverlay } from './GenerationCompleteOverlay';
