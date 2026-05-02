import { useState, useRef, useEffect, useMemo, memo } from 'react';
import { Image, X, Search, PenLine } from 'lucide-react';
import { Spinner } from '../ui/Spinner';
import { imageCache } from '../../hooks';
import type { Theme } from '../../types';

// Safe wrapper around safeDecodeURIComponent that falls back to original string on malformed URIs
function safeDecodeURIComponent(str: string): string {
	try {
		return safeDecodeURIComponent(str);
	} catch {
		return str;
	}
}

// Helper to compute initial image state synchronously from cache
// This prevents flickering when ReactMarkdown rebuilds the component tree
export function getInitialImageState(src: string | undefined, folderPath: string | null) {
	if (!src) {
		return { dataUrl: null, loading: false, filename: null };
	}

	const decodedSrc = safeDecodeURIComponent(src);

	// Check cache for relative paths
	if (decodedSrc.startsWith('images/') && folderPath) {
		const cacheKey = `${folderPath}:${decodedSrc}`;
		if (imageCache.has(cacheKey)) {
			return {
				dataUrl: imageCache.get(cacheKey)!,
				loading: false,
				filename: decodedSrc.split('/').pop() || decodedSrc,
			};
		}
	}

	// Data URLs are ready immediately
	if (src.startsWith('data:')) {
		return { dataUrl: src, loading: false, filename: null };
	}

	// HTTP URLs are ready immediately (browser handles loading)
	if (src.startsWith('http://') || src.startsWith('https://')) {
		return { dataUrl: src, loading: false, filename: null };
	}

	// Check cache for other relative paths
	if (folderPath) {
		const cacheKey = `${folderPath}:${src}`;
		if (imageCache.has(cacheKey)) {
			return {
				dataUrl: imageCache.get(cacheKey)!,
				loading: false,
				filename: src.split('/').pop() || null,
			};
		}
	}

	// Need to load - return loading state
	return { dataUrl: null, loading: true, filename: src.split('/').pop() || null };
}

