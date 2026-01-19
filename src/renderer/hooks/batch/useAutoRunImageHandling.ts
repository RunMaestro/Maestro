import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Cache for loaded images to avoid repeated IPC calls.
 * This is a module-level singleton that persists across hook instances.
 */
export const imageCache = new Map<string, string>();

/**
 * Dependencies required by useAutoRunImageHandling hook
 */
export interface UseAutoRunImageHandlingDeps {
	/** Auto Run folder path (null if not configured) */
	folderPath: string | null;
	/** Currently selected document filename (without extension) */
	selectedFile: string | null;
	/** Current content of the document */
	localContent: string;
	/** Function to update the local content state */
	setLocalContent: (content: string) => void;
	/** Function to sync content to parent state */
	handleContentChange: (content: string) => void;
	/** Whether editing is locked (e.g., during batch run) */
	isLocked: boolean;
	/** Ref to the textarea element for cursor position */
	textareaRef: React.RefObject<HTMLTextAreaElement>;
	/** Push undo state before content modifications */
	pushUndoState: () => void;
	/** Ref to last snapshotted content */
	lastUndoSnapshotRef: React.MutableRefObject<string>;
	/** SSH remote ID for remote file operations */
	sshRemoteId?: string;
}

/**
 * Return type of useAutoRunImageHandling hook
 */
