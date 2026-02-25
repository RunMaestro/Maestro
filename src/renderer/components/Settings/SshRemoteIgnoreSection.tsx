/**
 * SshRemoteIgnoreSection - Settings section for SSH remote file indexing ignore patterns
 *
 * Thin wrapper around IgnorePatternsSection with SSH-specific defaults and the
 * "Honor .gitignore" checkbox.
 *
 * Usage:
 * ```tsx
 * <SshRemoteIgnoreSection
 *   theme={theme}
 *   ignorePatterns={sshRemoteIgnorePatterns}
 *   onIgnorePatternsChange={setSshRemoteIgnorePatterns}
 *   honorGitignore={sshRemoteHonorGitignore}
 *   onHonorGitignoreChange={setSshRemoteHonorGitignore}
 * />
 * ```
 */

import { useCallback } from 'react';
import type { Theme } from '../../types';
import { IgnorePatternsSection } from './IgnorePatternsSection';

/** Default SSH remote ignore patterns */
const SSH_DEFAULT_PATTERNS = ['.git', '*cache*'];

export interface SshRemoteIgnoreSectionProps {
	/** Theme object for styling */
	theme: Theme;
	/** Current list of ignore patterns (glob patterns) */
	ignorePatterns: string[];
	/** Callback when ignore patterns change */
	onIgnorePatternsChange: (patterns: string[]) => void;
	/** Whether to honor .gitignore files on remote hosts */
	honorGitignore: boolean;
	/** Callback when honor gitignore setting changes */
	onHonorGitignoreChange: (value: boolean) => void;
}

export function SshRemoteIgnoreSection({
	theme,
	ignorePatterns,
	onIgnorePatternsChange,
	honorGitignore,
	onHonorGitignoreChange,
}: SshRemoteIgnoreSectionProps) {
	const handleReset = useCallback(() => {
		onHonorGitignoreChange(true);
	}, [onHonorGitignoreChange]);

	return (
		<IgnorePatternsSection
			theme={theme}
			title="Remote Ignore Patterns"
			description="Configure glob patterns for folders to exclude when indexing remote files via SSH. These patterns apply to all SSH connections."
			ignorePatterns={ignorePatterns}
			onIgnorePatternsChange={onIgnorePatternsChange}
			defaultPatterns={SSH_DEFAULT_PATTERNS}
			showHonorGitignore
			honorGitignore={honorGitignore}
			onHonorGitignoreChange={onHonorGitignoreChange}
			onReset={handleReset}
		/>
	);
}

export default SshRemoteIgnoreSection;
