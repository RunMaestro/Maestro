/**
 * dataviewJsGuestSlots - how many DataviewJS guests one window keeps mounted (D4, R-3).
 *
 * Every `dataviewjs` block runs in its own `<webview>` guest (DEV-5), and every guest is a renderer process
 * (or a share of one). A note with many blocks must not start them all at once, so a block mounts its guest
 * only once it holds one of the window's {@link DATAVIEW_JS_MAX_GUESTS_PER_WINDOW} slots, and asks for one
 * only while it is near the viewport. When the slots run out, the holder that left the viewport longest ago
 * gives its slot up (its guest unmounts and runs again when it comes back); when every holder is on screen,
 * the newcomer waits for the first one to leave or unmount.
 */

import { DATAVIEW_JS_MAX_GUESTS_PER_WINDOW } from '../../shared/dataview';

export interface GuestSlotCallbacks {
	/** The block holds a slot now: mount the guest. */
	onGrant(): void;
	/** The slot was given to a block nearer the viewport: unmount the guest. */
	onEvict(): void;
}

export interface GuestSlotClaim {
	/** Report whether the block is near the viewport. Near asks for a slot; far lets one go if needed. */
	setNear(near: boolean): void;
	/** The block unmounted: give up its slot or its place in line. */
	release(): void;
}

interface Claimant {
	callbacks: GuestSlotCallbacks;
	near: boolean;
	/** When the block last left the viewport; the oldest far holder is evicted first. */
	farSince: number;
}

const holders = new Set<Claimant>();
const waiting: Claimant[] = [];
let maxSlots = DATAVIEW_JS_MAX_GUESTS_PER_WINDOW;
/** A counter rather than the clock, so two blocks that leave in the same millisecond keep their order. */
let farClock = 0;

function grant(claimant: Claimant): void {
	holders.add(claimant);
	claimant.callbacks.onGrant();
}

/** Hand free (or freeable) slots to waiting blocks, first come first served. */
function pump(): void {
	while (waiting.length > 0) {
		if (holders.size < maxSlots) {
			grant(waiting.shift()!);
			continue;
		}
		let oldest: Claimant | null = null;
		for (const holder of holders) {
			if (!holder.near && (oldest === null || holder.farSince < oldest.farSince)) oldest = holder;
		}
		if (oldest === null) return;
		holders.delete(oldest);
		oldest.callbacks.onEvict();
		grant(waiting.shift()!);
	}
}

/** Join the window's slot pool. The block starts far, holding nothing. */
export function claimDataviewJsGuestSlot(callbacks: GuestSlotCallbacks): GuestSlotClaim {
	const claimant: Claimant = { callbacks, near: false, farSince: 0 };
	let released = false;
	return {
		setNear(near) {
			if (released || near === claimant.near) return;
			claimant.near = near;
			if (near) {
				if (!holders.has(claimant) && !waiting.includes(claimant)) waiting.push(claimant);
			} else {
				claimant.farSince = ++farClock;
				const index = waiting.indexOf(claimant);
				if (index >= 0) waiting.splice(index, 1);
			}
			pump();
		},
		release() {
			if (released) return;
			released = true;
			holders.delete(claimant);
			const index = waiting.indexOf(claimant);
			if (index >= 0) waiting.splice(index, 1);
			pump();
		},
	};
}

/** Test seam: empty the pool and set its size (the default when omitted). */
export function resetDataviewJsGuestSlotsForTests(slots = DATAVIEW_JS_MAX_GUESTS_PER_WINDOW): void {
	holders.clear();
	waiting.length = 0;
	maxSlots = slots;
	farClock = 0;
}
