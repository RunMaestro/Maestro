import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { FileText, Image, Play } from 'lucide-react';
import { Spinner } from '../ui/Spinner';
import { imageCache } from './filePreviewUtils';
import { safeDecodeURIComponent } from '../../../shared/stringUtils';
import { getBasename } from '../../../shared/formatters';
import { getFileExtension, IMAGE_FILE_EXTENSIONS } from '../../../shared/fileCategories';
import { getMediaKind } from '../../../shared/mediaTypes';
import {
	findFirstExistingPath,
	parseEmbedAltSize,
	resolveEmbedCandidates,
	type FileTreeIndices,
} from '../../utils/fileLinks';

interface MarkdownImageProps {
	src?: string;
	alt?: string;
	markdownFilePath: string;
	theme: any;
	showRemoteImages?: boolean;
	/** Root the file tree and vault-root paths are relative to, when known. */
	projectRoot?: string;
	/** The user's home folder, for `~/` references. */
	homeDir?: string;
	/** File tree indices relative to `projectRoot`, for the nearest-match lookup. */
	fileTreeIndices?: FileTreeIndices | null;
	/** Width in pixels from an `![[image|300]]` embed. An alt `|300` suffix also sets it. */
	width?: number;
	/** Opens a non-image embed (audio and video go to the media player). */
	onOpenFile?: (absolutePath: string) => void;
	sshRemoteId?: string;
}

/** What a local embed renders as, from its extension. */
type EmbedKind = 'image' | 'media' | 'file';

function embedKind(src: string): EmbedKind {
	if (getMediaKind(src)) return 'media';
	const ext = getFileExtension(src);
	// No extension keeps the old behavior: try it as an image.
	return !ext || IMAGE_FILE_EXTENSIONS.has(ext) ? 'image' : 'file';
}

/**
 * Renders a markdown embed (`![caption](path)`, or an `![[name]]` the file
 * tree resolved) in the File Preview. The path is resolved by
 * `resolveEmbedCandidates`, which tries every convention an author's tool may
 * have used (note-relative, vault-root, nearest match in the file tree, `~/`),
 * and the first candidate that exists wins. Images render inline through a
 * global cache that prevents re-fetching and flicker; audio, video, and other
 * files render as a chip that opens them.
 */
export const MarkdownImage = React.memo(function MarkdownImage(props: MarkdownImageProps) {
	const { src, markdownFilePath, projectRoot, homeDir, fileTreeIndices } = props;
	const isRemoteUrl = src?.startsWith('http://') || src?.startsWith('https://');

	// Every on-disk reading of the source, most likely first, as clean absolute
	// paths (no ssh: namespacing). These reach readFile / the remote shell, so
	// they must NOT carry the cache-key prefix.
	const candidatePaths = useMemo(() => {
		if (!src) return [];
		if (src.startsWith('data:') || isRemoteUrl) return [src];
		// mdast-util-to-hast percent-encodes every destination, so a path with a
		// space arrives as `%20` and must be decoded before it reaches disk.
		return resolveEmbedCandidates(safeDecodeURIComponent(src), {
			markdownFilePath,
			projectRoot,
			homeDir,
			indices: fileTreeIndices,
		});
	}, [src, isRemoteUrl, markdownFilePath, projectRoot, homeDir, fileTreeIndices]);

	const kind: EmbedKind =
		!src || src.startsWith('data:') || isRemoteUrl
			? 'image'
			: embedKind(safeDecodeURIComponent(src));

	if (kind === 'image') {
		return <EmbeddedImage {...props} candidatePaths={candidatePaths} isRemoteUrl={!!isRemoteUrl} />;
	}
	return <EmbeddedFileChip {...props} kind={kind} candidatePaths={candidatePaths} />;
});

