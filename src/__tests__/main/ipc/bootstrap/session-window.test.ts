import { describe, expect, it, vi } from 'vitest';
import { resolveSessionWindow } from '../../../../main/ipc/bootstrap/session-window';

function fixture(ownerId: string | null, ownerPresent = true) {
	const primary = { name: 'primary' };
	const secondary = { name: 'secondary' };
	const deps = {
		windowRegistry: {
			getWindowForSession: vi.fn(() => ownerId),
			get: vi.fn(() => (ownerPresent ? { browserWindow: secondary } : undefined)),
		},
		getMainWindow: vi.fn(() => primary),
	};
	return { primary, secondary, deps };
}

describe('resolveSessionWindow', () => {
	it('resolves unclaimed agents to the primary catch-all window', () => {
		const { primary, deps } = fixture(null);
		expect(resolveSessionWindow('new-agent', deps as never)).toBe(primary);
	});

	it('preserves explicit secondary ownership', () => {
		const { secondary, deps } = fixture('window-2');
		expect(resolveSessionWindow('claimed-agent', deps as never)).toBe(secondary);
		expect(deps.getMainWindow).not.toHaveBeenCalled();
	});

	it('does not reroute a stale explicit owner to the primary window', () => {
		const { deps } = fixture('window-missing', false);
		expect(resolveSessionWindow('claimed-agent', deps as never)).toBeNull();
		expect(deps.getMainWindow).not.toHaveBeenCalled();
	});
});
