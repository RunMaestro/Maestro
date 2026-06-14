import type { RefObject } from 'react';
import type { MarketplaceManifest, MarketplacePlaybook } from '../../../shared/marketplace-types';
import type { Theme } from '../../types';

export interface MarketplaceModalProps {
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
	autoRunFolderPath: string;
	sessionId: string;
	/** SSH remote ID for importing to remote hosts */
	sshRemoteId?: string;
	onImportComplete: (folderName: string) => void;
}

export interface PlaybookTileProps {
	playbook: MarketplacePlaybook;
	theme: Theme;
	isSelected: boolean;
	runningVersion: string;
	onSelect: () => void;
}

export interface MarketplaceHeaderProps {
	theme: Theme;
	fromCache: boolean;
	cacheAge: number | null;
	isRefreshing: boolean;
	showHelp: boolean;
	onToggleHelp: () => void;
	onCloseHelp: () => void;
	onRefresh: () => void;
	onClose: () => void;
}

export interface MarketplaceBrowseTabProps {
	theme: Theme;
	manifest: MarketplaceManifest | null;
	categories: string[];
	selectedCategory: string;
	onCategoryChange: (category: string) => void;
	searchQuery: string;
	onSearchChange: (value: string) => void;
	filteredPlaybooks: MarketplacePlaybook[];
	compatiblePlaybooks: MarketplacePlaybook[];
	incompatiblePlaybooks: MarketplacePlaybook[];
	selectedTileIndex: number;
	isLoading: boolean;
	error: string | null;
	runningVersion: string;
	onRefresh: () => void;
	onSelectPlaybook: (playbook: MarketplacePlaybook) => void;
	searchInputRef: RefObject<HTMLInputElement>;
	gridContainerRef: RefObject<HTMLDivElement>;
}

export interface PlaybookDetailViewProps {
	theme: Theme;
	playbook: MarketplacePlaybook;
	readmeContent: string | null;
	selectedDocFilename: string | null;
	documentContent: string | null;
	isLoadingDocument: boolean;
	targetFolderName: string;
	isImporting: boolean;
	/** Whether this is a remote SSH session (disables local folder browsing) */
	isRemoteSession: boolean;
	runningVersion: string;
	onBack: () => void;
	onSelectDocument: (filename: string) => void;
	onTargetFolderChange: (name: string) => void;
	onBrowseFolder: () => void;
	onImport: () => void;
}
