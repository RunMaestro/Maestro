import { useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { MarketplacePlaybook } from '../../../../shared/marketplace-types';
import type { Theme } from '../../../types';
import { useClickOutside } from '../../../hooks/ui/useClickOutside';

export interface DocumentSelectorProps {
	theme: Theme;
	playbook: MarketplacePlaybook;
	selectedDocFilename: string | null;
	onSelectDocument: (filename: string) => void;
}

export function DocumentSelector({
	theme,
	playbook,
	selectedDocFilename,
	onSelectDocument,
}: DocumentSelectorProps) {
	const [showDocDropdown, setShowDocDropdown] = useState(false);
	const dropdownRef = useRef<HTMLDivElement>(null);

	useClickOutside(dropdownRef, () => setShowDocDropdown(false), showDocDropdown);

	const handleDocumentSelect = (filename: string | null) => {
		if (filename === null) {
			onSelectDocument('');
		} else {
			onSelectDocument(filename);
		}
		setShowDocDropdown(false);
	};

	return (
		<div
			className="px-4 py-3 border-b shrink-0"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
		>
			<div className="relative" ref={dropdownRef}>
				<button
					onClick={() => setShowDocDropdown(!showDocDropdown)}
					className="w-full flex items-center justify-between px-3 py-2 rounded text-sm"
					style={{
						backgroundColor: theme.colors.bgActivity,
						color: theme.colors.textMain,
						border: `1px solid ${theme.colors.border}`,
					}}
				>
					<span>{selectedDocFilename ? `${selectedDocFilename}.md` : 'README.md'}</span>
					<ChevronDown
						className={`w-4 h-4 transition-transform ${showDocDropdown ? 'rotate-180' : ''}`}
					/>
				</button>

				{showDocDropdown && (
					<div
						className="absolute top-full left-0 right-0 mt-1 rounded shadow-lg z-10 overflow-hidden max-h-64 overflow-y-auto"
						style={{
							backgroundColor: theme.colors.bgSidebar,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						<button
							onClick={() => handleDocumentSelect(null)}
							className="w-full px-3 py-2 text-sm text-left hover:bg-white/5 transition-colors"
							style={{
								color: !selectedDocFilename ? theme.colors.accent : theme.colors.textMain,
								backgroundColor: !selectedDocFilename ? theme.colors.bgActivity : 'transparent',
							}}
						>
							README.md
						</button>

						<div className="border-t" style={{ borderColor: theme.colors.border }} />

						{playbook.documents.map((doc) => (
							<button
								key={doc.filename}
								onClick={() => handleDocumentSelect(doc.filename)}
								className="w-full px-3 py-2 text-sm text-left hover:bg-white/5 transition-colors"
								style={{
									color:
										selectedDocFilename === doc.filename
											? theme.colors.accent
											: theme.colors.textMain,
									backgroundColor:
										selectedDocFilename === doc.filename ? theme.colors.bgActivity : 'transparent',
								}}
							>
								{doc.filename}.md
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
