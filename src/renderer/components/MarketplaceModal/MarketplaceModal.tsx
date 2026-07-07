/**
 * MarketplaceModal
 *
 * Modal component for browsing and importing playbooks from the Playbook Exchange.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MarketplacePlaybook } from '../../../shared/marketplace-types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useMarketplace } from '../../hooks/batch/useMarketplace';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { useResizableModal } from '../../hooks/ui/useResizableModal';
import { MarketplaceBrowseTab, MarketplaceHeader, PlaybookDetailView } from './components';
import { partitionPlaybooksByCompatibility } from './helpers';
import {
	useMarketplaceCategoryDocumentCycle,
	useMarketplaceListKeyboardNav,
	usePlaybookDetailState,
	usePlaybookImportActions,
} from './hooks';
import type { MarketplaceModalProps } from './types';
import { ResizeHandles } from '../ui/ResizeHandles';

export function MarketplaceModal({
	theme,
	isOpen,
	onClose,
	autoRunFolderPath,
	sessionId,
	sshRemoteId,
	onImportComplete,
}: MarketplaceModalProps) {
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	const isRemoteSession = !!sshRemoteId;
	const runningVersion = useMemo(
		() => (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown'),
		[]
	);

	const {
		manifest,
		categories,
		isLoading,
		isRefreshing,
		isImporting,
		fromCache,
		cacheAge,
		error,
		selectedCategory,
		setSelectedCategory,
		searchQuery,
		setSearchQuery,
		filteredPlaybooks,
		refresh,
		importPlaybook,
		fetchReadme,
		fetchDocument,
	} = useMarketplace();

	const { compatiblePlaybooks, incompatiblePlaybooks, orderedPlaybooks } = useMemo(
		() => partitionPlaybooksByCompatibility(filteredPlaybooks, runningVersion),
		[filteredPlaybooks, runningVersion]
	);

	const [selectedTileIndex, setSelectedTileIndex] = useState(0);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const gridContainerRef = useRef<HTMLDivElement>(null);
	const [showHelp, setShowHelp] = useState(false);
	const helpButtonRef = useRef<HTMLButtonElement>(null);

	const detailState = usePlaybookDetailState({ fetchReadme, fetchDocument });
	const {
		selectedPlaybook,
		showDetailView,
		readmeContent,
		selectedDocFilename,
		documentContent,
		isLoadingDocument,
		targetFolderName,
		setTargetFolderName,
		handleBackToList,
		handleSelectPlaybook,
		handleSelectDocument,
	} = detailState;

	const { handleImport, handleBrowseFolder } = usePlaybookImportActions({
		selectedPlaybook,
		targetFolderName,
		autoRunFolderPath,
		sessionId,
		sshRemoteId,
		isRemoteSession,
		importPlaybook,
		onImportComplete,
		onClose,
		setTargetFolderName,
	});

	const handleCategoryChange = useCallback(
		(category: string) => {
			setSelectedCategory(category);
			setSelectedTileIndex(0);
		},
		[setSelectedCategory]
	);

	const handleSearchChange = useCallback(
		(value: string) => {
			setSearchQuery(value);
			setSelectedTileIndex(0);
		},
		[setSearchQuery]
	);

	const showDetailViewRef = useRef(showDetailView);
	showDetailViewRef.current = showDetailView;
	const showHelpRef = useRef(showHelp);
	showHelpRef.current = showHelp;
	const handleBackToListRef = useRef(handleBackToList);
	handleBackToListRef.current = handleBackToList;

	useModalLayer(
		MODAL_PRIORITIES.MARKETPLACE,
		'Playbook Exchange',
		() => {
			if (showHelpRef.current) {
				setShowHelp(false);
			} else if (showDetailViewRef.current) {
				handleBackToListRef.current();
			} else {
				onCloseRef.current();
			}
		},
		{ enabled: isOpen }
	);

	useEffect(() => {
		if (isOpen) {
			const timer = setTimeout(() => searchInputRef.current?.focus(), 50);
			return () => clearTimeout(timer);
		}
	}, [isOpen]);

	const handleSelectPlaybookFromList = useCallback(
		(playbook: MarketplacePlaybook) => {
			void handleSelectPlaybook(playbook);
		},
		[handleSelectPlaybook]
	);

	useMarketplaceListKeyboardNav({
		isOpen,
		showDetailView,
		orderedPlaybooks,
		selectedTileIndex,
		setSelectedTileIndex,
		onSelectPlaybook: handleSelectPlaybookFromList,
		searchInputRef,
	});

	useMarketplaceCategoryDocumentCycle({
		isOpen,
		categories,
		selectedCategory,
		showDetailView,
		selectedPlaybook,
		selectedDocFilename,
		onCategoryChange: handleCategoryChange,
		onSelectDocument: handleSelectDocument,
	});
	const resizableModal = useResizableModal({
		resizeKey: 'marketplace',
		defaultSize: { width: 1200, height: 760 },
		minSize: { width: 760, height: 500 },
		enabled: isOpen,
	});

	if (!isOpen) return null;

	const modalContent = (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center p-8 z-[9999] animate-in fade-in duration-100"
			style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
		>
			<div
				ref={resizableModal.modalRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="marketplace-title"
				tabIndex={-1}
				className="relative rounded-xl shadow-2xl border overflow-hidden flex flex-col outline-none select-none"
				style={{
					...resizableModal.style,
					backgroundColor: theme.colors.bgActivity,
					borderColor: theme.colors.border,
				}}
				data-modal-resize-key="marketplace"
			>
				<ResizeHandles
					onResizeStart={resizableModal.onResizeStart}
					accentColor={theme.colors.accent}
				/>

				{showDetailView && selectedPlaybook ? (
					<PlaybookDetailView
						theme={theme}
						playbook={selectedPlaybook}
						readmeContent={readmeContent}
						selectedDocFilename={selectedDocFilename}
						documentContent={documentContent}
						isLoadingDocument={isLoadingDocument}
						targetFolderName={targetFolderName}
						isImporting={isImporting}
						isRemoteSession={isRemoteSession}
						runningVersion={runningVersion}
						onBack={handleBackToList}
						onSelectDocument={handleSelectDocument}
						onTargetFolderChange={setTargetFolderName}
						onBrowseFolder={handleBrowseFolder}
						onImport={handleImport}
					/>
				) : (
					<>
						<MarketplaceHeader
							ref={helpButtonRef}
							theme={theme}
							fromCache={fromCache}
							cacheAge={cacheAge}
							isRefreshing={isRefreshing}
							showHelp={showHelp}
							onToggleHelp={() => setShowHelp(!showHelp)}
							onCloseHelp={() => setShowHelp(false)}
							onRefresh={() => refresh()}
							onClose={onClose}
						/>
						<MarketplaceBrowseTab
							theme={theme}
							manifest={manifest}
							categories={categories}
							selectedCategory={selectedCategory}
							onCategoryChange={handleCategoryChange}
							searchQuery={searchQuery}
							onSearchChange={handleSearchChange}
							filteredPlaybooks={filteredPlaybooks}
							compatiblePlaybooks={compatiblePlaybooks}
							incompatiblePlaybooks={incompatiblePlaybooks}
							selectedTileIndex={selectedTileIndex}
							isLoading={isLoading}
							error={error}
							runningVersion={runningVersion}
							onRefresh={() => refresh()}
							onSelectPlaybook={handleSelectPlaybookFromList}
							searchInputRef={searchInputRef}
							gridContainerRef={gridContainerRef}
						/>
					</>
				)}
			</div>
		</div>
	);

	return createPortal(modalContent, document.body);
}
