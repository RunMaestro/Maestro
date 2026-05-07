import { memo, useMemo } from 'react';
import { Gitgraph, templateExtend, TemplateName, type Branch } from '@gitgraph/react';
import type { Theme } from '../types';
import type { GitGraphNode } from '../services/git';

interface GitGraphViewProps {
	nodes: GitGraphNode[];
	theme: Theme;
	onCommitClick?: (hash: string) => void;
	selectedHash?: string;
}

// Pull a branch label out of a commit's refs (e.g. "HEAD -> main, origin/main, tag: v1").
// Prefers local branches over remote-tracking refs; ignores tag: entries.
function pickBranchFromRefs(refs: string[]): string | null {
	const cleaned = refs
		.map((r) => r.replace(/^HEAD -> /, '').trim())
		.filter((r) => r && !r.startsWith('tag:'));
	if (cleaned.length === 0) return null;
	const local = cleaned.find((r) => !r.includes('/'));
	return local || cleaned[0];
}

export const GitGraphView = memo(function GitGraphView({
	nodes,
	theme,
	onCommitClick,
	selectedHash,
}: GitGraphViewProps) {
	const template = useMemo(
		() =>
			templateExtend(TemplateName.Metro, {
				colors: [
					theme.colors.accent,
					'rgb(34, 197, 94)',
					'rgb(59, 130, 246)',
					'rgb(234, 179, 8)',
					'rgb(168, 85, 247)',
					'rgb(244, 63, 94)',
					'rgb(20, 184, 166)',
					'rgb(236, 72, 153)',
				],
				branch: {
					lineWidth: 2,
					spacing: 14,
					label: {
						display: true,
						bgColor: theme.colors.bgSidebar,
						color: theme.colors.textMain,
						strokeColor: theme.colors.border,
						borderRadius: 4,
						font: '10px sans-serif',
					},
				},
				commit: {
					spacing: 26,
					hasTooltipInCompactMode: false,
					dot: {
						size: 5,
						strokeWidth: 0,
					},
					message: {
						display: true,
						displayAuthor: false,
						displayHash: false,
						color: theme.colors.textMain,
						font: '12px sans-serif',
					},
				},
				tag: {
					bgColor: 'rgba(234, 179, 8, 0.2)',
					color: 'rgb(234, 179, 8)',
					strokeColor: 'rgb(234, 179, 8)',
					borderRadius: 3,
					font: '9px sans-serif',
				},
			}),
		[theme]
	);

	// Sort oldest → newest so we can build branches forward.
	const ordered = useMemo(
		() => [...nodes].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()),
		[nodes]
	);

	return (
		<div className="overflow-auto h-full p-2">
			<Gitgraph options={{ template }}>
				{(gitgraph) => {
					const branches = new Map<string, Branch>();
					const commitToBranch = new Map<string, Branch>();
					let laneCounter = 0;

					const ensureBranch = (name: string, parentHash?: string): Branch => {
						const existing = branches.get(name);
						if (existing) return existing;
						let created: Branch;
						if (parentHash && commitToBranch.has(parentHash)) {
							const parentBranch = commitToBranch.get(parentHash)!;
							created = parentBranch.branch(name);
						} else {
							created = gitgraph.branch(name);
						}
						branches.set(name, created);
						return created;
					};

					for (const node of ordered) {
						const refBranch = pickBranchFromRefs(node.refs);
						const firstParent = node.parents[0];
						const inheritedBranchName = firstParent
							? ([...branches.entries()].find(
									([, br]) => commitToBranch.get(firstParent) === br
								)?.[0] ?? null)
							: null;

						const branchName = refBranch ?? inheritedBranchName ?? `lane-${++laneCounter}`;

						const branch = ensureBranch(branchName, firstParent);

						const subject = node.subject || '(no message)';
						const truncated = subject.length > 60 ? subject.slice(0, 57) + '…' : subject;
						const commitOptions = {
							hash: node.shortHash,
							subject: truncated,
							author: node.author,
							onClick: onCommitClick ? () => onCommitClick(node.hash) : undefined,
							style:
								selectedHash && selectedHash === node.hash
									? { dot: { size: 10, strokeWidth: 2, strokeColor: theme.colors.accent } }
									: undefined,
						};

						if (node.parents.length >= 2) {
							const secondParent = node.parents[1];
							const sourceBranch = commitToBranch.get(secondParent);
							if (sourceBranch) {
								branch.merge({ branch: sourceBranch, commitOptions });
							} else {
								branch.commit(commitOptions);
							}
						} else {
							branch.commit(commitOptions);
						}

						commitToBranch.set(node.hash, branch);

						// Attach tag refs (skip duplicate branch labels — gitgraph adds those automatically).
						for (const ref of node.refs) {
							const cleaned = ref.replace(/^HEAD -> /, '').trim();
							if (cleaned.startsWith('tag:')) {
								branch.tag(cleaned.replace(/^tag:\s*/, ''));
							}
						}
					}
				}}
			</Gitgraph>
		</div>
	);
});
