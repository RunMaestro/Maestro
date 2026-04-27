/**
 * FolderPickerSheet — server-driven folder browser for the mobile/web Auto Run
 * panel. Mirrors desktop's `dialog.selectFolder` flow: navigate the tree,
 * confirm a folder, and the selection is persisted on the session via the
 * `set_auto_run_folder` WebSocket message (which routes through the renderer
 * to update `autoRunFolderPath` and reload docs).
 *
 * Why server-driven: web clients don't have filesystem access, and the File
 * System Access API only works in Chromium and gives the wrong path semantics.
 * The server already exposes `get_file_tree` for the Files tab, so we reuse it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import type { UseWebSocketReturn } from '../hooks/useWebSocket';

interface FileNode {
	name: string;
	type: 'file' | 'folder';
	children?: FileNode[];
	path: string;
}

export interface FolderPickerSheetProps {
	sessionId: string;
	/** Path to start browsing from — typically the session's `cwd`. */
	startPath: string;
	/** Pre-select this folder when opening (e.g. the current `autoRunFolderPath`). */
	initialPath?: string | null;
	onClose: () => void;
	onConfirm: (folderPath: string) => Promise<void> | void;
	sendRequest: UseWebSocketReturn['sendRequest'];
}

export function FolderPickerSheet({
	sessionId,
	startPath,
	initialPath,
	onClose,
	onConfirm,
	sendRequest,
}: FolderPickerSheetProps) {
	const colors = useThemeColors();
	const [tree, setTree] = useState<FileNode[]>([]);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [selected, setSelected] = useState<string | null>(initialPath ?? null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [isVisible, setIsVisible] = useState(false);
	const sheetRef = useRef<HTMLDivElement>(null);

	// Slide-in animation
	useEffect(() => {
		const id = requestAnimationFrame(() => setIsVisible(true));
		return () => cancelAnimationFrame(id);
	}, []);

	const handleClose = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setIsVisible(false);
		setTimeout(() => onClose(), 200);
	}, [onClose]);

	// Load tree on mount; uses get_file_tree (folders + files), filters to folders
	// in render so the user only picks directories.
	useEffect(() => {
		if (!startPath) return;
		setLoading(true);
		setError(null);
		sendRequest<{ tree: FileNode[]; error?: string }>('get_file_tree', {
			sessionId,
			path: startPath,
			maxDepth: 4,
		})
			.then((response) => {
				setTree(response.tree || []);
				if (response.error) setError(response.error);
				setLoading(false);
			})
			.catch((err: { message?: string }) => {
				setError(err?.message || 'Failed to load folders');
				setLoading(false);
			});
	}, [sendRequest, startPath, sessionId]);

	// Auto-expand ancestors of the initially-selected folder so the user can see
	// where they came from when they reopen the picker after a change.
	useEffect(() => {
		if (!initialPath) return;
		const parts = initialPath.split('/');
		const ancestors = new Set<string>();
		let acc = '';
		for (const part of parts) {
			acc = acc ? `${acc}/${part}` : part;
			ancestors.add(acc);
		}
		setExpanded((prev) => new Set([...prev, ...ancestors]));
	}, [initialPath]);

	const toggleFolder = useCallback((path: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}, []);

	const handleSelect = useCallback((path: string) => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setSelected(path);
	}, []);

	const handleConfirm = useCallback(async () => {
		if (!selected || submitting) return;
		setSubmitting(true);
		try {
			await onConfirm(selected);
			triggerHaptic(HAPTIC_PATTERNS.success);
			handleClose();
		} catch (err: unknown) {
			triggerHaptic(HAPTIC_PATTERNS.error);
			const message = err instanceof Error ? err.message : String(err);
			setError(message || 'Failed to set folder');
			setSubmitting(false);
		}
	}, [selected, submitting, onConfirm, handleClose]);

	// Close on Escape; keep nested dialogs (none currently) able to intercept first
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') handleClose();
			if (e.key === 'Enter' && selected && !submitting) handleConfirm();
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [handleClose, handleConfirm, selected, submitting]);

	const renderNode = (node: FileNode, depth: number): JSX.Element | null => {
		if (node.type !== 'folder') return null;
		const isExpanded = expanded.has(node.path);
		const isSelected = selected === node.path;
		return (
			<div key={node.path}>
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: '6px',
						padding: '8px 12px',
						paddingLeft: `${12 + depth * 16}px`,
						borderRadius: '6px',
						backgroundColor: isSelected ? `${colors.accent}20` : 'transparent',
						color: isSelected ? colors.accent : colors.textMain,
						cursor: 'pointer',
						touchAction: 'manipulation',
						WebkitTapHighlightColor: 'transparent',
						minHeight: '40px',
					}}
					onClick={() => handleSelect(node.path)}
				>
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							toggleFolder(node.path);
						}}
						style={{
							width: '24px',
							height: '24px',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							border: 'none',
							background: 'transparent',
							color: 'inherit',
							cursor: 'pointer',
							flexShrink: 0,
						}}
						aria-label={isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.5"
							strokeLinecap="round"
							strokeLinejoin="round"
							style={{
								transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
								transition: 'transform 0.15s ease',
							}}
						>
							<polyline points="9 18 15 12 9 6" />
						</svg>
					</button>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						style={{ flexShrink: 0 }}
					>
						<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
					</svg>
					<span
						style={{
							fontSize: '14px',
							fontWeight: isSelected ? 600 : 500,
							flex: 1,
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							whiteSpace: 'nowrap',
						}}
					>
						{node.name}
					</span>
				</div>
				{isExpanded && node.children && (
					<div>{node.children.map((child) => renderNode(child, depth + 1))}</div>
				)}
			</div>
		);
	};

	const folderRows = useMemo(
		() => tree.map((node) => renderNode(node, 0)).filter(Boolean),
		[tree, expanded, selected, colors]
	);

	return (
		<>
			{/* Backdrop */}
			<div
				onClick={handleClose}
				style={{
					position: 'fixed',
					top: 0,
					left: 0,
					right: 0,
					bottom: 0,
					backgroundColor: isVisible ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0)',
					zIndex: 250,
					transition: 'background-color 0.2s ease',
				}}
				aria-hidden="true"
			/>
			<div
				ref={sheetRef}
				role="dialog"
				aria-label="Choose Auto Run folder"
				style={{
					position: 'fixed',
					left: 0,
					right: 0,
					bottom: 0,
					maxHeight: '85dvh',
					backgroundColor: colors.bgMain,
					borderTopLeftRadius: '16px',
					borderTopRightRadius: '16px',
					boxShadow: '0 -4px 16px rgba(0, 0, 0, 0.3)',
					zIndex: 251,
					display: 'flex',
					flexDirection: 'column',
					transform: isVisible ? 'translateY(0)' : 'translateY(100%)',
					transition: 'transform 0.2s ease-out',
					paddingBottom: 'env(safe-area-inset-bottom)',
				}}
			>
				{/* Header */}
				<header
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
						padding: '12px 16px',
						borderBottom: `1px solid ${colors.border}`,
						flexShrink: 0,
					}}
				>
					<div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
						<h2 style={{ fontSize: '16px', fontWeight: 600, margin: 0, color: colors.textMain }}>
							Auto Run folder
						</h2>
						<p
							style={{
								fontSize: '12px',
								color: colors.textDim,
								margin: 0,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: 'nowrap',
							}}
							title={selected || startPath}
						>
							{selected || startPath || 'Pick a folder'}
						</p>
					</div>
					<button
						type="button"
						onClick={handleClose}
						style={{
							width: '40px',
							height: '40px',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							borderRadius: '8px',
							backgroundColor: 'transparent',
							border: `1px solid ${colors.border}`,
							color: colors.textMain,
							cursor: 'pointer',
							touchAction: 'manipulation',
							flexShrink: 0,
						}}
						aria-label="Close folder picker"
					>
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</header>

				{/* Body — folder tree */}
				<div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px' }}>
					{loading && (
						<div style={{ padding: '24px', textAlign: 'center', color: colors.textDim }}>
							Loading folders...
						</div>
					)}
					{!loading && error && (
						<div
							style={{
								margin: '8px 4px',
								padding: '10px 12px',
								borderRadius: '8px',
								backgroundColor: `${colors.error}15`,
								color: colors.error,
								fontSize: '13px',
							}}
						>
							{error}
						</div>
					)}
					{!loading && !error && folderRows.length === 0 && (
						<div style={{ padding: '24px', textAlign: 'center', color: colors.textDim }}>
							No folders here.
						</div>
					)}
					{folderRows}
				</div>

				{/* Footer — Cancel + Confirm */}
				<footer
					style={{
						display: 'flex',
						gap: '8px',
						padding: '12px 16px',
						borderTop: `1px solid ${colors.border}`,
						flexShrink: 0,
					}}
				>
					<button
						type="button"
						onClick={handleClose}
						disabled={submitting}
						style={{
							flex: 1,
							padding: '12px',
							borderRadius: '8px',
							border: `1px solid ${colors.border}`,
							backgroundColor: 'transparent',
							color: colors.textMain,
							fontSize: '14px',
							fontWeight: 500,
							cursor: submitting ? 'not-allowed' : 'pointer',
							opacity: submitting ? 0.5 : 1,
						}}
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleConfirm}
						disabled={!selected || submitting}
						style={{
							flex: 1,
							padding: '12px',
							borderRadius: '8px',
							border: 'none',
							backgroundColor: !selected || submitting ? `${colors.accent}40` : colors.accent,
							color: 'white',
							fontSize: '14px',
							fontWeight: 600,
							cursor: !selected || submitting ? 'not-allowed' : 'pointer',
						}}
					>
						{submitting ? 'Setting…' : 'Use this folder'}
					</button>
				</footer>
			</div>
		</>
	);
}

export default FolderPickerSheet;
