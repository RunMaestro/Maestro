/**
 * TextDiff - a unified diff between two texts that never touched git.
 *
 * It builds a synthetic git-style patch (`buildSyntheticGitDiff`) and draws it
 * with the same `react-diff-view` renderer and theme styles the Git Diff
 * viewer uses, so a comparison of two strings reads like every other diff in
 * the app. Reach for it when both sides are already in memory.
 */

import { useMemo } from 'react';
import { Diff, Hunk } from 'react-diff-view';
import 'react-diff-view/style/index.css';

import { useSettingsStore } from '../../stores/settingsStore';
import type { Theme } from '../../types';
import { buildSyntheticGitDiff, parseGitDiff } from '../../utils/gitDiffParser';
import { generateDiffViewStyles } from '../../utils/markdownConfig';

export interface TextDiffProps {
	theme: Theme;
	/** The `-` side. */
	before: string;
	/** The `+` side. */
	after: string;
	/** The name the patch header carries. Never shown as a path to open. */
	name?: string;
	/** Shown when the two texts are the same. */
	emptyMessage?: string;
	testId?: string;
}

export function TextDiff({
	theme,
	before,
	after,
	name = 'text',
	emptyMessage = 'No differences.',
	testId = 'text-diff',
}: TextDiffProps) {
	const colorBlindMode = useSettingsStore((s) => s.colorBlindMode);
	const files = useMemo(
		() => (before === after ? [] : parseGitDiff(buildSyntheticGitDiff(name, before, after))),
		[name, before, after]
	);

	if (files.length === 0) {
		return (
			<p className="text-xs opacity-70" data-testid={`${testId}-empty`}>
				{emptyMessage}
			</p>
		);
	}

	return (
		<div className="font-mono text-xs select-text" data-testid={testId}>
			<style>{generateDiffViewStyles(theme, colorBlindMode)}</style>
			{files.map((file) =>
				file.parsedDiff.map((parsedFile, index) => (
					<Diff
						key={`${file.newPath}-${index}`}
						viewType="unified"
						diffType={parsedFile.type}
						hunks={parsedFile.hunks}
					>
						{(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
					</Diff>
				))
			)}
		</div>
	);
}

export default TextDiff;
