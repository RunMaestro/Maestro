import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	registerPendingEdit,
	flushAllPendingEdits,
	__resetPendingEditsRegistryForTests,
} from '../../../../renderer/hooks/cue/pendingEditsRegistry';

describe('pendingEditsRegistry', () => {
	afterEach(() => {
		__resetPendingEditsRegistryForTests();
	});

	it('flushAllPendingEdits invokes every registered callback', () => {
		const a = vi.fn();
		const b = vi.fn();
		registerPendingEdit(a);
		registerPendingEdit(b);

		flushAllPendingEdits();

		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
	});

	it('unregister prevents subsequent invocation', () => {
		const cb = vi.fn();
		const unregister = registerPendingEdit(cb);
		unregister();
		flushAllPendingEdits();
		expect(cb).not.toHaveBeenCalled();
	});

	it('registering the same callback twice coalesces via Set semantics', () => {
		const cb = vi.fn();
		registerPendingEdit(cb);
		registerPendingEdit(cb);
		flushAllPendingEdits();
		expect(cb).toHaveBeenCalledTimes(1);
	});
});
