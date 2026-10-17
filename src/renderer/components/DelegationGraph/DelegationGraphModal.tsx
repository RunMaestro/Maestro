/**
 * DelegationGraphModal - the window the Delegation Graph opens in.
 *
 * The shared `Modal` around `<DelegationGraphView>`: it registers the layer
 * (so Escape closes it through the layer stack), remembers the size the user
 * dragged it to, and defaults to most of the screen, since a graph canvas wants
 * all the room there is.
 *
 * Two things here are deliberate:
 *
 *   - It is NOT rendered through a portal. The view's Peers link opens the Edit
 *     Agent modal on top of the graph, and both modals share one z-index, so
 *     the one later in the DOM paints over the other. This modal is mounted in
 *     `AppInfoModals`, which comes before the Edit Agent modal. A portal would
 *     append it to `document.body`, after everything, and hide the form it had
 *     just opened.
 *   - The content is `select-none`: this is a surface the user clicks and
 *     drags, and a drag across the canvas must not paint a text selection. The
 *     legend, the selected-agent panel and the notice carry their own
 *     `select-text`.
 */

import { useMemo } from 'react';
import { Waypoints } from 'lucide-react';
import type { Theme } from '../../types';
import type { DelegationGraphScope } from '../../../shared/delegationGraph';
import { scopeStorageKey } from '../../../shared/delegationGraphLayout';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { viewportModalSize } from '../../utils/modalSizing';
import { EscCloseButton } from '../ui/EscCloseButton';
import { Modal } from '../ui/Modal';
import { DelegationGraphView } from './DelegationGraphView';

/** The settings key the modal's size is remembered under. */
export const DELEGATION_GRAPH_RESIZE_KEY = 'delegation-graph';

const DEFAULT_SIZE_RATIO = { width: 0.9, height: 0.88 } as const;
const MIN_SIZE = { width: 640, height: 480 } as const;

export interface DelegationGraphModalProps {
	theme: Theme;
	onClose: () => void;
	/** The scope the graph opens on, e.g. one group. Every agent when absent. */
	scope?: DelegationGraphScope;
}

export function DelegationGraphModal({ theme, onClose, scope }: DelegationGraphModalProps) {
	const defaultSize = useMemo(() => viewportModalSize(DEFAULT_SIZE_RATIO), []);

	return (
		<Modal
			theme={theme}
			title="Delegation Graph"
			priority={MODAL_PRIORITIES.DELEGATION_GRAPH}
			onClose={onClose}
			headerIcon={<Waypoints className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			showCloseButton={false}
			headerActions={
				<EscCloseButton theme={theme} onClose={onClose} testId="delegation-graph-esc" />
			}
			resizeKey={DELEGATION_GRAPH_RESIZE_KEY}
			defaultSize={defaultSize}
			minSize={MIN_SIZE}
			contentClassName="flex-1 min-h-0 flex flex-col overflow-hidden select-none"
			testId="delegation-graph-modal"
		>
			{/* The view reads its scope once, on mount. Keyed by the scope, a second
			    open that asks for another scope shows that scope. */}
			<DelegationGraphView
				key={scope ? scopeStorageKey(scope) : 'default'}
				theme={theme}
				initialScope={scope}
			/>
		</Modal>
	);
}
