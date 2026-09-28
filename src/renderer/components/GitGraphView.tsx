import {
	createContext,
	memo,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	type ReactElement,
} from 'react';
import { Gitgraph } from '@gitgraph/react';
import type { Theme } from '../types';
import type { GitGraphNode } from '../services/git';
import { useStableCallback } from '../hooks/utils/useStableCallback';
import { buildGitGraphCore, buildGitGraphTemplate } from '../utils/gitGraphLayout';

// `@gitgraph/react`'s public Gitgraph component is parameterised on
// `ReactElement<SVGElement>` (its internal `ReactSvgElement`). The library
// doesn't re-export that type from its index, so reproduce it here so a
// userland-built `GitgraphCore` instance type-checks against the `graph` prop.
type ReactSvgElement = ReactElement<SVGElement>;

// Radius of the invisible circle that catches clicks. The drawn dot is ~5px
// across, a target under every pointer-size guideline and genuinely painful to
// hit in a dense graph, so the hit area is widened well past it without making
// the graph look heavier. It stays under half the 24px commit pitch so
// neighbouring commits cannot steal each other's clicks.
const DOT_HIT_RADIUS = 11;
// How far the selection ring sits outside the dot itself.
const SELECTION_RING_GAP = 3.5;

/**
 * Which commit is selected, and what to do when one is clicked.
 *
 * This rides a context rather than the @gitgraph core because the core must
 * stay STABLE: rebuilding it swaps the `graph` prop, and `<Gitgraph>` reads
 * that only in its constructor, so a changed core means a remounted SVG. During
 * the remount the scroll container is briefly empty, which clamps its scroll
 * offsets to zero - the graph snaps back to the newest commit on every arrow
 * keypress, which reads as the keys being broken. Only the dots depend on the
 * selection, and only the dots re-render when it changes.
 */
const GitGraphSelectionContext = createContext<{
	selectedHash?: string;
	accent: string;
	onCommitClick?: (hash: string) => void;
}>({ accent: 'currentColor' });

/**
 * One commit dot: a wide invisible hit target, the visible dot, and the
 * selection ring when this is the selected commit.
 *
 * @gitgraph's own `<Dot>` returns `commit.renderDot(commit)` and nothing else,
 * so the click handler it would normally wrap the dot in is not applied - this
 * wires `onClick` itself.
 */
