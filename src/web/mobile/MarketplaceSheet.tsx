/**
 * MarketplaceSheet component for Maestro mobile web interface
 *
 * Bottom sheet for browsing and importing Playbook Exchange playbooks.
 * Mirrors the desktop MarketplaceModal flow (list → detail → import) but
 * uses a slide-up sheet UX consistent with the rest of the mobile UI.
 *
 * Server-side resolves the autoRunFolderPath and SSH config from the
 * session, so the sheet only needs sessionId + the chosen playbook id.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import { MobileMarkdownRenderer } from './MobileMarkdownRenderer';
import type { MarketplaceManifest, MarketplacePlaybook } from '../../shared/marketplace-types';

export interface MarketplaceSheetProps {
	sessionId: string;
	sendRequest: <T = any>(
		type: string,
		payload?: Record<string, unknown>,
		timeoutMs?: number
	) => Promise<T>;
	/** Called after a successful import so the parent can refresh AutoRun docs. */
	onImported: (folderName: string) => void;
	onClose: () => void;
}

interface ManifestResponse {
	success: boolean;
	error?: string;
	manifest?: MarketplaceManifest;
	fromCache?: boolean;
	cacheAge?: number;
}

interface DocumentResponse {
	success: boolean;
	error?: string;
	content?: string;
}

interface ReadmeResponse {
	success: boolean;
	error?: string;
	content?: string | null;
}

interface ImportResponse {
	success: boolean;
	error?: string;
	playbook?: { id: string; name: string };
}

