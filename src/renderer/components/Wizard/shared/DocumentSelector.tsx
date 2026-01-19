/**
 * DocumentSelector.tsx
 *
 * Dropdown component for switching between generated documents.
 * Used by PhaseReviewScreen and DocumentGenerationView for document navigation.
 *
 * Features:
 * - Dropdown button showing current selection
 * - Click outside to close
 * - Escape key to close
 * - Keyboard navigation support
 * - Dynamic width based on longest filename
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Theme } from '../../../types';
import type { GeneratedDocument } from '../WizardContext';

export interface DocumentSelectorProps {
	/** List of generated documents */
	documents: GeneratedDocument[];
	/** Index of the currently selected document */
	selectedIndex: number;
	/** Called when selection changes */
	onSelect: (index: number) => void;
	/** Theme for styling */
	theme: Theme;
	/** Optional class name for the container */
	className?: string;
	/** Whether the selector is disabled */
	disabled?: boolean;
	/** Whether the dropdown is currently open (controlled mode) */
	isOpen?: boolean;
	/** Called when dropdown open state changes (controlled mode) */
	onOpenChange?: (isOpen: boolean) => void;
}

/**
 * DocumentSelector - Dropdown for switching between documents
 *
 * A reusable dropdown component for selecting from a list of generated documents.
 * Handles keyboard navigation and click-outside-to-close behavior.
 */
export function DocumentSelector({
	documents,
	selectedIndex,
	onSelect,
	theme,
	className = '',
	disabled = false,
	isOpen: controlledIsOpen,
	onOpenChange,
}: DocumentSelectorProps): JSX.Element {
	const [internalIsOpen, setInternalIsOpen] = useState(false);
	const dropdownRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);

	// Support both controlled and uncontrolled modes
	const isOpen = controlledIsOpen !== undefined ? controlledIsOpen : internalIsOpen;
	const setIsOpen = (open: boolean) => {
		if (onOpenChange) {
			onOpenChange(open);
		} else {
			setInternalIsOpen(open);
		}
	};

	const selectedDoc = documents[selectedIndex];

	// Handle click outside to close
	useEffect(() => {
		function handleClickOutside(event: MouseEvent) {
			if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
				setIsOpen(false);
			}
		}
		if (isOpen) {
			document.addEventListener('mousedown', handleClickOutside);
			return () => document.removeEventListener('mousedown', handleClickOutside);
		}
	}, [isOpen]);

	// Handle Escape key to close
	useEffect(() => {
		function handleKeyDown(event: KeyboardEvent) {
			if (event.key === 'Escape' && isOpen) {
				event.preventDefault();
				event.stopPropagation();
				setIsOpen(false);
				buttonRef.current?.focus();
			}
		}
		if (isOpen) {
			document.addEventListener('keydown', handleKeyDown, true);
			return () => document.removeEventListener('keydown', handleKeyDown, true);
		}
	}, [isOpen]);

	// Calculate dropdown width based on longest filename
	const longestFilename = useMemo(() => {
		if (documents.length === 0) return '';
		return documents.reduce(
			(longest, doc) => (doc.filename.length > longest.length ? doc.filename : longest),
			''
		);
	}, [documents]);

	// Min 280px, max 500px, scale with filename length
	const dropdownWidth = useMemo(() => {
		const charWidth = 7.5; // approximate px per character in the font
		const padding = 60; // padding + chevron icon space
		const calculatedWidth = longestFilename.length * charWidth + padding;
		return Math.min(500, Math.max(280, calculatedWidth));
	}, [longestFilename]);

	return (
		<div ref={dropdownRef} className={`relative ${className}`} style={{ width: dropdownWidth }}>
			<button
				ref={buttonRef}
				onClick={() => !disabled && setIsOpen(!isOpen)}
				disabled={disabled}
				className={`w-full min-w-0 flex items-center justify-between px-3 py-2 rounded text-sm transition-colors ${
					disabled ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-90'
				}`}
				style={{
					backgroundColor: theme.colors.bgActivity,
					color: theme.colors.textMain,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				<span className="truncate min-w-0 flex-1">
					{selectedDoc?.filename || 'Select document...'}
				</span>
				<ChevronDown
					className={`w-4 h-4 ml-2 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
					style={{ color: theme.colors.textDim }}
				/>
			</button>

			{isOpen && (
				<div
					className="absolute top-full left-0 right-0 mt-1 rounded shadow-lg overflow-hidden z-50"
					style={{
						backgroundColor: theme.colors.bgSidebar,
						border: `1px solid ${theme.colors.border}`,
						maxHeight: '300px',
						overflowY: 'auto',
					}}
				>
					{documents.length === 0 ? (
						<div className="px-3 py-2 text-sm" style={{ color: theme.colors.textDim }}>
							No documents generated
						</div>
					) : (
						documents.map((doc, index) => (
							<button
								key={doc.filename}
								onClick={() => {
									onSelect(index);
									setIsOpen(false);
								}}
								className="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-white/5"
								style={{
									color: index === selectedIndex ? theme.colors.accent : theme.colors.textMain,
									backgroundColor:
										index === selectedIndex ? theme.colors.bgActivity : 'transparent',
								}}
							>
								{doc.filename}
							</button>
						))
					)}
				</div>
			)}
		</div>
	);
}

export default DocumentSelector;