const GitGraphDot = memo(function GitGraphDot({
	hash,
	radius,
	color,
}: {
	hash: string;
	radius: number;
	color: string;
}) {
	const { selectedHash, accent, onCommitClick } = useContext(GitGraphSelectionContext);
	const selected = selectedHash === hash;
	const handleClick = useCallback(() => onCommitClick?.(hash), [onCommitClick, hash]);

	// Every circle is centered on (radius, radius), which is where @gitgraph
	// draws the branch line through this commit. Centering the hit area anywhere
	// else would put the clickable region beside the dot the user is aiming at.
	return (
		<g
			data-commit-dot={hash}
			data-selected={selected || undefined}
			onClick={handleClick}
			style={{ cursor: onCommitClick ? 'pointer' : 'default' }}
		>
			{/* Hit area. A `transparent` fill is what makes it catch pointer events -
			    `fill="none"` would let clicks pass straight through it. */}
			<circle cx={radius} cy={radius} r={DOT_HIT_RADIUS} fill="transparent" />
			{selected && (
				<circle
					cx={radius}
					cy={radius}
					r={radius + SELECTION_RING_GAP}
					fill="none"
					stroke={accent}
					strokeWidth={2}
				/>
			)}
			<circle cx={radius} cy={radius} r={radius} fill={color} />
		</g>
	);
});

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

	// Identity-stable so a fresh parent render cannot invalidate the core below.
	const handleCommitClick = useStableCallback((hash: string) => onCommitClick?.(hash));

	const selection = useMemo(
		() => ({
			selectedHash,
			accent: theme.colors.accent,
			onCommitClick: onCommitClick ? handleCommitClick : undefined,
		}),
		[selectedHash, theme.colors.accent, onCommitClick, handleCommitClick]
	);

	// Build the GitgraphCore imperatively here (not via the children-callback API).
	// The callback API populates the graph during componentDidMount, which under
	// React.StrictMode runs twice and ends up with duplicate React keys / mis-rendered
	// SVG. Owning the graph instance ourselves keeps the data stable across the
	// dev-only mount→unmount→remount cycle, so what the user sees in dev matches
	// production.
	//
	// The construction is shared with the keyboard navigation, which reads its
	// geometry back out of a core built the same way - see gitGraphLayout. Its
	// dependencies are deliberately only the DATA and the THEME: nothing about
	// the current selection may enter here, or the SVG is torn down on every
	// keypress (see GitGraphSelectionContext).
	const gitgraph = useMemo(
		() =>
			buildGitGraphCore<ReactSvgElement>(nodes, {
				template,
				onCommitClick: handleCommitClick,
				renderDot: (commit) => (
					<GitGraphDot
						hash={commit.hash}
						radius={commit.style.dot.size}
						color={commit.style.dot.color ?? theme.colors.accent}
					/>
				),
			}),
		[nodes, template, handleCommitClick, theme.colors.accent]
	);

	// `<Gitgraph>` reads `props.graph` in its CONSTRUCTOR only, so a new core takes
	// effect on a remount and nowhere else. The key is therefore derived from the
	// core's own contents: new commits (or a new theme, which repaints the whole
	// graph) must remount, and anything else - above all a change of selection -
	// must not. Keying on the selection is what threw the scroll position away on
	// every keypress: the replacement SVG is momentarily empty, so the browser
	// clamps the container's scroll offsets to zero.
	const graphKey = useMemo(() => {
		const commits = gitgraph.commits;
		const first = commits[0]?.hash ?? '';
		const last = commits[commits.length - 1]?.hash ?? '';
		return `${theme.name}:${commits.length}:${first}:${last}`;
	}, [gitgraph, theme.name]);

	// Keep the selected commit on screen. Arrow keys can walk a 200-commit graph
	// well past the viewport in either axis, and a selection the user cannot see
	// is indistinguishable from the keys not working. The dot is found by the
	// marker its own renderer stamps on it, and MEASURED rather than recomputed,
	// so this stays correct through @gitgraph's label offsets and root translate.
	useEffect(() => {
		if (!selectedHash) return;
		let frame = 0;

		const reveal = (): boolean => {
			const container = scrollRef.current;
			if (!container) return true;
			const dot = container.querySelector(`[data-commit-dot="${CSS.escape(selectedHash)}"]`);
			if (!dot || typeof dot.getBoundingClientRect !== 'function') return false;

			const target = dot.getBoundingClientRect();
			const view = container.getBoundingClientRect();
			// jsdom reports every rect as zero, which would read as "off screen" and
			// scroll on every selection change; a zero-size viewport is never real.
			if (view.height === 0 || view.width === 0) return true;

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
			return true;
		};

		// @gitgraph populates its own commits from a `setTimeout(0)` the core
		// schedules while it is being built, so right after a rebuild there is no
		// dot to measure yet. Retry once on the next frame rather than silently
		// skipping the very first jump after the graph loads.
		if (!reveal() && typeof requestAnimationFrame === 'function') {
			frame = requestAnimationFrame(() => {
				reveal();
			});
		}
		return () => {
			if (frame) cancelAnimationFrame(frame);
		};
	}, [selectedHash, graphKey]);

	return (
		<div ref={scrollRef} className="overflow-auto h-full p-2">
			<GitGraphSelectionContext.Provider value={selection}>
				<Gitgraph key={graphKey} graph={gitgraph} />
			</GitGraphSelectionContext.Provider>
		</div>
	);
});
