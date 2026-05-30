import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { Image } from 'lucide-react';
import { Spinner } from '../ui/Spinner';
import { imageCache, resolveImagePath } from './filePreviewUtils';

/**
 * Custom image component for markdown that loads images from file paths.
 * Uses a global cache to prevent re-fetching and flickering on re-renders.
 * Wrapped in React.memo to prevent re-renders when parent updates but image props haven't changed.
 */
export const MarkdownImage = React.memo(function MarkdownImage({
	src,
	alt,
	markdownFilePath,
	theme,
	showRemoteImages = false,
	isFromFileTree = false,
	projectRoot,
	sshRemoteId,
}: {
	src?: string;
	alt?: string;
	markdownFilePath: string;
	theme: any;
	showRemoteImages?: boolean;
	isFromFileTree?: boolean;
	projectRoot?: string;
	sshRemoteId?: string;
}) {
	const [dataUrl, setDataUrl] = useState<string | null>(null);
	const [dimensions, setDimensions] = useState<{ width?: number; height?: number }>({});
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const isRemoteUrl = src?.startsWith('http://') || src?.startsWith('https://');

	// Compute the cache key based on resolved path
	// Namespace cache keys by sshRemoteId so the same path on different remotes doesn't collide
	const cacheKey = useMemo(() => {
		if (!src) return null;
		const prefix = sshRemoteId ? `ssh:${sshRemoteId}:` : '';
		if (src.startsWith('data:')) return src; // data URLs are self-contained
		if (isRemoteUrl) return `${prefix}${src}`;

		let decodedSrc = src;
		try {
			decodedSrc = decodeURIComponent(src);
		} catch {
			// Use original if decode fails
		}

		if (isFromFileTree && projectRoot) {
			return `${prefix}${projectRoot}/${decodedSrc}`;
		}
		return `${prefix}${resolveImagePath(decodedSrc, markdownFilePath)}`;
	}, [src, markdownFilePath, isFromFileTree, projectRoot, isRemoteUrl, sshRemoteId]);

	useEffect(() => {
		setError(null);

		if (!src || !cacheKey) {
			setDataUrl(null);
			setLoading(false);
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

		// For local files, load via IPC (supports SSH remote)
		setLoading(true);
		window.maestro.fs
			.readFile(cacheKey, sshRemoteId)
			.then((result) => {
				if (result && result.startsWith('data:')) {
					setDataUrl(result);
					imageCache.set(cacheKey, { dataUrl: result, loadedAt: Date.now() });
				} else {
					setError('Invalid image data');
				}
				setLoading(false);
			})
			.catch((err) => {
				setError(`Failed to load image: ${err.message || 'Unknown error'}`);
				setLoading(false);
			});
	}, [src, cacheKey, showRemoteImages, isRemoteUrl, sshRemoteId]);

	// Handle image load to get dimensions and update cache
	const handleImageLoad = useCallback(
		(e: React.SyntheticEvent<HTMLImageElement>) => {
			const img = e.currentTarget;
			const width = img.naturalWidth;
			const height = img.naturalHeight;
			setDimensions({ width, height });

			if (cacheKey && dataUrl) {
				const cached = imageCache.get(cacheKey);
				if (cached) {
					imageCache.set(cacheKey, { ...cached, width, height });
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
			alt={alt || ''}
			className="max-w-full rounded my-2 block"
			style={{
				border: `1px solid ${theme.colors.border}`,
				...(dimensions.width && dimensions.height
					? { aspectRatio: `${dimensions.width} / ${dimensions.height}` }
					: {}),
			}}
			onLoad={handleImageLoad}
		/>
	);
});
