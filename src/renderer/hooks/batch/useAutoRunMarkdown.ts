import { useState, useEffect, useMemo, useCallback } from 'react';
import type { RefObject } from 'react';
import type { Theme } from '../../types';
import type { FileNode } from '../../types/fileTree';
import { getEncoder } from '../../utils/tokenCounter';
import {
	REMARK_GFM_PLUGINS,
	generateAutoRunProseStyles,
	createMarkdownComponents,
} from '../../utils/markdownConfig';
import { remarkFileLinks, buildFileTreeIndices } from '../../utils/remarkFileLinks';
import { getHomeDir, getHomeDirAsync } from '../../utils/homeDir';
import { MermaidRenderer } from '../../components/MermaidRenderer';
import { AttachmentImage } from '../../components/AutoRun/AttachmentImage';
import React from 'react';
import { openUrl } from '../../utils/openUrl';
import { countMarkdownTasks } from './batchUtils';
import { logger } from '../../utils/logger';

export interface UseAutoRunMarkdownParams {
	theme: Theme;
	savedContent: string;
	folderPath: string | null;
	sshRemoteId?: string;
	documentTree?: Array<{
		name: string;
		type: 'file' | 'folder';
		path: string;
		children?: unknown[];
	}>;
	onSelectDocument: (filename: string) => void;
	// Search state
	searchOpen: boolean;
	searchQuery: string;
	totalMatches: number;
	currentMatchIndex: number;
	handleMatchRendered: (index: number, element: HTMLElement) => void;
	// Image click
	openLightboxByFilename: (filename: string) => void;
	// Preview ref for anchor scrolling
	previewRef: RefObject<HTMLElement>;
	// Bionify reading mode (opt-in per preview surface)
	enableBionifyReadingMode?: boolean;
	bionifyIntensity?: number;
	bionifyAlgorithm?: string;
}

export interface UseAutoRunMarkdownReturn {
	proseStyles: string;
	taskCounts: { completed: number; total: number };
	tokenCount: number | null;
	remarkPlugins: any[];
	markdownComponents: any;
}

