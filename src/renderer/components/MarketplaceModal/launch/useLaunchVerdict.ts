/**
 * useLaunchVerdict - the verdict the outro shows: the first heading section of the report file a
 * launched run writes (`launch.outro.reportFile`).
 *
 * The file is read through the ordinary file-read IPC, on this machine or on the agent's SSH
 * remote, and the section is cut out with `firstHeadingSection()`. A run that stopped early may
 * never have written its report, so a missing file, or a file with no heading that has text under
 * it, is not an error: there is no verdict to show. A read that fails for another reason (a
 * permission error, an SSH remote that cannot be reached) is reported to Sentry and treated the
 * same way, because the verdict is a convenience and the Open buttons still reach the file.
 */

import { useEffect, useState } from 'react';
import { firstHeadingSection, type MarkdownHeadingSection } from '../../../../shared/markdown';
import { captureException } from '../../../utils/sentry';
import { splitFrontmatter } from '../../FilePreview/markdownFast/frontmatter';

/** What the outro can say about the report. */
export type LaunchVerdict =
	| { status: 'loading' }
	/** No report file is named, it is not on disk, or no heading in it has text under it. */
	| { status: 'none' }
	| { status: 'ready'; section: MarkdownHeadingSection };

const NO_VERDICT: LaunchVerdict = { status: 'none' };

/** The verdict in a report's text. `null` is a file that does not exist. */
function verdictOf(content: string | null): LaunchVerdict {
	if (content === null) return NO_VERDICT;
	const section = firstHeadingSection(splitFrontmatter(content).body);
	return section ? { status: 'ready', section } : NO_VERDICT;
}

/**
 * Read the verdict of a launch's report.
 *
 * @param reportPath absolute path of the report file, with its `{{TOKEN}}`s filled; `undefined`
 *   when the playbook names none
 * @param sshRemoteId the SSH remote the agent ran on, when it ran on one
 */
export function useLaunchVerdict(
	reportPath: string | undefined,
	sshRemoteId: string | undefined
): LaunchVerdict {
	const [verdict, setVerdict] = useState<LaunchVerdict>(
		reportPath ? { status: 'loading' } : NO_VERDICT
	);

	useEffect(() => {
		if (!reportPath) {
			setVerdict(NO_VERDICT);
			return;
		}
		let cancelled = false;
		setVerdict({ status: 'loading' });
		window.maestro.fs.readFile(reportPath, sshRemoteId).then(
			(content) => {
				if (!cancelled) setVerdict(verdictOf(content));
			},
			(error: unknown) => {
				captureException(error, {
					extra: { operation: 'playbookOutro:readReport', reportPath, sshRemoteId },
				});
				if (!cancelled) setVerdict(NO_VERDICT);
			}
		);
		return () => {
			cancelled = true;
		};
	}, [reportPath, sshRemoteId]);

	return verdict;
}
