import { randomUUID } from 'crypto';
import { STEERING_TURN_FINISHED_DETAIL } from '../../shared/chatSteering';
import type { SteeringResultFrame } from '../../shared/chatSteering';
import type {
	HarnessControlCapabilities,
	HarnessControlCloseOptions,
	HarnessControlHandle,
} from '../../shared/harness-control/types';

interface RegisteredHandle {
	generation: number;
	handle: HarnessControlHandle;
}

/** Session lookup with generation-aware replacement and stale-cleanup protection. */
export class HarnessControlRegistry {
	private readonly handles = new Map<string, RegisteredHandle>();

	register(sessionId: string, generation: number, handle: HarnessControlHandle): void {
		const previous = this.handles.get(sessionId);
		this.handles.set(sessionId, { generation, handle });
		if (previous && previous.handle !== handle) {
			void previous.handle.close().catch(() => {
				// The replacement is already authoritative. The old process stop ladder
				// remains responsible for any child its adapter failed to close.
			});
		}
	}

	unregister(sessionId: string, handle: HarnessControlHandle): boolean {
		const current = this.handles.get(sessionId);
		if (!current || current.handle !== handle) return false;
		this.handles.delete(sessionId);
		return true;
	}

	forget(sessionId: string): void {
		this.handles.delete(sessionId);
	}

	has(sessionId: string): boolean {
		return this.handles.has(sessionId);
	}
	getCapabilities(sessionId: string): HarnessControlCapabilities | null {
		const current = this.handles.get(sessionId);
		if (!current) return null;
		try {
			return current.handle.getCapabilities();
		} catch {
			return null;
		}
	}

	async steer(sessionId: string, text: string): Promise<SteeringResultFrame> {
		const id = randomUUID();
		const current = this.handles.get(sessionId);
		if (!current) {
			return {
				type: 'steering',
				id,
				verdict: 'refused',
				refusal: 'not-running',
				detail: STEERING_TURN_FINISHED_DETAIL,
			};
		}
		try {
			return await current.handle.steer({ id, text });
		} catch (error) {
			return {
				type: 'steering',
				id,
				verdict: 'unknown',
				detail: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async interrupt(sessionId: string): Promise<boolean> {
		const current = this.handles.get(sessionId);
		if (!current) return false;
		try {
			await current.handle.interrupt();
			return true;
		} catch {
			return false;
		}
	}

	async close(sessionId: string, options?: HarnessControlCloseOptions): Promise<boolean> {
		const current = this.handles.get(sessionId);
		if (!current) return false;
		this.handles.delete(sessionId);
		try {
			await current.handle.close(options);
			return true;
		} catch {
			return false;
		}
	}
}
