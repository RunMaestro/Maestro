/**
 * DocumentEditor.tsx
 *
 * Shared document editor component with edit/preview modes, markdown rendering,
 * image paste support, and keyboard shortcuts. Used by PhaseReviewScreen and
 * DocumentGenerationView for consistent editing experience.
 *
 * Features:
 * - Edit/Preview toggle (⌘E)
 * - Markdown preview with syntax highlighting
 * - Mermaid diagram support
 * - Image paste support with Auto Run image storage
 * - Task list auto-continuation on Enter
 * - Checkbox insertion (⌘L)
 * - Tab character insertion
 */

import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import { Eye, Edit, ChevronDown, ChevronRight, X, Loader2 } from 'lucide-react';
import type { Theme } from '../../../types';
import { MermaidRenderer } from '../../MermaidRenderer';
import type { GeneratedDocument } from '../WizardContext';
import { DocumentSelector } from './DocumentSelector';
import { generateProseStyles, createMarkdownComponents } from '../../../utils/markdownConfig';

// Memoize plugin arrays - they never change
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeSlug];

/**
 * Image preview thumbnail for staged images
 */
export function ImagePreview({
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
export function MarkdownImage({
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
 * Props for the DocumentEditor component
 */
export interface DocumentEditorProps {
	/** Document content */
	content: string;
	/** Called when content changes */
	onContentChange: (content: string) => void;
	/** Current mode: edit or preview */
	mode: 'edit' | 'preview';
	/** Called when mode changes */
	onModeChange: (mode: 'edit' | 'preview') => void;
	/** Folder path for Auto Run docs */
	folderPath: string;
	/** Currently selected file (without .md extension) */
	selectedFile: string;
	/** Attached images */
	attachments: Array<{ filename: string; dataUrl: string }>;
	/** Called when an image is attached */
	onAddAttachment: (filename: string, dataUrl: string) => void;
	/** Called when an image is removed */
	onRemoveAttachment: (filename: string) => void;
	/** Theme for styling */
	theme: Theme;
	/** Whether editing is locked */
	isLocked: boolean;
	/** Ref for textarea element */
	textareaRef: React.RefObject<HTMLTextAreaElement>;
	/** Ref for preview div element */
	previewRef: React.RefObject<HTMLDivElement>;
	/** List of generated documents (for document selector) */
	documents: GeneratedDocument[];
	/** Index of the selected document */
	selectedDocIndex: number;
	/** Called when document selection changes */
	onDocumentSelect: (index: number) => void;
	/** Stats text to display (e.g., "5 tasks ready to run") */
	statsText: string;
	/** CSS class prefix for prose styles (default: 'doc-editor') */
	proseClassPrefix?: string;
	/** Whether to show document selector and stats (default: true) */
	showHeader?: boolean;
	/** Whether the document dropdown is open (controlled mode) */
	isDropdownOpen?: boolean;
	/** Called when dropdown open state changes */
	onDropdownOpenChange?: (isOpen: boolean) => void;
}

/**
 * Document editor component with edit/preview modes
 *
 * This is a comprehensive markdown editor with:
 * - Edit/Preview toggle
 * - Syntax highlighting
 * - Image paste and attachment support
 * - Task list auto-continuation
 * - Keyboard shortcuts
 */
export function DocumentEditor({
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
	documents,
	selectedDocIndex,
	onDocumentSelect,
	statsText,
	proseClassPrefix = 'doc-editor',
	showHeader = true,
	isDropdownOpen,
	onDropdownOpenChange,
}: DocumentEditorProps): JSX.Element {
	const _fileInputRef = useRef<HTMLInputElement>(null);
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

	// Handle file input for manual image upload
	const _handleFileSelect = useCallback(
		async (e: React.ChangeEvent<HTMLInputElement>) => {
			const file = e.target.files?.[0];
			if (!file || !folderPath || !selectedFile) return;

			const reader = new FileReader();
			reader.onload = async (event) => {
				const base64Data = event.target?.result as string;
				if (!base64Data) return;

				const base64Content = base64Data.replace(/^data:image\/\w+;base64,/, '');
				const extension = file.name.split('.').pop() || 'png';

				const result = await window.maestro.autorun.saveImage(
					folderPath,
					selectedFile,
					base64Content,
					extension
				);

				if (result.success && result.relativePath) {
					const filename = result.relativePath.split('/').pop() || result.relativePath;
					onAddAttachment(result.relativePath, base64Data);

					const imageMarkdown = `\n![${filename}](${result.relativePath})\n`;
					const newContent = content + imageMarkdown;
					onContentChange(newContent);
				}
			};
			reader.readAsDataURL(file);
			e.target.value = '';
		},
		[content, folderPath, selectedFile, onContentChange, onAddAttachment]
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

	// Prose styles using shared markdownConfig for consistent rendering with AutoRun
	const proseStyles = useMemo(
		() =>
			generateProseStyles({
				theme,
				coloredHeadings: true, // Match AutoRun colored headings
				compactSpacing: false,
				includeCheckboxStyles: true,
				scopeSelector: `.${proseClassPrefix}`,
			}),
		[theme, proseClassPrefix]
	);

	// Custom image component that handles Auto Run folder paths
	const WizardImageRenderer = useMemo(() => {
		return function WizardImage({ src, alt }: { src?: string; alt?: string }) {
			return <MarkdownImage src={src} alt={alt} folderPath={folderPath} theme={theme} />;
		};
	}, [folderPath, theme]);

	// Mermaid renderer wrapper for createMarkdownComponents
	const MermaidWrapper = useMemo(() => {
		return function Mermaid({ code }: { code: string; theme: Theme }) {
			return <MermaidRenderer chart={code} theme={theme} />;
		};
	}, []);

	// Markdown components using shared factory for consistent rendering with AutoRun
	const markdownComponents = useMemo(
		() =>
			createMarkdownComponents({
				theme,
				imageRenderer: WizardImageRenderer,
				customLanguageRenderers: {
					mermaid: MermaidWrapper,
				},
				onExternalLinkClick: (href) => {
					window.maestro.shell.openExternal(href);
				},
			}),
		[theme, WizardImageRenderer, MermaidWrapper]
	);

	return (
		<div className="flex flex-col flex-1 min-h-0">
			{/* Toolbar row: Document selector + Edit/Preview buttons - centered */}
			{showHeader && (
				<>
					<div className="flex items-center justify-center gap-3 mb-2">
						{/* Document selector - uses shared DocumentSelector component */}
						<DocumentSelector
							documents={documents}
							selectedIndex={selectedDocIndex}
							onSelect={onDocumentSelect}
							theme={theme}
							disabled={isLocked}
							className="min-w-0"
							isOpen={isDropdownOpen}
							onOpenChange={onDropdownOpenChange}
						/>

						{/* Edit/Preview toggle */}
						<div className="flex gap-2">
							<button
								onClick={() => !isLocked && onModeChange('edit')}
								disabled={isLocked}
								className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors ${
									mode === 'edit' && !isLocked ? 'font-semibold' : ''
								} ${isLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
								style={{
									backgroundColor:
										mode === 'edit' && !isLocked ? theme.colors.bgActivity : 'transparent',
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
									border: `1px solid ${
										mode === 'preview' ? theme.colors.accent : theme.colors.border
									}`,
								}}
								title="Preview document (⌘E)"
							>
								<Eye className="w-3.5 h-3.5" />
								Preview
							</button>
						</div>
					</div>

					{/* Stats text centered below toolbar */}
					<div className="text-center mb-3">
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							{statsText}
						</span>
					</div>
				</>
			)}

			{/* Edit/Preview toggle when header is hidden */}
			{!showHeader && (
				<div className="flex items-center justify-center gap-2 mb-3">
					<button
						onClick={() => !isLocked && onModeChange('edit')}
						disabled={isLocked}
						className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors ${
							mode === 'edit' && !isLocked ? 'font-semibold' : ''
						} ${isLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
						style={{
							backgroundColor:
								mode === 'edit' && !isLocked ? theme.colors.bgActivity : 'transparent',
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
			)}

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

			{/* Content area - uses flex-1 to fill remaining space */}
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
						className={`${proseClassPrefix} h-full overflow-y-auto border rounded p-4 outline-none`}
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
						<div className="prose prose-sm max-w-none">
							<ReactMarkdown
								remarkPlugins={REMARK_PLUGINS}
								rehypePlugins={REHYPE_PLUGINS}
								components={markdownComponents}
							>
								{content || '*No content yet.*'}
							</ReactMarkdown>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

export default DocumentEditor;
