/**
 * LocalImage - loads local images referenced from markdown via IPC.
 *
 * Extracted from MarkdownRenderer so the unified renderer and any future
 * surface can share the same loader + module-level cache. Resolves `file://`
 * and bare file paths through `window.maestro.fs.readFile`; HTTP(S) and data
 * URLs render immediately. The cache prevents flicker when react-markdown
 * rebuilds the component tree during streaming.
 */

import React, { memo, useEffect, useMemo, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { Spinner } from '../../ui/Spinner';
import type { Theme } from '../../../types';

// Module-level cache for local images to prevent flicker on re-render.
// Bounded with simple FIFO eviction so a long-lived session that scrolls
// through many images doesn't grow the cache (and its data-URL strings)
// without limit. Map preserves insertion order, so the first key is the oldest.
const MAX_CACHED_IMAGES = 200;
const localImageCache = new Map<string, string>();

function cacheLocalImage(filePath: string, dataUrl: string): void {
	if (localImageCache.size >= MAX_CACHED_IMAGES) {
		const oldest = localImageCache.keys().next().value;
		if (oldest !== undefined) localImageCache.delete(oldest);
	}
	localImageCache.set(filePath, dataUrl);
}

export interface LocalImageProps {
	src?: string;
	alt?: string;
	theme: Theme;
	/** Optional width in pixels (from `![[image|300]]` syntax) */
	width?: number;
	/** SSH remote ID for remote file operations */
	sshRemoteId?: string;
}

// Helper to compute initial image state synchronously from cache.
// This prevents flickering when ReactMarkdown rebuilds the component tree.
function getLocalImageInitialState(src: string | undefined) {
	if (!src) {
		return { dataUrl: null, loading: false };
	}

	// Data URLs are ready immediately
	if (src.startsWith('data:')) {
		return { dataUrl: src, loading: false };
	}

	// HTTP URLs are ready immediately (browser handles loading)
	if (src.startsWith('http://') || src.startsWith('https://')) {
		return { dataUrl: src, loading: false };
	}

	// Check cache for file paths
	let filePath = src;
	if (src.startsWith('file://')) {
		filePath = decodeURIComponent(src.replace('file://', ''));
	}

	if (localImageCache.has(filePath)) {
		return { dataUrl: localImageCache.get(filePath)!, loading: false };
	}

	// Need to load
	return { dataUrl: null, loading: true };
}

export const LocalImage = memo(({ src, alt, theme, width, sshRemoteId }: LocalImageProps) => {
	// Compute initial state synchronously from cache to prevent flicker
	const initialState = useMemo(() => getLocalImageInitialState(src), [src]);

	const [dataUrl, setDataUrl] = useState<string | null>(initialState.dataUrl);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(initialState.loading);

	useEffect(() => {
		// If we already have data from cache, skip loading
		if (initialState.dataUrl) {
			return;
		}

		let isStale = false;

		if (!src) {
			setLoading(false);
			return;
		}

		// For file:// URLs, extract the path and load via IPC
		let filePath = src;
		if (src.startsWith('file://')) {
			filePath = decodeURIComponent(src.replace('file://', ''));
		}

		// Double-check cache
		if (localImageCache.has(filePath)) {
			setDataUrl(localImageCache.get(filePath)!);
			setLoading(false);
			return;
		}

		window.maestro.fs
			.readFile(filePath, sshRemoteId)
			.then((result) => {
				if (isStale) return;
				if (result && result.startsWith('data:')) {
					cacheLocalImage(filePath, result);
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

		return () => {
			isStale = true;
		};
	}, [src, sshRemoteId, initialState.dataUrl]);

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
				className="inline-flex items-center gap-2 px-3 py-2 rounded text-xs"
				style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
				title={error}
			>
				<ImageOff className="w-4 h-4" />
				<span>{alt || 'Image'}</span>
			</span>
		);
	}

	if (!dataUrl) {
		return null;
	}

	// Build style based on whether width is specified
	const imageStyle: React.CSSProperties = width
		? { width: `${width}px`, height: 'auto', borderRadius: '4px' }
		: { maxWidth: '100%', height: 'auto', borderRadius: '4px' };

	return <img src={dataUrl} alt={alt || ''} style={imageStyle} />;
});

LocalImage.displayName = 'LocalImage';
