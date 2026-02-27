import React, { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { X, History, Sparkles, Loader2, Clapperboard, HelpCircle } from 'lucide-react';
import type { Theme } from '../../types';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { OverviewTab, type TabFocusHandle } from './OverviewTab';
import { hasCachedSynopsis } from './AIOverviewTab';
import { useSettings } from '../../hooks';

// Lazy load tab components
const UnifiedHistoryTab = lazy(() =>
	import('./UnifiedHistoryTab').then((m) => ({ default: m.UnifiedHistoryTab }))
);
const AIOverviewTab = lazy(() =>
	import('./AIOverviewTab').then((m) => ({ default: m.AIOverviewTab }))
);

interface DirectorNotesModalProps {
	theme: Theme;
	onClose: () => void;
	// Session navigation — jumps to an agent's session tab (closes modal first)
	onResumeSession?: (sourceSessionId: string, agentSessionId: string) => void;
	// File linking props passed through to history detail modal
	fileTree?: any[];
	onFileClick?: (path: string) => void;
}

type TabId = 'overview' | 'history' | 'ai-overview';

const TABS: { id: TabId; label: string; icon: React.ElementType; disabledKey?: string }[] = [
	{ id: 'overview', label: 'Help', icon: HelpCircle },
	{ id: 'history', label: 'Unified History', icon: History },
	{ id: 'ai-overview', label: 'AI Overview', icon: Sparkles, disabledKey: 'aiOverview' },
];

export function DirectorNotesModal({
	theme,
	onClose,
	onResumeSession,
	fileTree,
	onFileClick,
}: DirectorNotesModalProps) {
	const { directorNotesSettings: _directorNotesSettings, shortcuts } = useSettings();
	const cached = hasCachedSynopsis();
	const [activeTab, setActiveTab] = useState<TabId>('history');
	const [overviewReady, setOverviewReady] = useState(cached);
	const [overviewGenerating, setOverviewGenerating] = useState(false);

	// Layer stack registration for Escape handling
	const { registerLayer, unregisterLayer } = useLayerStack();
	const layerIdRef = useRef<string>();
	const modalRef = useRef<HTMLDivElement>(null);

	// Tab content refs for focus management
	const overviewTabRef = useRef<TabFocusHandle>(null);
	const historyTabRef = useRef<TabFocusHandle>(null);
	const aiOverviewContentRef = useRef<HTMLDivElement>(null);

	// Focus the active tab's content area
	const focusActiveTab = useCallback(
		(tabId?: TabId) => {
			const target = tabId ?? activeTab;
			// Delay to allow React to render/show the tab
			requestAnimationFrame(() => {
				if (target === 'overview') overviewTabRef.current?.focus();
				else if (target === 'history') historyTabRef.current?.focus();
				else if (target === 'ai-overview') aiOverviewContentRef.current?.focus();
			});
		},
		[activeTab]
	);

	// Store callbacks in refs to avoid re-registering layer when they change
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const focusActiveTabRef = useRef(focusActiveTab);
	focusActiveTabRef.current = focusActiveTab;
	const activeTabRef = useRef(activeTab);
	activeTabRef.current = activeTab;

	// Register modal layer
	useEffect(() => {
		layerIdRef.current = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.DIRECTOR_NOTES,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'lenient',
			onEscape: () => {
				// Delegate Escape to the active tab first (e.g. to close search)
				const tabRef =
					activeTabRef.current === 'history'
						? historyTabRef
						: activeTabRef.current === 'overview'
							? overviewTabRef
							: null;
				if (tabRef?.current?.onEscape?.()) return;
				onCloseRef.current();
			},
		});
		return () => {
			if (layerIdRef.current) unregisterLayer(layerIdRef.current);
		};
	}, [registerLayer, unregisterLayer]);

	// Focus the active tab content when tab changes (including initial mount)
	useEffect(() => {
		focusActiveTab(activeTab);
	}, [activeTab, focusActiveTab]);

	// Handle synopsis ready callback from AIOverviewTab
	const handleSynopsisReady = useCallback(() => {
		setOverviewGenerating(false);
		setOverviewReady(true);
	}, []);

	// Start generating indicator when modal opens (skip if cached)
	useEffect(() => {
		if (!cached) {
			setOverviewGenerating(true);
		}
	}, []);

	// Check if a tab can be navigated to
	const isTabEnabled = useCallback(
		(tabId: TabId) => {
			if (tabId === 'ai-overview') return overviewReady;
			return true;
		},
		[overviewReady]
	);

	// Navigate to adjacent tab
	const navigateTab = useCallback(
		(direction: -1 | 1) => {
			const currentIndex = TABS.findIndex((t) => t.id === activeTab);
			let nextIndex = currentIndex;
			// Find next enabled tab in the given direction, wrapping around
			for (let i = 1; i <= TABS.length; i++) {
				const candidate = (currentIndex + direction * i + TABS.length) % TABS.length;
				if (isTabEnabled(TABS[candidate].id)) {
					nextIndex = candidate;
					break;
				}
			}
			setActiveTab(TABS[nextIndex].id);
		},
		[activeTab, isTabEnabled]
	);

	// Global keyboard handler for Cmd+Shift+[/]
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Cmd+Shift+[ / Cmd+Shift+]
			if (e.metaKey && e.shiftKey && (e.key === '[' || e.key === ']')) {
				e.preventDefault();
				e.stopPropagation();
				navigateTab(e.key === '[' ? -1 : 1);
				return;
			}
		};

		window.addEventListener('keydown', handleKeyDown, true);
		return () => window.removeEventListener('keydown', handleKeyDown, true);
	}, [navigateTab]);

	return createPortal(
		<div
			className="fixed inset-0 modal-overlay flex items-start justify-center pt-16 z-[9999] animate-in fade-in duration-100"
			style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			{/* Modal */}
			<div
				ref={modalRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="director-notes-title"
				tabIndex={-1}
				className="w-[1200px] max-w-[95vw] h-[85vh] rounded-xl shadow-2xl border overflow-hidden flex flex-col outline-none"
				style={{
					backgroundColor: theme.colors.bgActivity,
					borderColor: theme.colors.border,
				}}
			>
				{/* Header */}
				<div
					className="flex items-center justify-between px-4 py-3 border-b"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-2">
						<Clapperboard className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h2
							id="director-notes-title"
							className="text-lg font-semibold"
							style={{ color: theme.colors.textMain }}
						>
							Director's Notes
						</h2>
					</div>

					{/* Close button */}
					<button onClick={onClose} className="p-1 rounded hover:bg-white/10 transition-colors">
						<X className="w-4 h-4" style={{ color: theme.colors.textDim }} />
					</button>
				</div>

				{/* Tab navigation */}
				<div
					className="flex items-center gap-1 px-4 py-2 border-b"
					style={{ borderColor: theme.colors.border }}
				>
					{TABS.map((tab) => {
						const Icon = tab.icon;
						const isActive = activeTab === tab.id;
						const isDisabled = !isTabEnabled(tab.id);
						const showGenerating = tab.id === 'ai-overview' && overviewGenerating;

						return (
							<button
								key={tab.id}
								onClick={() => !isDisabled && setActiveTab(tab.id)}
								disabled={isDisabled}
								className={`px-3 py-1.5 rounded text-sm flex items-center gap-2 transition-colors ${isActive ? 'font-semibold' : ''}`}
								style={{
									backgroundColor: isActive ? theme.colors.accent + '20' : 'transparent',
									color: isActive ? theme.colors.accent : theme.colors.textDim,
									opacity: isDisabled ? 0.5 : 1,
									cursor: isDisabled ? 'default' : 'pointer',
								}}
							>
								{showGenerating ? (
									<Loader2 className="w-4 h-4 animate-spin" />
								) : (
									<Icon className="w-4 h-4" />
								)}
								{tab.label}
								{showGenerating && <span className="text-[10px] font-normal">(generating...)</span>}
							</button>
						);
					})}
				</div>

				{/* Tab content */}
				<div
					className="flex-1 overflow-hidden min-h-0 flex flex-col"
					style={{ backgroundColor: theme.colors.bgMain }}
				>
					<Suspense
						fallback={
							<div className="flex items-center justify-center h-full">
								<Loader2 className="w-8 h-8 animate-spin" style={{ color: theme.colors.textDim }} />
							</div>
						}
					>
						<div className={`h-full ${activeTab === 'overview' ? '' : 'hidden'}`}>
							<OverviewTab ref={overviewTabRef} theme={theme} shortcuts={shortcuts} />
						</div>
						<div className={`h-full ${activeTab === 'history' ? '' : 'hidden'}`}>
							<UnifiedHistoryTab
								ref={historyTabRef}
								theme={theme}
								onResumeSession={onResumeSession}
								fileTree={fileTree}
								onFileClick={onFileClick}
							/>
						</div>
						<div
							ref={aiOverviewContentRef}
							tabIndex={0}
							className={`h-full outline-none ${activeTab === 'ai-overview' ? '' : 'hidden'}`}
						>
							<AIOverviewTab theme={theme} onSynopsisReady={handleSynopsisReady} />
						</div>
					</Suspense>
				</div>
			</div>
		</div>,
		document.body
	);
}
