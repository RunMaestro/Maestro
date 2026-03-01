import { memo, useEffect, useRef, useState } from 'react';
import { ChevronUp, ChevronDown, X } from 'lucide-react';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import type { Theme } from '../../shared/theme-types';

interface TerminalSearchBarProps {
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
	onSearch: (query: string) => boolean;
	onSearchNext: () => boolean;
	onSearchPrevious: () => boolean;
}

export const TerminalSearchBar = memo(function TerminalSearchBar({
	theme,
	isOpen,
	onClose,
	onSearch,
	onSearchNext,
	onSearchPrevious,
}: TerminalSearchBarProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState('');
	const [hasResults, setHasResults] = useState(true);
	const { registerLayer, unregisterLayer } = useLayerStack();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// Auto-focus input when opened
	useEffect(() => {
		if (isOpen) {
			const timer = setTimeout(() => {
				inputRef.current?.focus();
			}, 0);
			return () => clearTimeout(timer);
		} else {
			// Reset query when closed
			setQuery('');
			setHasResults(true);
		}
	}, [isOpen]);

	// Register with layer stack for Escape handling
	useEffect(() => {
		if (isOpen) {
			const id = registerLayer({
				type: 'overlay',
				priority: MODAL_PRIORITIES.SLASH_AUTOCOMPLETE,
				blocksLowerLayers: false,
				capturesFocus: false,
				focusTrap: 'none',
				allowClickOutside: true,
				onEscape: () => onCloseRef.current(),
			});
			return () => unregisterLayer(id);
		}
	}, [isOpen, registerLayer, unregisterLayer]);

	// Search as user types
	const handleQueryChange = (value: string) => {
		setQuery(value);
		if (value) {
			const found = onSearch(value);
			setHasResults(found);
		} else {
			setHasResults(true);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			if (e.shiftKey) {
				const found = onSearchPrevious();
				setHasResults(found);
			} else {
				const found = onSearchNext();
				setHasResults(found);
			}
		}
		// Escape is handled by LayerStack
	};

	const handleNext = () => {
		const found = onSearchNext();
		setHasResults(found);
	};

	const handlePrevious = () => {
		const found = onSearchPrevious();
		setHasResults(found);
	};

	if (!isOpen) return null;

	const noResults = query.length > 0 && !hasResults;

	return (
		<div
			className="absolute top-2 right-2 z-50 flex items-center gap-1 rounded border px-2 py-1 shadow-lg"
			style={{
				backgroundColor: theme.colors.bgActivity,
				borderColor: theme.colors.border,
				color: theme.colors.textMain,
			}}
		>
			<input
				ref={inputRef}
				type="text"
				value={query}
				onChange={(e) => handleQueryChange(e.target.value)}
				onKeyDown={handleKeyDown}
				placeholder="Search..."
				className="bg-transparent outline-none text-sm"
				style={{
					width: '200px',
					color: noResults ? theme.colors.error : theme.colors.textMain,
				}}
			/>
			{noResults && (
				<span className="text-xs whitespace-nowrap" style={{ color: theme.colors.error }}>
					No results
				</span>
			)}
			<button
				onClick={handlePrevious}
				disabled={!query}
				title="Previous match (Shift+Enter)"
				className="p-0.5 rounded opacity-70 hover:opacity-100 disabled:opacity-30"
				style={{ color: theme.colors.textMain }}
			>
				<ChevronUp size={14} />
			</button>
			<button
				onClick={handleNext}
				disabled={!query}
				title="Next match (Enter)"
				className="p-0.5 rounded opacity-70 hover:opacity-100 disabled:opacity-30"
				style={{ color: theme.colors.textMain }}
			>
				<ChevronDown size={14} />
			</button>
			<button
				onClick={onClose}
				title="Close (Escape)"
				className="p-0.5 rounded opacity-70 hover:opacity-100"
				style={{ color: theme.colors.textMain }}
			>
				<X size={14} />
			</button>
		</div>
	);
});