// Custom image component that loads images from the Auto Run folder or external URLs
// Memoized to prevent re-renders and image reloading when parent updates
export const AttachmentImage = memo(function AttachmentImage({
	src,
	alt,
	folderPath,
	sshRemoteId,
	theme,
	onImageClick,
}: {
	src?: string;
	alt?: string;
	folderPath: string | null;
	sshRemoteId?: string;
	theme: Theme;
	onImageClick?: (filename: string) => void;
}) {
	// Compute initial state synchronously from cache to prevent flicker
	const initialState = useMemo(() => getInitialImageState(src, folderPath), [src, folderPath]);

	const [dataUrl, setDataUrl] = useState<string | null>(initialState.dataUrl);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(initialState.loading);
	const [filename, setFilename] = useState<string | null>(initialState.filename);

	// Sync local state when src/folderPath props change (initialState recalculates via useMemo)
	const prevInitialStateRef = useRef(initialState);
	useEffect(() => {
		if (prevInitialStateRef.current !== initialState) {
			setDataUrl(initialState.dataUrl);
			setLoading(initialState.loading);
			setFilename(initialState.filename);
			setError(null);
			prevInitialStateRef.current = initialState;
		}
	}, [initialState]);

	// Use ref for onImageClick to avoid re-running effect when callback changes
	const onImageClickRef = useRef(onImageClick);
	onImageClickRef.current = onImageClick;

	useEffect(() => {
		// If we already have data from cache (initialState), skip loading
		if (initialState.dataUrl) {
			return;
		}

		// Track whether this effect is stale (component unmounted or src changed)
		let isStale = false;

		if (!src) {
			setLoading(false);
			return;
		}

		// Decode URL-encoded paths (e.g., "images/Image%20Test.png" -> "images/Image Test.png")
		const decodedSrc = safeDecodeURIComponent(src);

		// Check if this is a relative path (e.g., images/{docName}-{timestamp}.{ext})
		if (decodedSrc.startsWith('images/') && folderPath) {
			const fname = decodedSrc.split('/').pop() || decodedSrc;
			setFilename(fname);
			const cacheKey = `${folderPath}:${decodedSrc}`;

			// Double-check cache (in case it was populated after initial render)
			if (imageCache.has(cacheKey)) {
				setDataUrl(imageCache.get(cacheKey)!);
				setLoading(false);
				return;
			}

			// Load from folder using absolute path
			const absolutePath = `${folderPath}/${decodedSrc}`;
			window.maestro.fs
				.readFile(absolutePath, sshRemoteId)
				.then((result) => {
					if (isStale) return;
					if (result && result.startsWith('data:')) {
						imageCache.set(cacheKey, result);
						setDataUrl(result);
					} else {
						setError('Invalid image data');
					}
					setLoading(false);
				})
				.catch((err) => {
					if (isStale) return;
					setError(`Failed to load image: ${err.message || 'Unknown error'}`);
					setLoading(false);
				});
		} else if (src.startsWith('/')) {
			// Absolute file path - load via IPC
			setFilename(src.split('/').pop() || null);
			window.maestro.fs
				.readFile(src, sshRemoteId)
				.then((result) => {
					if (isStale) return;
					if (result && result.startsWith('data:')) {
						setDataUrl(result);
					} else {
						setError('Invalid image data');
					}
					setLoading(false);
				})
				.catch((err) => {
					if (isStale) return;
					setError(`Failed to load image: ${err.message || 'Unknown error'}`);
					setLoading(false);
				});
		} else {
			// Other relative path - try to load as file from folderPath if available
			setFilename(src.split('/').pop() || null);
			const cacheKey = folderPath ? `${folderPath}:${src}` : src;

			// Double-check cache
			if (imageCache.has(cacheKey)) {
				setDataUrl(imageCache.get(cacheKey)!);
				setLoading(false);
				return;
			}

			const pathToLoad = folderPath ? `${folderPath}/${src}` : src;
			window.maestro.fs
				.readFile(pathToLoad, sshRemoteId)
				.then((result) => {
					if (isStale) return;
					if (result && result.startsWith('data:')) {
						if (folderPath) {
							imageCache.set(cacheKey, result);
						}
						setDataUrl(result);
					} else {
						setError('Invalid image data');
					}
					setLoading(false);
				})
				.catch((err) => {
					if (isStale) return;
					setError(`Failed to load image: ${err.message || 'Unknown error'}`);
					setLoading(false);
				});
		}

		return () => {
			isStale = true;
		};
	}, [src, folderPath, sshRemoteId, initialState.dataUrl]);

	if (loading) {
		return (
			<span
				className="inline-flex items-center gap-2 px-3 py-2 rounded"
				style={{ backgroundColor: theme.colors.bgActivity }}
			>
				<Spinner size={16} color={theme.colors.textDim} />
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Loading image...
				</span>
			</span>
		);
	}

	if (error) {
		return (
			<span
				className="inline-flex items-center gap-2 px-3 py-2 rounded"
				style={{
					backgroundColor: theme.colors.bgActivity,
					borderColor: theme.colors.error,
					border: '1px solid',
				}}
			>
				<Image className="w-4 h-4" style={{ color: theme.colors.error }} />
				<span className="text-xs" style={{ color: theme.colors.error }}>
					{error}
				</span>
			</span>
		);
	}

	if (!dataUrl) {
		return null;
	}

	// For lightbox, pass the decoded path (which matches attachmentsList)
	// rather than the URL-encoded src from markdown
	const decodedSrcForClick = src ? safeDecodeURIComponent(src) : '';
	return (
		<span
			className="inline-block align-middle mx-1 my-1 cursor-pointer group relative"
			onClick={() => onImageClickRef.current?.(decodedSrcForClick)}
			title={filename ? `Click to enlarge: ${filename}` : 'Click to enlarge'}
		>
			<img
				src={dataUrl}
				alt={alt || ''}
				className="rounded border hover:opacity-90 transition-all hover:shadow-lg"
				style={{
					maxHeight: '120px',
					maxWidth: '200px',
					objectFit: 'contain',
					borderColor: theme.colors.border,
				}}
			/>
			{/* Zoom hint overlay */}
			<span
				className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded"
				style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
			>
				<Search className="w-5 h-5 text-white" />
			</span>
		</span>
	);
});

// Image preview thumbnail for staged images in edit mode
export function ImagePreview({
	src,
	filename,
	theme,
	onRemove,
	onImageClick,
	onAnnotate,
}: {
	src: string;
	filename: string;
	theme: Theme;
	onRemove: () => void;
	onImageClick: (filename: string) => void;
	onAnnotate?: () => void;
}) {
	return (
		<div className="relative inline-block group" style={{ margin: '4px' }}>
			<img
				src={src}
				alt={filename}
				className="w-20 h-20 object-cover rounded cursor-pointer hover:opacity-80 transition-opacity"
				style={{ border: `1px solid ${theme.colors.border}` }}
				onClick={() => onImageClick(filename)}
			/>
			{onAnnotate && (
				<button
					onClick={(e) => {
						e.stopPropagation();
						onAnnotate();
					}}
					title="Annotate image"
					className="absolute -top-2 -left-2 w-5 h-5 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
					style={{
						backgroundColor: theme.colors.bgActivity,
						color: theme.colors.textMain,
					}}
				>
					<PenLine className="w-3 h-3" />
				</button>
			)}
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
