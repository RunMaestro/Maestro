import { memo, useEffect, useMemo, useRef, type ReactElement } from 'react';
import { Gitgraph } from '@gitgraph/react';
import type { Theme } from '../types';
import type { GitGraphNode } from '../services/git';
import { buildGitGraphCore, buildGitGraphTemplate } from '../utils/gitGraphLayout';

// `@gitgraph/react`'s public Gitgraph component is parameterised on
// `ReactElement<SVGElement>` (its internal `ReactSvgElement`). The library
// doesn't re-export that type from its index, so reproduce it here so a
// userland-built `GitgraphCore` instance type-checks against the `graph` prop.
type ReactSvgElement = ReactElement<SVGElement>;

interface GitGraphViewProps {
	nodes: GitGraphNode[];
	theme: Theme;
	onCommitClick?: (hash: string) => void;
	selectedHash?: string;
}

export const GitGraphView = memo(function GitGraphView({
	nodes,
	theme,
	onCommitClick,
	selectedHash,
}: GitGraphViewProps) {
	const template = useMemo(() => buildGitGraphTemplate(theme), [theme]);
	const scrollRef = useRef<HTMLDivElement>(null);

	// Build the GitgraphCore imperatively here (not via the children-callback API).
	// The callback API populates the graph during componentDidMount, which under
	// React.StrictMode runs twice and ends up with duplicate React keys / mis-rendered
	// SVG. Owning the graph instance ourselves keeps the data stable across the
	// dev-only mount→unmount→remount cycle, so what the user sees in dev matches
	// production.
	//
	// The construction itself is shared with the keyboard navigation, which reads
	// its geometry back out of a core built the same way - see gitGraphLayout.
	const gitgraph = useMemo(
		() =>
			buildGitGraphCore<ReactSvgElement>(nodes, {
				template,
				onCommitClick,
				selectedHash,
				selectionColor: theme.colors.accent,
			}),
		[nodes, template, onCommitClick, selectedHash, theme.colors.accent]
	);

	// Keep the selected commit on screen. Arrow keys can walk a 200-commit graph
	// well past the viewport in either axis, and a selection the user cannot see
	// is indistinguishable from the keys not working. The dot is found by the id
	// @gitgraph puts on each commit's `<use>`; measuring the real element rather
	// than recomputing coordinates keeps this correct through the library's own
	// label offsets and the SVG's root translate.
	useEffect(() => {
		const container = scrollRef.current;
		if (!selectedHash || !container) return;
		const dot = Array.from(container.getElementsByTagName('use')).find(
			(el) =>
				!el.closest('defs') &&
				(el.getAttribute('xlink:href') === `#${selectedHash}` ||
					el.getAttribute('href') === `#${selectedHash}`)
		);
		if (!dot || typeof dot.getBoundingClientRect !== 'function') return;

		const target = dot.getBoundingClientRect();
		const view = container.getBoundingClientRect();
		// jsdom reports every rect as zero, which would read as "off screen" and
		// scroll on every selection change; a zero-size viewport is never real.
		if (view.height === 0 || view.width === 0) return;

		const margin = 48;
		if (target.top < view.top + margin) {
			container.scrollTop -= view.top + margin - target.top;
		} else if (target.bottom > view.bottom - margin) {
			container.scrollTop += target.bottom - (view.bottom - margin);
		}
		if (target.left < view.left + margin) {
			container.scrollLeft -= view.left + margin - target.left;
		} else if (target.right > view.right - margin) {
			container.scrollLeft += target.right - (view.right - margin);
		}
	}, [selectedHash, gitgraph]);

	// `<Gitgraph>` reads `props.graph` once in its constructor, so swapping in a
	// fresh GitgraphCore (e.g. when `selectedHash` changes) requires a remount.
	// `key={selectedHash}` is StrictMode-safe here because the GitgraphCore itself
	// is owned by `useMemo` above - both mounts in StrictMode's double-render share
	// the same fully-populated instance, so React only re-renders the SVG, never
	// re-runs the imperative graph construction that breaks the children-callback API.
	return (
		<div ref={scrollRef} className="overflow-auto h-full p-2">
			<Gitgraph key={selectedHash ?? 'none'} graph={gitgraph} />
		</div>
	);
});