function EmbeddedImage({
	src,
	alt,
	theme,
	showRemoteImages = false,
	width,
	sshRemoteId,
	candidatePaths,
	isRemoteUrl,
}: MarkdownImageProps & { candidatePaths: string[]; isRemoteUrl: boolean }) {
	const [dataUrl, setDataUrl] = useState<string | null>(null);
	const [dimensions, setDimensions] = useState<{ width?: number; height?: number }>({});
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const parsedAlt = parseEmbedAltSize(alt);
	const sizedWidth = parsedAlt.width ?? width;
	const sizedHeight = parsedAlt.height;
	const resolvedPath = candidatePaths[0] ?? null;

	// Cache key namespaces the resolved path by sshRemoteId so the same path on
	// different remotes (or local vs remote) doesn't collide in the shared cache.
	// Used ONLY as a map key - never passed to readFile. Keyed on the first
	// candidate, so a hit through a fallback path is found again on re-render.
	const cacheKey = useMemo(() => {
		if (!resolvedPath) return null;
		if (resolvedPath.startsWith('data:')) return resolvedPath;
		const prefix = sshRemoteId ? `ssh:${sshRemoteId}:` : '';
		return `${prefix}${resolvedPath}`;
	}, [resolvedPath, sshRemoteId]);

	useEffect(() => {
		setError(null);

		if (!src || !cacheKey) {
			setDataUrl(null);
			setLoading(false);
			if (src && !cacheKey) setError(`Image not found: ${safeDecodeURIComponent(src)}`);
			return;
		}

		// Check cache first (skip cached remote images when toggle is off)
		const cached = imageCache.get(cacheKey);
		if (cached && !(isRemoteUrl && !showRemoteImages)) {
			setDataUrl(cached.dataUrl);
			setDimensions({ width: cached.width, height: cached.height });
			setLoading(false);
			return;
		}

		// If it's already a data URL, use it directly and cache
		if (src.startsWith('data:')) {
			setDataUrl(src);
			setLoading(false);
			imageCache.set(cacheKey, { dataUrl: src, loadedAt: Date.now() });
			return;
		}

		// If it's an HTTP(S) URL, handle based on showRemoteImages setting
		if (isRemoteUrl) {
			if (showRemoteImages) {
				setDataUrl(src);
				imageCache.set(cacheKey, { dataUrl: src, loadedAt: Date.now() });
			} else {
				setDataUrl(null);
			}
			setLoading(false);
			return;
		}

		// Local files load via IPC (supports SSH remote). readFile returns null for
		// a missing file, so the walk moves on to the next reading of the path.
		let cancelled = false;
		const missingLabel = safeDecodeURIComponent(src);
		setLoading(true);
		findFirstExistingPath(candidatePaths, (path) => window.maestro.fs.readFile(path, sshRemoteId))
			.then((hit) => {
				if (cancelled) return;
				if (hit?.value.startsWith('data:')) {
					setDataUrl(hit.value);
					imageCache.set(cacheKey, { dataUrl: hit.value, loadedAt: Date.now() });
				} else {
					setError(hit ? 'Invalid image data' : `Image not found: ${missingLabel}`);
				}
				setLoading(false);
			})
			.catch((err) => {
				if (cancelled) return;
				setError(`Failed to load image: ${err.message || 'Unknown error'}`);
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [src, cacheKey, candidatePaths, showRemoteImages, isRemoteUrl, sshRemoteId]);

	// Handle image load to get dimensions and update cache
	const handleImageLoad = useCallback(
		(e: React.SyntheticEvent<HTMLImageElement>) => {
			const img = e.currentTarget;
			const naturalWidth = img.naturalWidth;
			const naturalHeight = img.naturalHeight;
			setDimensions({ width: naturalWidth, height: naturalHeight });

			if (cacheKey && dataUrl) {
				const cached = imageCache.get(cacheKey);
				if (cached) {
					imageCache.set(cacheKey, { ...cached, width: naturalWidth, height: naturalHeight });
				}
			}
		},
		[cacheKey, dataUrl]
	);

	if (loading) {
		return (
			<span
				className="inline-flex items-center gap-2 px-3 py-2 rounded my-2"
				style={{
					backgroundColor: theme.colors.bgActivity,
					minHeight: '100px',
					minWidth: '200px',
				}}
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
				className="inline-flex items-center gap-2 px-3 py-2 rounded my-2"
				style={{
					backgroundColor: theme.colors.bgActivity,
					border: `1px solid ${theme.colors.error}`,
				}}
				title={candidatePaths.length > 0 ? `Tried:\n${candidatePaths.join('\n')}` : undefined}
			>
				<Image className="w-4 h-4" style={{ color: theme.colors.error }} />
				<span className="text-xs" style={{ color: theme.colors.error }}>
					{error}
				</span>
			</span>
		);
	}

	// Show placeholder for blocked remote images
	if (!dataUrl && isRemoteUrl && !showRemoteImages) {
		return (
			<span
				className="inline-flex items-center gap-2 px-3 py-2 rounded my-2"
				style={{
					backgroundColor: theme.colors.bgActivity,
					border: `1px dashed ${theme.colors.border}`,
				}}
			>
				<Image className="w-4 h-4" style={{ color: theme.colors.textDim }} />
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Remote image blocked
				</span>
			</span>
		);
	}

	if (!dataUrl) {
		return null;
	}

	return (
		<img
			src={dataUrl}
			alt={parsedAlt.alt}
			className="max-w-full rounded my-2 block"
			style={{
				border: `1px solid ${theme.colors.border}`,
				...(sizedWidth ? { width: `${sizedWidth}px` } : {}),
				...(sizedHeight ? { height: `${sizedHeight}px` } : {}),
				...(dimensions.width && dimensions.height && !sizedHeight
					? { aspectRatio: `${dimensions.width} / ${dimensions.height}` }
					: {}),
			}}
			onLoad={handleImageLoad}
		/>
	);
}

/**
 * A non-image embed: audio, video, or any other file. Resolved the same way as
 * an image, then shown as a chip that opens the file. `onOpenFile` routes
 * through the normal file-open path, which sends audio and video to the
 * floating media player rather than a tab.
 */
function EmbeddedFileChip({
	src,
	alt,
	theme,
	sshRemoteId,
	onOpenFile,
	kind,
	candidatePaths,
}: MarkdownImageProps & { kind: Exclude<EmbedKind, 'image'>; candidatePaths: string[] }) {
	// undefined = still probing, null = not found.
	const [resolved, setResolved] = useState<string | null | undefined>(undefined);
	const label = parseEmbedAltSize(alt).alt || getBasename(safeDecodeURIComponent(src ?? ''));

	useEffect(() => {
		let cancelled = false;
		setResolved(undefined);
		findFirstExistingPath(candidatePaths, (path) =>
			window.maestro.fs.stat(path, sshRemoteId).then((stat) => stat ?? null)
		)
			.then((hit) => {
				if (!cancelled) setResolved(hit?.path ?? null);
			})
			.catch(() => {
				if (!cancelled) setResolved(null);
			});
		return () => {
			cancelled = true;
		};
	}, [candidatePaths, sshRemoteId]);

	const missing = resolved === null;
	const Icon = kind === 'media' ? Play : FileText;
	const color = missing ? theme.colors.error : theme.colors.accent;
	const openable = !!resolved && !!onOpenFile;

	return (
		<button
			type="button"
			disabled={!openable}
			onClick={(e) => {
				// An embed wrapped in a link: the chip's own action wins.
				e.preventDefault();
				e.stopPropagation();
				if (resolved && onOpenFile) onOpenFile(resolved);
			}}
			className="inline-flex items-center gap-2 px-3 py-1.5 rounded my-1 text-xs align-middle"
			style={{
				backgroundColor: theme.colors.bgActivity,
				border: `1px solid ${missing ? theme.colors.error : theme.colors.border}`,
				color,
				cursor: openable ? 'pointer' : 'default',
			}}
			title={
				missing ? `Not found. Tried:\n${candidatePaths.join('\n')}` : (resolved ?? 'Locating...')
			}
		>
			{resolved === undefined ? (
				<Spinner size={12} color={theme.colors.textDim} />
			) : (
				<Icon className="w-3.5 h-3.5" />
			)}
			<span>{missing ? `Not found: ${label}` : label}</span>
		</button>
	);
}
