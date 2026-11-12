import type React from 'react';
import type { BatchDocumentEntry, Theme } from '../../types';

export interface DocTreeNode {
	name: string;
	type: 'file' | 'folder';
	path: string;
	children?: DocTreeNode[];
}

export interface DocumentsPanelProps {
	theme: Theme;
	documents: BatchDocumentEntry[];
	setDocuments: React.Dispatch<React.SetStateAction<BatchDocumentEntry[]>>;
	taskCounts: Record<string, number>;
	loadingTaskCounts: boolean;
	loopEnabled: boolean;
	setLoopEnabled: (enabled: boolean) => void;
	maxLoops: number | null;
	setMaxLoops: (maxLoops: number | null) => void;
	allDocuments: string[];
	documentTree?: DocTreeNode[];
	onRefreshDocuments: () => Promise<void>;
}

export interface DocumentSelectorModalProps {
	theme: Theme;
	allDocuments: string[];
	documentTree?: DocTreeNode[];
	taskCounts: Record<string, number>;
	loadingTaskCounts: boolean;
	documents: BatchDocumentEntry[];
	onClose: () => void;
	onAdd: (selectedDocs: Set<string>) => void;
	onRefresh: () => Promise<void>;
}

export interface DragHandlers {
	handleDragStart: (e: React.DragEvent, id: string) => void;
	handleDrag: (e: React.DragEvent) => void;
	handleDragOver: (e: React.DragEvent, id: string, index: number) => void;
	handleDragLeave: (e: React.DragEvent) => void;
	handleDrop: (e: React.DragEvent) => void;
	handleDragEnd: () => void;
}
