/**
 * UILayoutContext - Centralized UI layout state management
 *
 * This context extracts sidebar, focus, and file explorer states from App.tsx
 * to reduce its complexity and provide a single source of truth for UI layout.
 *
 * Phase 2 of App.tsx decomposition - see refactor-details-2.md for full plan.
 */

import React, {
	createContext,
	useContext,
	useState,
	useCallback,
	useMemo,
	ReactNode,
	useRef
} from 'react';
import type { FocusArea, RightPanelTab } from '../types';
import type { FlatFileItem } from '../components/FileSearchModal';

/**
 * UI Layout context value - all layout states and their setters
 */
export interface UILayoutContextValue {
	// Sidebar State
	leftSidebarOpen: boolean;
	setLeftSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
	toggleLeftSidebar: () => void;
	rightPanelOpen: boolean;
	setRightPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
	toggleRightPanel: () => void;

	// Focus State
	activeFocus: FocusArea;
	setActiveFocus: React.Dispatch<React.SetStateAction<FocusArea>>;
	activeRightTab: RightPanelTab;
	setActiveRightTab: React.Dispatch<React.SetStateAction<RightPanelTab>>;

	// Sidebar collapse/expand state
	bookmarksCollapsed: boolean;
	setBookmarksCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
	toggleBookmarksCollapsed: () => void;
	groupChatsExpanded: boolean;
	setGroupChatsExpanded: React.Dispatch<React.SetStateAction<boolean>>;
	toggleGroupChatsExpanded: () => void;

	// Session list filter state
	showUnreadOnly: boolean;
	setShowUnreadOnly: React.Dispatch<React.SetStateAction<boolean>>;
	toggleShowUnreadOnly: () => void;
	preFilterActiveTabIdRef: React.MutableRefObject<string | null>;

	// Session sidebar selection
	selectedSidebarIndex: number;
	setSelectedSidebarIndex: React.Dispatch<React.SetStateAction<number>>;

	// File Explorer State
	previewFile: { name: string; content: string; path: string } | null;
	setPreviewFile: React.Dispatch<
		React.SetStateAction<{ name: string; content: string; path: string } | null>
	>;
	selectedFileIndex: number;
	setSelectedFileIndex: React.Dispatch<React.SetStateAction<number>>;
	flatFileList: FlatFileItem[];
	setFlatFileList: React.Dispatch<React.SetStateAction<FlatFileItem[]>>;
	fileTreeFilter: string;
	setFileTreeFilter: React.Dispatch<React.SetStateAction<string>>;
	fileTreeFilterOpen: boolean;
	setFileTreeFilterOpen: React.Dispatch<React.SetStateAction<boolean>>;

	// Flash notification state (inline notifications)
	flashNotification: string | null;
	setFlashNotification: React.Dispatch<React.SetStateAction<string | null>>;
	successFlashNotification: string | null;
	setSuccessFlashNotification: React.Dispatch<React.SetStateAction<string | null>>;

	// Output search state
	outputSearchOpen: boolean;
	setOutputSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
	outputSearchQuery: string;
	setOutputSearchQuery: React.Dispatch<React.SetStateAction<string>>;

	// Drag and drop state
	draggingSessionId: string | null;
	setDraggingSessionId: React.Dispatch<React.SetStateAction<string | null>>;
	isDraggingImage: boolean;
	setIsDraggingImage: React.Dispatch<React.SetStateAction<boolean>>;
	dragCounterRef: React.MutableRefObject<number>;

	// Editing state (inline renaming in sidebar)
	editingGroupId: string | null;
	setEditingGroupId: React.Dispatch<React.SetStateAction<string | null>>;
	editingSessionId: string | null;
	setEditingSessionId: React.Dispatch<React.SetStateAction<string | null>>;
}

// Create context with null as default (will throw if used outside provider)
const UILayoutContext = createContext<UILayoutContextValue | null>(null);

interface UILayoutProviderProps {
	children: ReactNode;
}

/**
 * UILayoutProvider - Provides centralized UI layout state management
 *
 * This provider manages sidebar, focus, and file explorer states that were
 * previously scattered throughout App.tsx. It reduces App.tsx complexity
 * and provides a single location for UI layout state management.
 *
 * Usage:
 * Wrap App with this provider (after ModalProvider):
 * <UILayoutProvider>
 *   <App />
 * </UILayoutProvider>
 */
