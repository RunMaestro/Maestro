/**
 * How big an agent node is on the Delegation Graph.
 *
 * A leaf module on purpose. The node component draws to these numbers and the
 * layout engine (`../delegationLayouts.ts`) reserves space with them, and the
 * engine must not import a React component, and through it the session store,
 * to learn a width.
 */

import { estimateLabelWidth } from '../../../utils/labelWidth';

/** The node's fixed height, for a layout that runs before the node is measured. */
export const AGENT_DELEGATION_NODE_HEIGHT = 80;
/** The node's least width. It grows with the agent's name. */
export const AGENT_DELEGATION_NODE_MIN_WIDTH = 180;

/** Everything in the node's name row that is not the name: grip, padding, gap, group pill. */
const NAME_ROW_CHROME = 110;

/**
 * How wide a node is drawn for a name, near enough for a layout that runs
 * before the node is measured.
 */
export function estimateAgentDelegationNodeWidth(name: string): number {
	return estimateLabelWidth(name, {
		fontSizePx: 13,
		chromePx: NAME_ROW_CHROME,
		minPx: AGENT_DELEGATION_NODE_MIN_WIDTH,
	});
}
