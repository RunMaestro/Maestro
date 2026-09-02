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
import remarkFrontmatter from 'remark-frontmatter';
import { remarkFrontmatterTable } from '../../utils/remarkFrontmatterTable';
import { remarkAlert } from '../../components/Markdown/remarkAlert';
import { remarkMaestroMarkers } from '../../components/Markdown/remarkMaestroMarkers';
import {
	remarkFileLinks,
	buildFileTreeIndices,
	mergeFileTreeIndices,
} from '../../utils/remarkFileLinks';
import { getHomeDir, getHomeDirAsync } from '../../utils/homeDir';
import { MermaidRenderer } from '../../components/MermaidRenderer';
import { AttachmentImage } from '../../components/AutoRun/AttachmentImage';
import React from 'react';
import { openUrl } from '../../utils/openUrl';
import { countMarkdownTasks } from './batchUtils';
import { logger } from '../../utils/logger';
import { useStableCallback } from '../utils/useStableCallback';

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
	/**
	 * The agent's project file tree (the Files panel's tree, rooted at
	 * `projectRoot`). An Auto Run document lives inside the project but its own
	 * folder tree only covers the playbooks directory, so without this a
	 * `[[Notes/Thing]]` pointing anywhere else in the project stays inert text
	 * here while the same link works in a file-preview tab.
	 */
	projectFileTree?: FileNode[];
	/** Absolute path the project file tree is rooted at. */
	projectRoot?: string;
	/** Opens a project file (path relative to `projectRoot`, or absolute). */
	onOpenProjectFile?: (path: string, options?: { openInNewTab?: boolean }) => void;
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
	/**
	 * Enables clickable task checkboxes in the preview. Receives the 1-based
	 * source line of the task; resolves false when the write did not happen.
	 */
	onTaskToggle?: (sourceLine: number) => Promise<boolean>;
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
	projectFileTree,
	projectRoot,
	onOpenProjectFile,
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
	onTaskToggle,
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

	// 5. Memoize file tree indices to avoid O(n) traversal on every render.
	// Two roots feed link resolution here: the Auto Run folder (a hit switches
	// the panel to that playbook) and the agent's project (a hit opens a file
	// preview tab, matching every other markdown surface).
	const autoRunIndices = useMemo(() => {
		if (fileTree.length > 0) {
			return buildFileTreeIndices(fileTree);
		}
		return null;
	}, [fileTree]);

	const projectIndices = useMemo(() => {
		if (projectFileTree && projectFileTree.length > 0) {
			return buildFileTreeIndices(projectFileTree);
		}
		return null;
	}, [projectFileTree]);

	// Auto Run first so a basename living in both trees still resolves to the
	// playbook - findClosestMatch's proximity tiebreak walks candidates in order.
	const fileTreeIndices = useMemo(() => {
		if (!autoRunIndices) return projectIndices;
		if (!projectIndices) return autoRunIndices;
		return mergeFileTreeIndices(autoRunIndices, projectIndices);
	}, [autoRunIndices, projectIndices]);

	// 6. Handle file link clicks. The resolved path tells us which tree it came
	// from: anything the Auto Run folder owns switches the selected document,
	// everything else is a project file and opens where the user reads files.
	const handleFileClick = useCallback(
		(filePath: string, options?: { openInNewTab?: boolean }) => {
			if (!autoRunIndices || autoRunIndices.allPaths.has(filePath)) {
				// filePath from remarkFileLinks will be like "Note.md" or "Subfolder/Note.md"
				// onSelectDocument expects the path without extension for simple files,
				// or the full relative path for nested files
				const pathWithoutExt = filePath.replace(/\.md$/, '');
				onSelectDocument(pathWithoutExt);
				return;
			}
			if (onOpenProjectFile) {
				onOpenProjectFile(filePath, options);
				return;
			}
			const pathWithoutExt = filePath.replace(/\.md$/, '');
			onSelectDocument(pathWithoutExt);
		},
		[autoRunIndices, onSelectDocument, onOpenProjectFile]
	);

	// 7. Resolve homeDir for tilde path expansion
	const [homeDir, setHomeDir] = useState<string | undefined>(getHomeDir);
	useEffect(() => {
		if (!homeDir) {
			getHomeDirAsync()?.then(setHomeDir);
		}
	}, [homeDir]);

	// 8. Memoize remarkPlugins - include remarkFileLinks when we have file tree
	const remarkPlugins = useMemo(() => {
		const plugins: any[] = [
			...REMARK_GFM_PLUGINS,
			remarkAlert,
			remarkFrontmatter,
			remarkFrontmatterTable,
			// Marker pills matter most here: this is the panel with the Run button,
			// so a gate or halt that will block the run has to be visible from it.
			remarkMaestroMarkers,
		];
		if (fileTreeIndices || homeDir || projectRoot) {
			// cwd is empty since we're at the root of the Auto Run folder. Keeping it
			// empty is also what makes a bare `[[Note]]` prefer the playbook over a
			// deeper project path with the same basename.
			plugins.push([
				remarkFileLinks,
				{ indices: fileTreeIndices || undefined, cwd: '', projectRoot, homeDir },
			]);
		}
		return plugins;
	}, [fileTreeIndices, projectRoot, homeDir]);

	// 9. Task toggling, pinned to one identity. A toggle handler naturally closes
	// over the document content, so it is reborn on every edit - and rebuilding
	// the component map below remounts the whole rendered document, throwing away
	// the reader's scroll position. Stabilizing here means no caller can cause
	// that by writing an ordinary useCallback.
	const stableTaskToggle = useStableCallback(
		(sourceLine: number): Promise<boolean> =>
			onTaskToggle ? onTaskToggle(sourceLine) : Promise.resolve(false)
	);
	// Presence still has to reach the factory: passing nothing keeps checkboxes
	// read-only, which is how a locked document stays locked.
	const taskToggle = onTaskToggle ? stableTaskToggle : undefined;

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
			onTaskToggle: taskToggle,
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
		taskToggle,
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
			onTaskToggle: taskToggle,
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
		taskToggle,
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