export function UILayoutProvider({ children }: UILayoutProviderProps) {
	// Sidebar State
	const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
	const [rightPanelOpen, setRightPanelOpen] = useState(true);

	// Focus State
	const [activeFocus, setActiveFocus] = useState<FocusArea>('main');
	const [activeRightTab, setActiveRightTab] = useState<RightPanelTab>('files');

	// Sidebar collapse/expand state
	const [bookmarksCollapsed, setBookmarksCollapsed] = useState(false);
	const [groupChatsExpanded, setGroupChatsExpanded] = useState(true);

	// Session list filter state
	const [showUnreadOnly, setShowUnreadOnly] = useState(false);
	// Track the active tab ID before entering unread filter mode, so we can restore it when exiting
	const preFilterActiveTabIdRef = useRef<string | null>(null);

	// Session sidebar selection
	const [selectedSidebarIndex, setSelectedSidebarIndex] = useState(0);

	// File Explorer State
	const [previewFile, setPreviewFile] = useState<{
		name: string;
		content: string;
		path: string;
	} | null>(null);
	const [selectedFileIndex, setSelectedFileIndex] = useState(0);
	const [flatFileList, setFlatFileList] = useState<FlatFileItem[]>([]);
	const [fileTreeFilter, setFileTreeFilter] = useState('');
	const [fileTreeFilterOpen, setFileTreeFilterOpen] = useState(false);

	// Flash notification state
	const [flashNotification, setFlashNotification] = useState<string | null>(
		null
	);
	const [successFlashNotification, setSuccessFlashNotification] = useState<
		string | null
	>(null);

	// Output search state
	const [outputSearchOpen, setOutputSearchOpen] = useState(false);
	const [outputSearchQuery, setOutputSearchQuery] = useState('');

	// Drag and drop state
	const [draggingSessionId, setDraggingSessionId] = useState<string | null>(
		null
	);
	const [isDraggingImage, setIsDraggingImage] = useState(false);
	const dragCounterRef = useRef(0); // Track nested drag enter/leave events

	// Editing state (inline renaming in sidebar)
	const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
	const [editingSessionId, setEditingSessionId] = useState<string | null>(null);

	// Convenience toggle methods
	const toggleLeftSidebar = useCallback(() => {
		setLeftSidebarOpen(open => !open);
	}, []);

	const toggleRightPanel = useCallback(() => {
		setRightPanelOpen(open => !open);
	}, []);

	const toggleBookmarksCollapsed = useCallback(() => {
		setBookmarksCollapsed(collapsed => !collapsed);
	}, []);

	const toggleGroupChatsExpanded = useCallback(() => {
		setGroupChatsExpanded(expanded => !expanded);
	}, []);

	const toggleShowUnreadOnly = useCallback(() => {
		setShowUnreadOnly(show => !show);
	}, []);

	// Memoize the context value to prevent unnecessary re-renders
	const value = useMemo<UILayoutContextValue>(
		() => ({
			// Sidebar State
			leftSidebarOpen,
			setLeftSidebarOpen,
			toggleLeftSidebar,
			rightPanelOpen,
			setRightPanelOpen,
			toggleRightPanel,

			// Focus State
			activeFocus,
			setActiveFocus,
			activeRightTab,
			setActiveRightTab,

			// Sidebar collapse/expand state
			bookmarksCollapsed,
			setBookmarksCollapsed,
			toggleBookmarksCollapsed,
			groupChatsExpanded,
			setGroupChatsExpanded,
			toggleGroupChatsExpanded,

			// Session list filter state
			showUnreadOnly,
			setShowUnreadOnly,
			toggleShowUnreadOnly,
			preFilterActiveTabIdRef,

			// Session sidebar selection
			selectedSidebarIndex,
			setSelectedSidebarIndex,

			// File Explorer State
			previewFile,
			setPreviewFile,
			selectedFileIndex,
			setSelectedFileIndex,
			flatFileList,
			setFlatFileList,
			fileTreeFilter,
			setFileTreeFilter,
			fileTreeFilterOpen,
			setFileTreeFilterOpen,

			// Flash notification state
			flashNotification,
			setFlashNotification,
			successFlashNotification,
			setSuccessFlashNotification,

			// Output search state
			outputSearchOpen,
			setOutputSearchOpen,
			outputSearchQuery,
			setOutputSearchQuery,

			// Drag and drop state
			draggingSessionId,
			setDraggingSessionId,
			isDraggingImage,
			setIsDraggingImage,
			dragCounterRef,

			// Editing state
			editingGroupId,
			setEditingGroupId,
			editingSessionId,
			setEditingSessionId
		}),
		[
			// Sidebar State
			leftSidebarOpen,
			toggleLeftSidebar,
			rightPanelOpen,
			toggleRightPanel,
			// Focus State
			activeFocus,
			activeRightTab,
			// Sidebar collapse/expand state
			bookmarksCollapsed,
			toggleBookmarksCollapsed,
			groupChatsExpanded,
			toggleGroupChatsExpanded,
			// Session list filter state
			showUnreadOnly,
			toggleShowUnreadOnly,
			// Session sidebar selection
			selectedSidebarIndex,
			// File Explorer State
			previewFile,
			selectedFileIndex,
			flatFileList,
			fileTreeFilter,
			fileTreeFilterOpen,
			// Flash notification state
			flashNotification,
			successFlashNotification,
			// Output search state
			outputSearchOpen,
			outputSearchQuery,
			// Drag and drop state
			draggingSessionId,
			isDraggingImage,
			// Editing state
			editingGroupId,
			editingSessionId
		]
	);

	return (
		<UILayoutContext.Provider value={value}>
			{children}
		</UILayoutContext.Provider>
	);
}

/**
 * useUILayout - Hook to access UI layout state management
 *
 * Must be used within a UILayoutProvider. Throws an error if used outside.
 *
 * @returns UILayoutContextValue - All UI layout states and their setters
 *
 * @example
 * const { leftSidebarOpen, toggleLeftSidebar, activeFocus } = useUILayout();
 *
 * // Toggle left sidebar
 * toggleLeftSidebar();
 *
 * // Check focus area
 * if (activeFocus === 'main') { ... }
 */
export function useUILayout(): UILayoutContextValue {
	const context = useContext(UILayoutContext);

	if (!context) {
		throw new Error('useUILayout must be used within a UILayoutProvider');
	}

	return context;
}