function defaultFolderNameFor(playbook: MarketplacePlaybook): string {
	return playbook.title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

export function MarketplaceSheet({
	sessionId,
	sendRequest,
	onImported,
	onClose,
}: MarketplaceSheetProps) {
	const colors = useThemeColors();

	// Sheet animation state
	const [isVisible, setIsVisible] = useState(false);

	// Manifest + filter state
	const [manifest, setManifest] = useState<MarketplaceManifest | null>(null);
	const [isLoadingManifest, setIsLoadingManifest] = useState(true);
	const [manifestError, setManifestError] = useState<string | null>(null);
	const [selectedCategory, setSelectedCategory] = useState('All');
	const [searchQuery, setSearchQuery] = useState('');

	// Detail view state
	const [selectedPlaybook, setSelectedPlaybook] = useState<MarketplacePlaybook | null>(null);
	const [readmeContent, setReadmeContent] = useState<string | null>(null);
	const [selectedDocFilename, setSelectedDocFilename] = useState<string | null>(null);
	const [documentContent, setDocumentContent] = useState<string | null>(null);
	const [isLoadingDocument, setIsLoadingDocument] = useState(false);
	const [targetFolderName, setTargetFolderName] = useState('');

	// Import state
	const [isImporting, setIsImporting] = useState(false);
	const [importError, setImportError] = useState<string | null>(null);
	// Preview-fetch errors (README / document load) — shown in the preview
	// area, not in the import footer, so users aren't misled into thinking
	// an import failed when only the preview fetch did.
	const [previewError, setPreviewError] = useState<string | null>(null);

	// Monotonic preview-request id. Each new playbook/document request bumps
	// it; resolved fetches that don't match are discarded. Prevents a slow
	// README/document response from clobbering a newer selection.
	const previewRequestIdRef = useRef(0);

	const handleClose = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setIsVisible(false);
		setTimeout(() => onClose(), 300);
	}, [onClose]);

	useEffect(() => {
		requestAnimationFrame(() => setIsVisible(true));
	}, []);

	// Close on escape
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			if (selectedPlaybook) {
				setSelectedPlaybook(null);
				setReadmeContent(null);
				setSelectedDocFilename(null);
				setDocumentContent(null);
				setTargetFolderName('');
				setImportError(null);
				setPreviewError(null);
			} else {
				handleClose();
			}
		};
		document.addEventListener('keydown', handler);
		return () => document.removeEventListener('keydown', handler);
	}, [handleClose, selectedPlaybook]);

	// Load manifest on mount
	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			setIsLoadingManifest(true);
			setManifestError(null);
			try {
				const result = await sendRequest<ManifestResponse>('marketplace_get_manifest');
				if (cancelled) return;
				if (result?.success && result.manifest) {
					setManifest(result.manifest);
				} else {
					setManifestError(result?.error || 'Failed to load marketplace data');
				}
			} catch (err) {
				if (cancelled) return;
				// Web bundle has no Sentry, so log the underlying exception to
				// devtools — without this the catch only surfaces the typed
				// "Failed to load …" message and the original cause is lost.
				console.error('[MarketplaceSheet] marketplace_get_manifest failed', err);
				setManifestError(err instanceof Error ? err.message : 'Failed to load marketplace data');
			}
			if (!cancelled) setIsLoadingManifest(false);
		};
		load();
		return () => {
			cancelled = true;
		};
	}, [sendRequest]);

	const playbooks = manifest?.playbooks ?? [];

	const categories = useMemo(() => {
		if (!manifest) return ['All'];
		const cats = new Set(manifest.playbooks.map((p) => p.category));
		return ['All', ...Array.from(cats).sort()];
	}, [manifest]);

	const filteredPlaybooks = useMemo(() => {
		let filtered = playbooks;
		if (selectedCategory !== 'All') {
			filtered = filtered.filter((p) => p.category === selectedCategory);
		}
		if (searchQuery.trim()) {
			const q = searchQuery.trim().toLowerCase();
			filtered = filtered.filter(
				(p) =>
					p.title.toLowerCase().includes(q) ||
					p.description.toLowerCase().includes(q) ||
					(p.tags && p.tags.some((t) => t.toLowerCase().includes(q)))
			);
		}
		return filtered;
	}, [playbooks, selectedCategory, searchQuery]);

	// Fetch the README for `playbook` and update preview state. Extracted so
	// both `handleSelectPlaybook` (initial load) and `handleSelectDocument(null)`
	// (back-from-doc) share the same fetch path — without this, returning from
	// a doc preview can leave the sheet stuck on the previous error / "No
	// README available" placeholder when the initial README fetch failed.
	const loadReadmeFor = useCallback(
		async (playbook: MarketplacePlaybook) => {
			setIsLoadingDocument(true);
			const requestId = ++previewRequestIdRef.current;
			try {
				const result = await sendRequest<ReadmeResponse>('marketplace_get_readme', {
					playbookPath: playbook.path,
				});
				if (previewRequestIdRef.current !== requestId) return;
				if (result?.success === false) {
					setReadmeContent(null);
					setPreviewError(result.error ?? 'Failed to load README');
				} else {
					setReadmeContent(result?.content ?? null);
				}
			} catch (err) {
				if (previewRequestIdRef.current !== requestId) return;
				console.error('[MarketplaceSheet] marketplace_get_readme failed', err);
				setReadmeContent(null);
				setPreviewError(err instanceof Error ? err.message : 'Failed to load README');
			}
			if (previewRequestIdRef.current === requestId) setIsLoadingDocument(false);
		},
		[sendRequest]
	);

	const handleSelectPlaybook = useCallback(
		async (playbook: MarketplacePlaybook) => {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			setSelectedPlaybook(playbook);
			setSelectedDocFilename(null);
			setDocumentContent(null);
			setTargetFolderName(defaultFolderNameFor(playbook));
			setImportError(null);
			setPreviewError(null);
			await loadReadmeFor(playbook);
		},
		[loadReadmeFor]
	);

	const handleSelectDocument = useCallback(
		async (filename: string | null) => {
			if (!selectedPlaybook) return;
			if (filename === null) {
				// Returning to the README view from a doc preview. Cancel any
				// in-flight document fetch (bump the request id), clear stale
				// preview error state, and re-load the README — the user may
				// have arrived here after the initial README fetch failed or
				// after a doc fetch errored, and the sheet would otherwise stay
				// stuck on that error / "No README available" placeholder.
				++previewRequestIdRef.current;
				setSelectedDocFilename(null);
				setDocumentContent(null);
				setPreviewError(null);
				await loadReadmeFor(selectedPlaybook);
				return;
			}
			setSelectedDocFilename(filename);
			setPreviewError(null);
			setIsLoadingDocument(true);
			const requestId = ++previewRequestIdRef.current;
			try {
				const result = await sendRequest<DocumentResponse>('marketplace_get_document', {
					playbookPath: selectedPlaybook.path,
					filename,
				});
				if (previewRequestIdRef.current !== requestId) return;
				if (result?.success === false) {
					setDocumentContent(null);
					setPreviewError(result.error ?? 'Failed to load document');
				} else {
					setDocumentContent(result?.content ?? null);
				}
			} catch (err) {
				if (previewRequestIdRef.current !== requestId) return;
				console.error('[MarketplaceSheet] marketplace_get_document failed', err);
				setDocumentContent(null);
				setPreviewError(err instanceof Error ? err.message : 'Failed to load document');
			}
			if (previewRequestIdRef.current === requestId) setIsLoadingDocument(false);
		},
		[selectedPlaybook, sendRequest]
	);

	const handleImport = useCallback(async () => {
		if (!selectedPlaybook || !targetFolderName.trim()) return;
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setIsImporting(true);
		setImportError(null);
		try {
			const result = await sendRequest<ImportResponse>(
				'marketplace_import_playbook',
				{
					sessionId,
					playbookId: selectedPlaybook.id,
					targetFolderName: targetFolderName.trim(),
				},
				30000
			);
			if (result?.success) {
				triggerHaptic(HAPTIC_PATTERNS.success);
				onImported(targetFolderName.trim());
				handleClose();
			} else {
				triggerHaptic(HAPTIC_PATTERNS.error);
				setImportError(result?.error || 'Import failed');
			}
		} catch (err) {
			console.error('[MarketplaceSheet] marketplace_import_playbook failed', err);
			triggerHaptic(HAPTIC_PATTERNS.error);
			setImportError(err instanceof Error ? err.message : 'Import failed');
		}
		setIsImporting(false);
	}, [handleClose, onImported, selectedPlaybook, sendRequest, sessionId, targetFolderName]);

	const handleBackdropTap = useCallback(
		(e: React.MouseEvent) => {
			if (e.target === e.currentTarget) handleClose();
		},
		[handleClose]
	);

	const renderListView = () => (
		<>
			{/* Category chips */}
			<div
				style={{
					display: 'flex',
					gap: '6px',
					padding: '0 16px 8px',
					overflowX: 'auto',
					flexShrink: 0,
					WebkitOverflowScrolling: 'touch',
				}}
			>
				{categories.map((cat) => {
					const active = cat === selectedCategory;
					return (
						<button
							key={cat}
							onClick={() => {
								triggerHaptic(HAPTIC_PATTERNS.tap);
								setSelectedCategory(cat);
							}}
							style={{
								padding: '8px 12px',
								borderRadius: '999px',
								border: `1px solid ${active ? colors.accent : colors.border}`,
								backgroundColor: active ? colors.accent : 'transparent',
								color: active ? 'white' : colors.textMain,
								fontSize: '13px',
								fontWeight: active ? 600 : 500,
								whiteSpace: 'nowrap',
								touchAction: 'manipulation',
								WebkitTapHighlightColor: 'transparent',
								cursor: 'pointer',
								flexShrink: 0,
							}}
						>
							{cat}
						</button>
					);
				})}
			</div>

			{/* Search input */}
			<div style={{ padding: '0 16px 12px', flexShrink: 0 }}>
				<input
					type="search"
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
					placeholder="Search playbooks..."
					style={{
						width: '100%',
						padding: '10px 12px',
						borderRadius: '10px',
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.bgSidebar,
						color: colors.textMain,
						fontSize: '14px',
						outline: 'none',
						boxSizing: 'border-box',
						WebkitAppearance: 'none',
					}}
				/>
			</div>

			{/* Tile list */}
			<div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 16px' }}>
				{isLoadingManifest ? (
					<div style={{ textAlign: 'center', padding: '32px 0', color: colors.textDim }}>
						Loading playbooks...
					</div>
				) : manifestError ? (
					<div style={{ textAlign: 'center', padding: '32px 0', color: colors.error }}>
						{manifestError}
					</div>
				) : filteredPlaybooks.length === 0 ? (
					<div style={{ textAlign: 'center', padding: '32px 0', color: colors.textDim }}>
						{searchQuery ? 'No matching playbooks' : 'No playbooks available'}
					</div>
				) : (
					<div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
						{filteredPlaybooks.map((p) => (
							<button
								key={p.id}
								onClick={() => handleSelectPlaybook(p)}
								style={{
									display: 'block',
									width: '100%',
									padding: '12px 14px',
									borderRadius: '10px',
									border: `1px solid ${colors.border}`,
									backgroundColor: colors.bgSidebar,
									color: colors.textMain,
									textAlign: 'left',
									cursor: 'pointer',
									touchAction: 'manipulation',
									WebkitTapHighlightColor: 'transparent',
								}}
							>
								<div
									style={{
										display: 'flex',
										gap: '6px',
										alignItems: 'center',
										marginBottom: '4px',
										flexWrap: 'wrap',
									}}
								>
									<span
										style={{
											fontSize: '11px',
											padding: '2px 6px',
											borderRadius: '4px',
											backgroundColor: `${colors.accent}20`,
											color: colors.accent,
											fontWeight: 600,
										}}
									>
										{p.category}
									</span>
									{p.source === 'local' && (
										<span
											style={{
												fontSize: '11px',
												padding: '2px 6px',
												borderRadius: '4px',
												backgroundColor: '#3b82f620',
												color: '#3b82f6',
												fontWeight: 600,
											}}
										>
											Local
										</span>
									)}
								</div>
								<div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '2px' }}>
									{p.title}
								</div>
								<div
									style={{
										fontSize: '13px',
										color: colors.textDim,
										display: '-webkit-box',
										WebkitLineClamp: 2,
										WebkitBoxOrient: 'vertical',
										overflow: 'hidden',
									}}
								>
									{p.description}
								</div>
								<div
									style={{
										fontSize: '11px',
										color: colors.textDim,
										marginTop: '4px',
										display: 'flex',
										justifyContent: 'space-between',
									}}
								>
									<span>{p.author}</span>
									<span>{p.documents.length} docs</span>
								</div>
							</button>
						))}
					</div>
				)}
			</div>
		</>
	);

	const renderDetailView = () => {
		if (!selectedPlaybook) return null;
		const docOptions: Array<{ filename: string | null; label: string }> = [
			{ filename: null, label: 'README.md' },
			...selectedPlaybook.documents.map((d) => ({
				filename: d.filename,
				label: `${d.filename}.md`,
			})),
		];
		const previewContent =
			selectedDocFilename === null
				? (readmeContent ?? '*No README available*')
				: (documentContent ?? '*Document not found*');

		return (
			<>
				{/* Detail header */}
				<div
					style={{
						padding: '0 16px 8px',
						display: 'flex',
						alignItems: 'center',
						gap: '12px',
						flexShrink: 0,
					}}
				>
					<button
						onClick={() => {
							triggerHaptic(HAPTIC_PATTERNS.tap);
							setSelectedPlaybook(null);
							setReadmeContent(null);
							setDocumentContent(null);
							setSelectedDocFilename(null);
							setTargetFolderName('');
							setImportError(null);
							setPreviewError(null);
						}}
						style={{
							width: '36px',
							height: '36px',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							borderRadius: '8px',
							backgroundColor: colors.bgSidebar,
							border: `1px solid ${colors.border}`,
							color: colors.textMain,
							cursor: 'pointer',
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
							flexShrink: 0,
						}}
						aria-label="Back to list"
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
							<polyline points="15 18 9 12 15 6" />
						</svg>
					</button>
					<div style={{ flex: 1, minWidth: 0 }}>
						<div
							style={{
								fontSize: '11px',
								color: colors.textDim,
								textTransform: 'uppercase',
								letterSpacing: '0.5px',
								marginBottom: '2px',
							}}
						>
							{selectedPlaybook.category}
						</div>
						<div
							style={{
								fontSize: '15px',
								fontWeight: 600,
								color: colors.textMain,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: 'nowrap',
							}}
						>
							{selectedPlaybook.title}
						</div>
					</div>
				</div>

				{/* Document selector chips */}
				<div
					style={{
						display: 'flex',
						gap: '6px',
						padding: '0 16px 8px',
						overflowX: 'auto',
						flexShrink: 0,
						WebkitOverflowScrolling: 'touch',
					}}
				>
					{docOptions.map((opt) => {
						const active = selectedDocFilename === opt.filename;
						return (
							<button
								key={opt.label}
								onClick={() => handleSelectDocument(opt.filename)}
								style={{
									padding: '6px 10px',
									borderRadius: '999px',
									border: `1px solid ${active ? colors.accent : colors.border}`,
									backgroundColor: active ? colors.accent : 'transparent',
									color: active ? 'white' : colors.textMain,
									fontSize: '12px',
									fontWeight: active ? 600 : 500,
									whiteSpace: 'nowrap',
									touchAction: 'manipulation',
									WebkitTapHighlightColor: 'transparent',
									cursor: 'pointer',
									flexShrink: 0,
								}}
							>
								{opt.label}
							</button>
						);
					})}
				</div>

				{/* Markdown preview */}
				<div
					style={{
						flex: 1,
						overflowY: 'auto',
						padding: '8px 16px',
						backgroundColor: colors.bgMain,
					}}
				>
					{isLoadingDocument ? (
						<div style={{ textAlign: 'center', padding: '24px 0', color: colors.textDim }}>
							Loading...
						</div>
					) : previewError ? (
						<div
							role="alert"
							style={{
								padding: '12px',
								borderRadius: '8px',
								border: `1px solid ${colors.error}40`,
								backgroundColor: `${colors.error}15`,
								color: colors.error,
								fontSize: '13px',
							}}
						>
							{previewError}
						</div>
					) : (
						<MobileMarkdownRenderer content={previewContent} />
					)}
				</div>

				{/* Import footer */}
				<div
					style={{
						padding: '12px 16px',
						borderTop: `1px solid ${colors.border}`,
						backgroundColor: colors.bgSidebar,
						flexShrink: 0,
						display: 'flex',
						flexDirection: 'column',
						gap: '8px',
					}}
				>
					<label
						htmlFor="marketplace-target-folder"
						style={{
							fontSize: '11px',
							fontWeight: 600,
							color: colors.textDim,
							textTransform: 'uppercase',
							letterSpacing: '0.5px',
						}}
					>
						Import to folder
					</label>
					<input
						id="marketplace-target-folder"
						type="text"
						value={targetFolderName}
						onChange={(e) => setTargetFolderName(e.target.value)}
						placeholder="folder-name"
						style={{
							width: '100%',
							padding: '10px 12px',
							borderRadius: '8px',
							border: `1px solid ${colors.border}`,
							backgroundColor: colors.bgMain,
							color: colors.textMain,
							fontSize: '14px',
							outline: 'none',
							boxSizing: 'border-box',
							WebkitAppearance: 'none',
						}}
					/>
					{importError && (
						<div style={{ fontSize: '12px', color: colors.error }}>{importError}</div>
					)}
					<button
						onClick={handleImport}
						disabled={isImporting || !targetFolderName.trim()}
						style={{
							width: '100%',
							padding: '14px 20px',
							borderRadius: '12px',
							backgroundColor:
								isImporting || !targetFolderName.trim() ? `${colors.accent}40` : colors.accent,
							border: 'none',
							color: 'white',
							fontSize: '15px',
							fontWeight: 600,
							cursor: isImporting || !targetFolderName.trim() ? 'not-allowed' : 'pointer',
							opacity: isImporting || !targetFolderName.trim() ? 0.5 : 1,
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
							minHeight: '48px',
						}}
					>
						{isImporting ? 'Importing…' : 'Import Playbook'}
					</button>
				</div>
			</>
		);
	};

	return (
		<div
			onClick={handleBackdropTap}
			style={{
				position: 'fixed',
				inset: 0,
				backgroundColor: `rgba(0, 0, 0, ${isVisible ? 0.5 : 0})`,
				zIndex: 230,
				display: 'flex',
				alignItems: 'flex-end',
				transition: 'background-color 0.3s ease-out',
			}}
		>
			<div
				style={{
					width: '100%',
					height: '90vh',
					backgroundColor: colors.bgMain,
					borderTopLeftRadius: '16px',
					borderTopRightRadius: '16px',
					display: 'flex',
					flexDirection: 'column',
					transform: isVisible ? 'translateY(0)' : 'translateY(100%)',
					transition: 'transform 0.3s ease-out',
					paddingBottom: 'max(0px, env(safe-area-inset-bottom))',
				}}
			>
				{/* Drag handle */}
				<div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px' }}>
					<div
						style={{
							width: '36px',
							height: '4px',
							borderRadius: '2px',
							backgroundColor: `${colors.textDim}40`,
						}}
					/>
				</div>

				{/* Title bar */}
				<div
					style={{
						padding: '4px 16px 12px',
						display: 'flex',
						justifyContent: 'space-between',
						alignItems: 'center',
						flexShrink: 0,
					}}
				>
					<h2
						style={{
							margin: 0,
							fontSize: '18px',
							fontWeight: 600,
							color: colors.textMain,
						}}
					>
						Playbook Exchange
					</h2>
					<button
						onClick={handleClose}
						style={{
							width: '36px',
							height: '36px',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							borderRadius: '8px',
							backgroundColor: colors.bgSidebar,
							border: `1px solid ${colors.border}`,
							color: colors.textMain,
							cursor: 'pointer',
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
						}}
						aria-label="Close"
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
				</div>

				{selectedPlaybook ? renderDetailView() : renderListView()}
			</div>
		</div>
	);
}

export default MarketplaceSheet;
