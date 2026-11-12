import { FolderSearch } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { DEFAULT_LOCAL_IGNORE_PATTERNS } from '../../../../../stores/settingsStore';
import { FilePanelSettingsSection } from '../../../FilePanelSettingsSection';
import { IgnorePatternsSection } from '../../../IgnorePatternsSection';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

interface FileIndexingSectionProps {
	theme: Theme;
	localIgnorePatterns: string[];
	setLocalIgnorePatterns: (patterns: string[]) => void;
	localHonorGitignore: boolean;
	setLocalHonorGitignore: (enabled: boolean) => void;
	fileExplorerMaxDepth: number;
	setFileExplorerMaxDepth: (value: number) => void;
	fileExplorerMaxEntries: number;
	setFileExplorerMaxEntries: (value: number) => void;
	sshReduceEntryCapEnabled: boolean;
	setSshReduceEntryCapEnabled: (enabled: boolean) => void;
	sshReduceEntryCapFraction: number;
	setSshReduceEntryCapFraction: (value: number) => void;
}

export function FileIndexingSection({
	theme,
	localIgnorePatterns,
	setLocalIgnorePatterns,
	localHonorGitignore,
	setLocalHonorGitignore,
	fileExplorerMaxDepth,
	setFileExplorerMaxDepth,
	fileExplorerMaxEntries,
	setFileExplorerMaxEntries,
	sshReduceEntryCapEnabled,
	setSshReduceEntryCapEnabled,
	sshReduceEntryCapFraction,
	setSshReduceEntryCapFraction,
}: FileIndexingSectionProps) {
	return (
		<div data-setting-id="display-file-indexing">
			<SettingsSectionHeading icon={FolderSearch}>File Indexing</SettingsSectionHeading>
			<div className="space-y-3">
				<IgnorePatternsSection
					theme={theme}
					title="Local Ignore Patterns"
					description="Configure glob patterns for folders to exclude when indexing local files in the file explorer. Excluding large directories (like .git) reduces memory usage and speeds up file tree loading."
					ignorePatterns={localIgnorePatterns}
					onIgnorePatternsChange={setLocalIgnorePatterns}
					defaultPatterns={DEFAULT_LOCAL_IGNORE_PATTERNS}
					showHonorGitignore
					honorGitignore={localHonorGitignore}
					onHonorGitignoreChange={setLocalHonorGitignore}
					onReset={() => setLocalHonorGitignore(true)}
					hideEyebrow
				/>
				<FilePanelSettingsSection
					theme={theme}
					maxDepth={fileExplorerMaxDepth}
					onMaxDepthChange={setFileExplorerMaxDepth}
					maxEntries={fileExplorerMaxEntries}
					onMaxEntriesChange={setFileExplorerMaxEntries}
					sshReduceEntryCapEnabled={sshReduceEntryCapEnabled}
					onSshReduceEntryCapEnabledChange={setSshReduceEntryCapEnabled}
					sshReduceEntryCapFraction={sshReduceEntryCapFraction}
					onSshReduceEntryCapFractionChange={setSshReduceEntryCapFraction}
				/>
			</div>
		</div>
	);
}
