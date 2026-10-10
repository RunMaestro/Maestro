import { ListTree } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from './SectionCard';
import { ToggleSettingRow } from './ToggleSettingRow';

interface FileTreeLinesSectionProps {
	theme: Theme;
	fileTreeBranchConnectors: boolean;
	setFileTreeBranchConnectors: (value: boolean) => void;
}

/** Files pane tree lines (#1585). */
export function FileTreeLinesSection({
	theme,
	fileTreeBranchConnectors,
	setFileTreeBranchConnectors,
}: FileTreeLinesSectionProps) {
	return (
		<div data-setting-id="display-file-tree-connectors">
			<SettingsSectionHeading icon={ListTree}>Files Pane Tree Lines</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<ToggleSettingRow
					theme={theme}
					title="Show branch connectors"
					description="Hang each row off its folder with an elbow connector, and stop a folder's guide line at its last item. Off by default, which draws plain full-height indent guides."
					checked={fileTreeBranchConnectors}
					onChange={setFileTreeBranchConnectors}
					ariaLabel="Show file tree branch connectors"
				/>
			</SectionCard>
		</div>
	);
}
