import { DocumentSelector as SharedDocumentSelector } from '../../../Wizard/shared/DocumentSelector';
import type { DocumentSelectorProps } from '../types';

export function DocumentSelector({
	documents,
	selectedIndex,
	onSelect,
	theme,
	disabled,
}: DocumentSelectorProps): JSX.Element {
	return (
		<SharedDocumentSelector
			documents={documents}
			selectedIndex={selectedIndex}
			onSelect={onSelect}
			theme={theme}
			disabled={disabled}
			className="flex-1 min-w-0"
			showTaskCounts
		/>
	);
}