export function useAutoRunMarkdown({
	theme,
	savedContent,
	folderPath,
	sshRemoteId,
	documentTree,
	onSelectDocument,
	searchOpen,
	searchQuery,
	totalMatches,
	currentMatchIndex,
	handleMatchRendered,
	openLightboxByFilename,
	previewRef,
	enableBionifyReadingMode = false,
	bionifyIntensity,
	bionifyAlgorithm,
}: UseAutoRunMarkdownParams): UseAutoRunMarkdownReturn {
	// 1. Memoize prose CSS styles - only regenerate when theme changes
	const proseStyles = useMemo(() => generateAutoRunProseStyles(theme), [theme]);

	// 2. Parse task counts from saved content only (not live during editing)
	const taskCounts = useMemo(() => {
		const counts = countMarkdownTasks(savedContent);
		return { completed: counts.checked, total: counts.total };
	}, [savedContent]);

	// 3. Token counting based on saved content only (not live during editing)
	// Uses a stale flag to discard results from previous effect runs
	const [tokenCount, setTokenCount] = useState<number | null>(null);
	useEffect(() => {
		if (!savedContent) {
			setTokenCount(null);
			return;
		}

		let isActive = true;

		getEncoder()
			.then((encoder) => {
				if (!isActive) return;
				const tokens = encoder.encode(savedContent);
				setTokenCount(tokens.length);
			})
			.catch((err) => {
				if (!isActive) return;
				logger.error('Failed to count tokens:', undefined, err);
				setTokenCount(null);
			});

		return () => {
			isActive = false;
		};
	}, [savedContent]);

	// 4. Convert documentTree to FileNode format for remarkFileLinks
	const fileTree = useMemo((): FileNode[] => {
		if (!documentTree) return [];
		const convert = (nodes: typeof documentTree): FileNode[] => {
			return nodes.map((node) => ({
				name: node.name,
				type: node.type,
				fullPath: node.path,
				children: node.children ? convert(node.children as typeof documentTree) : undefined,
			}));
		};
		return convert(documentTree);
	}, [documentTree]);

	// 5. Handle file link clicks - navigate to the document
	const handleFileClick = useCallback(
		(filePath: string) => {
			// filePath from remarkFileLinks will be like "Note.md" or "Subfolder/Note.md"
			// onSelectDocument expects the path without extension for simple files,
			// or the full relative path for nested files
			const pathWithoutExt = filePath.replace(/\.md$/, '');
			onSelectDocument(pathWithoutExt);
		},
		[onSelectDocument]
	);

	// 6. Memoize file tree indices to avoid O(n) traversal on every render
	const fileTreeIndices = useMemo(() => {
		if (fileTree.length > 0) {
			return buildFileTreeIndices(fileTree);
		}
		return null;
	}, [fileTree]);

	// 7. Resolve homeDir for tilde path expansion
	const [homeDir, setHomeDir] = useState<string | undefined>(getHomeDir);
	useEffect(() => {
		if (!homeDir) {
			getHomeDirAsync()?.then(setHomeDir);
		}
	}, [homeDir]);

	// 8. Memoize remarkPlugins - include remarkFileLinks when we have file tree
	const remarkPlugins = useMemo(() => {
		const plugins: any[] = [...REMARK_GFM_PLUGINS];
		if (fileTree.length > 0 || homeDir) {
			// cwd is empty since we're at the root of the Auto Run folder
			plugins.push([remarkFileLinks, { indices: fileTreeIndices || undefined, cwd: '', homeDir }]);
		}
		return plugins;
	}, [fileTree, fileTreeIndices, homeDir]);

	// 9. Base markdown components - stable unless theme, folderPath, or callbacks change
	// Separated from search highlighting to prevent rebuilds on every search state change
	const baseMarkdownComponents = useMemo(() => {
		const components = createMarkdownComponents({
			theme,
			customLanguageRenderers: {
				mermaid: ({ code, theme: t }) =>
					React.createElement(MermaidRenderer, { chart: code, theme: t }),
			},
			// Handle internal file links (wiki-style [[links]])
			onFileClick: handleFileClick,
			// Open external links in system browser
			onExternalLinkClick: (href, opts) => openUrl(href, opts),
			// Provide container ref for anchor link scrolling
			containerRef: previewRef,
			// No search highlighting here - added separately when needed
			enableBionifyReadingMode,
			bionifyIntensity,
			bionifyAlgorithm,
		});

		// Add custom image renderer for AttachmentImage
		return {
			...components,
			img: ({ src, alt, ...props }: any) =>
				React.createElement(AttachmentImage, {
					src,
					alt,
					folderPath,
					sshRemoteId,
					theme,
					onImageClick: openLightboxByFilename,
					...props,
				}),
		};
	}, [
		theme,
		folderPath,
		sshRemoteId,
		openLightboxByFilename,
		handleFileClick,
		enableBionifyReadingMode,
		bionifyIntensity,
		bionifyAlgorithm,
	]);

	// 10. Search-highlighted components - only used in preview mode with active search
	// This allows the base components to remain stable during editing
	const searchHighlightedComponents = useMemo(() => {
		// Only create search-highlighted components when actually needed
		if (!searchOpen || !searchQuery.trim() || totalMatches === 0) {
			return null;
		}

		const components = createMarkdownComponents({
			theme,
			customLanguageRenderers: {
				mermaid: ({ code, theme: t }) =>
					React.createElement(MermaidRenderer, { chart: code, theme: t }),
			},
			onFileClick: handleFileClick,
			onExternalLinkClick: (href, opts) => openUrl(href, opts),
			containerRef: previewRef,
			// Disable Bionify transforms while searching so match highlights stay visible.
			enableBionifyReadingMode: false,
			searchHighlight: {
				query: searchQuery,
				currentMatchIndex,
				onMatchRendered: handleMatchRendered,
			},
		});

		return {
			...components,
			img: ({ src, alt, ...props }: any) =>
				React.createElement(AttachmentImage, {
					src,
					alt,
					folderPath,
					sshRemoteId,
					theme,
					onImageClick: openLightboxByFilename,
					...props,
				}),
		};
	}, [
		theme,
		folderPath,
		sshRemoteId,
		openLightboxByFilename,
		handleFileClick,
		searchOpen,
		searchQuery,
		totalMatches,
		currentMatchIndex,
		handleMatchRendered,
	]);

	// 11. Use search-highlighted components when available, otherwise use base components
	const markdownComponents = searchHighlightedComponents || baseMarkdownComponents;

	return {
		proseStyles,
		taskCounts,
		tokenCount,
		remarkPlugins,
		markdownComponents,
	};
}