export interface UseAutoRunImageHandlingReturn {
	/** List of attachment relative paths (e.g., "images/{docName}-{timestamp}.{ext}") */
	attachmentsList: string[];
	/** Map of relative paths to data URLs for previews */
	attachmentPreviews: Map<string, string>;
	/** Whether the attachments panel is expanded */
	attachmentsExpanded: boolean;
	/** Toggle attachments panel expansion */
	setAttachmentsExpanded: (expanded: boolean) => void;
	/** Currently viewed image in lightbox (null = closed) */
	lightboxFilename: string | null;
	/** External URL for lightbox (for http/https/data: URLs) */
	lightboxExternalUrl: string | null;
	/** Ref to the file input element */
	fileInputRef: React.RefObject<HTMLInputElement>;
	/** Handle paste event (for clipboard images) */
	handlePaste: (e: React.ClipboardEvent) => Promise<void>;
	/** Handle file input change (for manual upload) */
	handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
	/** Remove an attachment by relative path */
	handleRemoveAttachment: (relativePath: string) => Promise<void>;
	/** Open lightbox for a filename or URL */
	openLightboxByFilename: (filenameOrUrl: string) => void;
	/** Close the lightbox */
	closeLightbox: () => void;
	/** Navigate to a different image in lightbox */
	handleLightboxNavigate: (filename: string | null) => void;
	/** Delete an image from lightbox (removes file and content reference) */
	handleLightboxDelete: (relativePath: string) => Promise<void>;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const removeImageMarkdownReference = (content: string, relativePath: string): string => {
	const filename = relativePath.split('/').pop() || relativePath;
	const encodedPath = relativePath
		.split('/')
		.map((part) => encodeURIComponent(part))
		.join('/');
	const escapedFilename = escapeRegExp(filename);
	const escapedEncodedPath = escapeRegExp(encodedPath);
	const escapedRawPath = escapeRegExp(relativePath);
	const encodedRegex = new RegExp(`!\\[${escapedFilename}\\]\\(${escapedEncodedPath}\\)\\n?`, 'g');
	const rawRegex = new RegExp(`!\\[${escapedFilename}\\]\\(${escapedRawPath}\\)\\n?`, 'g');
	return content.replace(encodedRegex, '').replace(rawRegex, '');
};

/**
 * Custom hook for managing image attachments in the Auto Run editor.
 *
 * This hook provides:
 * - Image paste handling from clipboard
 * - Manual file upload via file input
 * - Attachment list and preview management
 * - Lightbox viewing with navigation and deletion
 * - Automatic markdown reference insertion/removal
 *
 * Usage:
 * ```tsx
 * const {
 *   attachmentsList,
 *   attachmentPreviews,
 *   attachmentsExpanded,
 *   setAttachmentsExpanded,
 *   lightboxFilename,
 *   lightboxExternalUrl,
 *   fileInputRef,
 *   handlePaste,
 *   handleFileSelect,
 *   handleRemoveAttachment,
 *   openLightboxByFilename,
 *   closeLightbox,
 *   handleLightboxNavigate,
 *   handleLightboxDelete,
 * } = useAutoRunImageHandling({
 *   folderPath,
 *   selectedFile,
 *   localContent,
 *   setLocalContent,
 *   handleContentChange,
 *   isLocked,
 *   textareaRef,
 *   pushUndoState,
 *   lastUndoSnapshotRef,
 * });
 * ```
 */
export function useAutoRunImageHandling({
	folderPath,
	selectedFile,
	localContent,
	setLocalContent,
	handleContentChange,
	isLocked,
	textareaRef,
	pushUndoState,
	lastUndoSnapshotRef,
	sshRemoteId,
}: UseAutoRunImageHandlingDeps): UseAutoRunImageHandlingReturn {
	// Attachment state
	const [attachmentsList, setAttachmentsList] = useState<string[]>([]);
	const [attachmentPreviews, setAttachmentPreviews] = useState<Map<string, string>>(new Map());
	const [attachmentsExpanded, setAttachmentsExpanded] = useState(true);

	// Lightbox state
	const [lightboxFilename, setLightboxFilename] = useState<string | null>(null);
	const [lightboxExternalUrl, setLightboxExternalUrl] = useState<string | null>(null);

	// File input ref
	const fileInputRef = useRef<HTMLInputElement>(null);

	// Load existing images for the current document from the Auto Run folder
	useEffect(() => {
		if (folderPath && selectedFile) {
			let isStale = false;

			setAttachmentsList([]);
			setAttachmentPreviews(new Map());

			window.maestro.autorun
				.listImages(folderPath, selectedFile)
				.then(
					(result: {
						success: boolean;
						images?: { filename: string; relativePath: string }[];
						error?: string;
					}) => {
						if (isStale) return;
						if (result.success && result.images) {
							// Store relative paths (e.g., "images/{docName}-{timestamp}.{ext}")
							const relativePaths = result.images.map(
								(img: { filename: string; relativePath: string }) => img.relativePath
							);
							setAttachmentsList(relativePaths);
							// Load previews for existing images
							result.images.forEach((img: { filename: string; relativePath: string }) => {
								const absolutePath = `${folderPath}/${img.relativePath}`;
								window.maestro.fs
									.readFile(absolutePath, sshRemoteId)
									.then((dataUrl) => {
										if (isStale) return;
										if (dataUrl.startsWith('data:')) {
											setAttachmentPreviews((prev) => new Map(prev).set(img.relativePath, dataUrl));
										}
									})
									.catch(() => {
										// Image file might be missing, ignore
									});
							});
						} else {
							setAttachmentsList([]);
							setAttachmentPreviews(new Map());
						}
					}
				)
				.catch(() => {
					if (isStale) return;
					setAttachmentsList([]);
					setAttachmentPreviews(new Map());
				});

			return () => {
				isStale = true;
			};
		} else {
			// Clear attachments when no document is selected
			setAttachmentsList([]);
			setAttachmentPreviews(new Map());
		}
	}, [folderPath, selectedFile, sshRemoteId]);

	// Handle image paste
	const handlePaste = useCallback(
		async (e: React.ClipboardEvent) => {
			if (isLocked || !folderPath || !selectedFile) {
				return;
			}

			const items = e.clipboardData?.items;
			if (!items) {
				return;
			}

			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (item.type.startsWith('image/')) {
					e.preventDefault();

					const file = item.getAsFile();
					if (!file) {
						continue;
					}

					// Read as base64
					const reader = new FileReader();
					reader.onload = async (event) => {
						const base64Data = event.target?.result as string;
						if (!base64Data) {
							return;
						}

						// Extract the base64 content without the data URL prefix
						const base64Content = base64Data.replace(/^data:image\/\w+;base64,/, '');
						const extension = item.type.split('/')[1] || 'png';

						// Save to Auto Run folder using the new API
						const result = await window.maestro.autorun.saveImage(
							folderPath,
							selectedFile,
							base64Content,
							extension
						);
						if (result.success && result.relativePath) {
							// Update attachments list with the relative path
							const filename = result.relativePath.split('/').pop() || result.relativePath;
							setAttachmentsList((prev) => [...prev, result.relativePath!]);
							setAttachmentPreviews((prev) => new Map(prev).set(result.relativePath!, base64Data));

							// Insert markdown reference at cursor position using relative path
							const textarea = textareaRef.current;
							if (textarea) {
								const cursorPos = textarea.selectionStart;
								const textBefore = localContent.substring(0, cursorPos);
								const textAfter = localContent.substring(cursorPos);
								// URL-encode the path to handle spaces and special characters
								const encodedPath = result
									.relativePath!.split('/')
									.map((part) => encodeURIComponent(part))
									.join('/');
								const imageMarkdown = `![${filename}](${encodedPath})`;

								// Push undo state before modifying content
								pushUndoState();

								// Add newlines if not at start of line
								let prefix = '';
								let suffix = '';
								if (textBefore.length > 0 && !textBefore.endsWith('\n')) {
									prefix = '\n';
								}
								if (textAfter.length > 0 && !textAfter.startsWith('\n')) {
									suffix = '\n';
								}

								const newContent = textBefore + prefix + imageMarkdown + suffix + textAfter;
								// Update local state and sync to parent immediately for explicit user action
								setLocalContent(newContent);
								handleContentChange(newContent);
								lastUndoSnapshotRef.current = newContent;

								// Move cursor after the inserted markdown
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
					break; // Only handle first image
				}
			}
		},
		[
			localContent,
			isLocked,
			handleContentChange,
			folderPath,
			selectedFile,
			pushUndoState,
			setLocalContent,
			textareaRef,
			lastUndoSnapshotRef,
		]
	);

	// Handle file input for manual image upload
	const handleFileSelect = useCallback(
		async (e: React.ChangeEvent<HTMLInputElement>) => {
			const file = e.target.files?.[0];
			if (!file || !folderPath || !selectedFile) return;

			const reader = new FileReader();
			reader.onload = async (event) => {
				const base64Data = event.target?.result as string;
				if (!base64Data) return;

				// Extract the base64 content without the data URL prefix
				const base64Content = base64Data.replace(/^data:image\/\w+;base64,/, '');
				const extension = file.name.split('.').pop() || 'png';

				// Save to Auto Run folder using the new API
				const result = await window.maestro.autorun.saveImage(
					folderPath,
					selectedFile,
					base64Content,
					extension
				);
				if (result.success && result.relativePath) {
					const filename = result.relativePath.split('/').pop() || result.relativePath;
					setAttachmentsList((prev) => [...prev, result.relativePath!]);
					setAttachmentPreviews((prev) => new Map(prev).set(result.relativePath!, base64Data));

					// Push undo state before modifying content
					pushUndoState();

					// Insert at end of content - update local and sync to parent immediately
					// URL-encode the path to handle spaces and special characters
					const encodedPath = result
						.relativePath!.split('/')
						.map((part) => encodeURIComponent(part))
						.join('/');
					const imageMarkdown = `\n![${filename}](${encodedPath})\n`;
					const newContent = localContent + imageMarkdown;
					setLocalContent(newContent);
					handleContentChange(newContent);
					lastUndoSnapshotRef.current = newContent;
				}
			};
			reader.readAsDataURL(file);

			// Reset input so same file can be selected again
			e.target.value = '';
		},
		[
			localContent,
			handleContentChange,
			folderPath,
			selectedFile,
			pushUndoState,
			setLocalContent,
			lastUndoSnapshotRef,
		]
	);

	// Handle removing an attachment (relativePath is like "images/{docName}-{timestamp}.{ext}")
	const handleRemoveAttachment = useCallback(
		async (relativePath: string) => {
			if (!folderPath) return;

			// Delete the image file
			await window.maestro.autorun.deleteImage(folderPath, relativePath);
			setAttachmentsList((prev) => prev.filter((f) => f !== relativePath));
			setAttachmentPreviews((prev) => {
				const newMap = new Map(prev);
				newMap.delete(relativePath);
				return newMap;
			});

			// Push undo state before modifying content
			pushUndoState();

			// Remove the markdown reference from content - update local and sync to parent immediately
			// The markdown content uses URL-encoded paths, so we need to match the encoded version
			const newContent = removeImageMarkdownReference(localContent, relativePath);
			setLocalContent(newContent);
			handleContentChange(newContent);
			lastUndoSnapshotRef.current = newContent;

			// Clear from cache
			imageCache.delete(`${folderPath}:${relativePath}`);
		},
		[
			localContent,
			handleContentChange,
			folderPath,
			pushUndoState,
			setLocalContent,
			lastUndoSnapshotRef,
		]
	);

	// Lightbox helpers - handles both attachment filenames and external URLs
	const openLightboxByFilename = useCallback((filenameOrUrl: string) => {
		// Check if it's an external URL (http/https/data:)
		if (
			filenameOrUrl.startsWith('http://') ||
			filenameOrUrl.startsWith('https://') ||
			filenameOrUrl.startsWith('data:')
		) {
			setLightboxExternalUrl(filenameOrUrl);
			setLightboxFilename(filenameOrUrl); // Use URL as display name
		} else {
			// It's an attachment filename
			setLightboxExternalUrl(null);
			setLightboxFilename(filenameOrUrl);
		}
	}, []);

	const closeLightbox = useCallback(() => {
		setLightboxFilename(null);
		setLightboxExternalUrl(null);
	}, []);

	// Handle lightbox navigation
	const handleLightboxNavigate = useCallback((filename: string | null) => {
		setLightboxFilename(filename);
	}, []);

	// Handle lightbox delete - removes attachment and cleans up content
	const handleLightboxDelete = useCallback(
		async (relativePath: string) => {
			if (!folderPath) return;

			// Delete the image file using autorun API
			await window.maestro.autorun.deleteImage(folderPath, relativePath);
			setAttachmentsList((prev) => prev.filter((f) => f !== relativePath));
			setAttachmentPreviews((prev) => {
				const newMap = new Map(prev);
				newMap.delete(relativePath);
				return newMap;
			});

			// Push undo state before modifying content
			pushUndoState();

			// Remove the markdown reference from content - update local and sync to parent immediately
			// The markdown content uses URL-encoded paths, so we need to match the encoded version
			const newContent = removeImageMarkdownReference(localContent, relativePath);
			setLocalContent(newContent);
			handleContentChange(newContent);
			lastUndoSnapshotRef.current = newContent;

			// Clear from cache
			imageCache.delete(`${folderPath}:${relativePath}`);
		},
		[
			folderPath,
			localContent,
			handleContentChange,
			pushUndoState,
			setLocalContent,
			lastUndoSnapshotRef,
		]
	);

	return {
		attachmentsList,
		attachmentPreviews,
		attachmentsExpanded,
		setAttachmentsExpanded,
		lightboxFilename,
		lightboxExternalUrl,
		fileInputRef,
		handlePaste,
		handleFileSelect,
		handleRemoveAttachment,
		openLightboxByFilename,
		closeLightbox,
		handleLightboxNavigate,
		handleLightboxDelete,
	};
}
