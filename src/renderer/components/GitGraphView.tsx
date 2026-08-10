import { memo, useMemo, type ReactElement } from 'react';
import { Gitgraph, templateExtend, TemplateName } from '@gitgraph/react';
import { GitgraphCore } from '@gitgraph/core';
import type { Theme } from '../types';
import type { GitGraphNode } from '../services/git';

// `@gitgraph/react`'s public Gitgraph component is parameterised on
// `ReactElement<SVGElement>` (its internal `ReactSvgElement`). The library
// doesn't re-export that type from its index, so reproduce it here so a
// userland-built `GitgraphCore` instance type-checks against the `graph` prop.
type ReactSvgElement = ReactElement<SVGElement>;

// Maestro's monospace stack (mirrors `--font-mono` in index.css / tailwind.config).
// SVG font strings need a size prefix, so callers build `<px>px ${MONO_FONT}`.
const MONO_FONT = "'JetBrains Mono', 'Fira Code', 'Courier New', monospace";

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

// Branch/lane color palette. Every branch line, dot, message and label pill
// picks its color from here (via the branch's column), so a single source keeps
// text and its branch line in sync.
export const GIT_GRAPH_BRANCH_COLORS = (theme: Theme): string[] => [
	theme.colors.accent,
	'rgb(34, 197, 94)',
	'rgb(59, 130, 246)',
	'rgb(234, 179, 8)',
	'rgb(168, 85, 247)',
	'rgb(244, 63, 94)',
	'rgb(20, 184, 166)',
	'rgb(236, 72, 153)',
];

// Build the @gitgraph template from the active Maestro theme. Kept as a pure,
// exported helper so its typography/color choices are unit-testable without
// mounting an SVG (jsdom lacks getBBox, which @gitgraph's label layout needs).
export function buildGitGraphTemplate(theme: Theme) {
	return templateExtend(TemplateName.Metro, {
		colors: GIT_GRAPH_BRANCH_COLORS(theme),
		branch: {
			lineWidth: 2,
			spacing: 14,
			label: {
				display: true,
				bgColor: theme.colors.bgSidebar,
				// Leave `color`/`strokeColor` unset so @gitgraph falls back to the
				// commit's branch color (see BranchLabel in @gitgraph/react), keeping
				// each branch pill in sync with its line/dot color.
				borderRadius: 4,
				font: `10px ${MONO_FONT}`,
			},
		},
		commit: {
			// Slightly tighter than the Metro default for a denser, neater log.
			spacing: 24,
			hasTooltipInCompactMode: false,
			dot: {
				size: 5,
				strokeWidth: 0,
			},
			message: {
				display: true,
				displayAuthor: false,
				displayHash: false,
				// Leave `color` unset so each commit message inherits its branch
				// color (@gitgraph's withDefaultColor fills it from the same source
				// as the branch line), instead of a flat textMain.
				font: `12px ${MONO_FONT}`,
			},
		},
		tag: {
			bgColor: 'rgba(234, 179, 8, 0.2)',
			color: 'rgb(234, 179, 8)',
			strokeColor: 'rgb(234, 179, 8)',
			borderRadius: 3,
			font: `9px ${MONO_FONT}`,
		},
	});
}

export const GitGraphView = memo(function GitGraphView({
	nodes,
	theme,
	onCommitClick,
	selectedHash,
}: GitGraphViewProps) {
	const template = useMemo(() => buildGitGraphTemplate(theme), [theme]);

	// Sort oldest → newest so we can build branches forward.
	const ordered = useMemo(
		() => [...nodes].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()),
		[nodes]
	);

	// Build the GitgraphCore imperatively here (not via the children-callback API).
	// The callback API populates the graph during componentDidMount, which under
	// React.StrictMode runs twice and ends up with duplicate React keys / mis-rendered
	// SVG. Owning the graph instance ourselves keeps the data stable across the
	// dev-only mount→unmount→remount cycle, so what the user sees in dev matches
	// production.
	const gitgraph = useMemo(() => {
		const core = new GitgraphCore<ReactSvgElement>({ template });
		const api = core.getUserApi();

		const branches = new Map<string, ReturnType<typeof api.branch>>();
		const commitToBranch = new Map<string, ReturnType<typeof api.branch>>();
		let laneCounter = 0;

		const ensureBranch = (name: string, parentHash?: string) => {
			const existing = branches.get(name);
			if (existing) return existing;
			const parentBranch = parentHash ? commitToBranch.get(parentHash) : undefined;
			const created = parentBranch ? parentBranch.branch(name) : api.branch(name);
			branches.set(name, created);
			return created;
		};

		for (const node of ordered) {
			const refBranch = pickBranchFromRefs(node.refs);
			const firstParent = node.parents[0];
			const inheritedBranchName = firstParent
				? ([...branches.entries()].find(([, br]) => commitToBranch.get(firstParent) === br)?.[0] ??
					null)
				: null;

			const branchName = refBranch ?? inheritedBranchName ?? `lane-${++laneCounter}`;
			const branch = ensureBranch(branchName, firstParent);

			const subject = node.subject || '(no message)';
			const truncated = subject.length > 60 ? subject.slice(0, 57) + '…' : subject;
			// Pass the full hash so @gitgraph/react's internal React keys are unique;
			// shortHash (7 chars) can collide on busy `--all` ranges and cause React to
			// drop duplicate children → a blank graph. displayHash:false in the template
			// keeps the hash off the rendered label.
			const commitOptions = {
				hash: node.hash,
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

			// Attach tag refs (skip duplicate branch labels - gitgraph adds those automatically).
			for (const ref of node.refs) {
				const cleaned = ref.replace(/^HEAD -> /, '').trim();
				if (cleaned.startsWith('tag:')) {
					branch.tag(cleaned.replace(/^tag:\s*/, ''));
				}
			}
		}

		return core;
	}, [ordered, template, onCommitClick, selectedHash, theme.colors.accent]);

	// `<Gitgraph>` reads `props.graph` once in its constructor, so swapping in a
	// fresh GitgraphCore (e.g. when `selectedHash` changes) requires a remount.
	// `key={selectedHash}` is StrictMode-safe here because the GitgraphCore itself
	// is owned by `useMemo` above - both mounts in StrictMode's double-render share
	// the same fully-populated instance, so React only re-renders the SVG, never
	// re-runs the imperative graph construction that breaks the children-callback API.
	return (
		<div className="overflow-auto h-full p-2">
			<Gitgraph key={selectedHash ?? 'none'} graph={gitgraph} />
		</div>
	);
});
