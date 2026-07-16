import { Terminal } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

interface GitHubCliSectionProps {
	theme: Theme;
	ghPath: string;
	setGhPath: (path: string) => void;
}

export function GitHubCliSection({ theme, ghPath, setGhPath }: GitHubCliSectionProps) {
	return (
		<div data-setting-id="general-gh-path">
			<SettingsSectionHeading icon={Terminal}>GitHub CLI (gh) Path</SettingsSectionHeading>
			<div
				className="p-3 rounded border"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div className="block text-xs opacity-60 mb-1">Custom Path (optional)</div>
				<div className="flex gap-2">
					<input
						type="text"
						value={ghPath}
						onChange={(e) => setGhPath(e.target.value)}
						placeholder="/opt/homebrew/bin/gh"
						className="flex-1 p-1.5 rounded border bg-transparent outline-none text-xs font-mono"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					/>
					{ghPath && (
						<button
							onClick={() => setGhPath('')}
							className="px-2 py-1 rounded text-xs"
							style={{
								backgroundColor: theme.colors.bgActivity,
								color: theme.colors.textDim,
							}}
						>
							Clear
						</button>
					)}
				</div>
				<p className="text-xs opacity-40 mt-2">
					Specify the full path to the{' '}
					<code
						className="px-1 py-0.5 rounded"
						style={{ backgroundColor: theme.colors.bgActivity }}
					>
						gh
					</code>{' '}
					binary if it's not in your PATH. Used for Auto Run worktree features.
				</p>
			</div>
		</div>
	);
}
