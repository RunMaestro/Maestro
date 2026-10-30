import { describe, expect, it, vi } from 'vitest';
import { HarnessControlRegistry } from '../../../main/harness-control/HarnessControlRegistry';
import type {
	HarnessControlCapabilities,
	HarnessControlHandle,
} from '../../../shared/harness-control/types';

const capabilities: HarnessControlCapabilities = {
	protocol: 'acp',
	protocolVersion: '1',
	steering: 'in-turn',
	permissionRequests: true,
	questions: false,
	elicitations: false,
	modelSwitch: false,
	modeSwitch: false,
	imagePrompts: false,
	resume: false,
};

function handleFixture(): HarnessControlHandle {
	return {
		getCapabilities: () => capabilities,
		steer: vi.fn(async ({ id, text }) => ({
			type: 'steering' as const,
			id,
			verdict: 'delivered' as const,
			detail: text,
		})),
		interrupt: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
	};
}

describe('HarnessControlRegistry', () => {
	it('refuses steering when no running handle exists', async () => {
		const registry = new HarnessControlRegistry();
		await expect(registry.steer('missing', 'hello')).resolves.toMatchObject({
			verdict: 'refused',
			refusal: 'not-running',
		});
	});

	it('delegates control and exposes negotiated capabilities', async () => {
		const registry = new HarnessControlRegistry();
		const handle = handleFixture();
		registry.register('session-a', 1, handle);
		expect(registry.getCapabilities('session-a')).toEqual(capabilities);
		await expect(registry.steer('session-a', 'change course')).resolves.toMatchObject({
			verdict: 'delivered',
			detail: 'change course',
		});
		await expect(registry.interrupt('session-a')).resolves.toBe(true);
		expect(handle.interrupt).toHaveBeenCalledOnce();
	});

	it('closes a replaced handle and ignores stale cleanup', async () => {
		const registry = new HarnessControlRegistry();
		const oldHandle = handleFixture();
		const newHandle = handleFixture();
		registry.register('session-a', 1, oldHandle);
		registry.register('session-a', 2, newHandle);
		expect(oldHandle.close).toHaveBeenCalledOnce();
		expect(registry.unregister('session-a', oldHandle)).toBe(false);
		expect(registry.getCapabilities('session-a')).toEqual(capabilities);
		expect(registry.unregister('session-a', newHandle)).toBe(true);
		expect(registry.getCapabilities('session-a')).toBeNull();
	});
});
