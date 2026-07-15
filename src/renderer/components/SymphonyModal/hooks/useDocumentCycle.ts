import { useEffect } from 'react';
import type { SymphonyIssue } from '../../../../shared/symphony-types';

export interface UseDocumentCycleParams {
	selectedIssue: SymphonyIssue | null;
	selectedDocIndex: number;
	onPreviewDocument: (path: string, isExternal: boolean) => void;
	onIndexChange: (index: number) => void;
}

/**
 * Wires Cmd+Shift+[ and Cmd+Shift+] to cycle through `selectedIssue.documentPaths`,
 * wrapping at both ends. No-ops when there is no issue or no documents.
 *
 * NOTE: this attaches to `window`; behavior is identical to the original inline
 * effect inside RepositoryDetailView. It deliberately does NOT call
 * stopPropagation - the shell's tab-cycle handler also responds to the same
 * shortcut. See CUE-REFACTORING.md §4.1 "Risks" for the documented follow-up.
 */
export function useDocumentCycle({
	selectedIssue,
	selectedDocIndex,
	onPreviewDocument,
	onIndexChange,
}: UseDocumentCycleParams): void {
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (!selectedIssue || selectedIssue.documentPaths.length === 0) return;

			if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '[' || e.key === ']')) {
				e.preventDefault();

				const docCount = selectedIssue.documentPaths.length;
				const currentIndex = Math.max(0, Math.min(docCount - 1, selectedDocIndex));
				let newIndex: number;

				if (e.key === '[') {
					newIndex = currentIndex <= 0 ? docCount - 1 : currentIndex - 1;
				} else {
					newIndex = currentIndex >= docCount - 1 ? 0 : currentIndex + 1;
				}

				const doc = selectedIssue.documentPaths[newIndex];
				if (!doc) return;
				onIndexChange(newIndex);
				onPreviewDocument(doc.path, doc.isExternal);
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [selectedIssue, selectedDocIndex, onPreviewDocument, onIndexChange]);
}
