/**
 * Queues voice dispatches that hit a busy destination and retries them once
 * the floor is quiet, while letting the user keep appending follow-up words
 * to the pending prompt.
 */

import { canonicalJson } from '../../../shared/canonicalJson';
import type { RosterAgent, VoiceScope, VoiceSendState } from '../../../shared/acappella/protocol';
import type { RouteDecision } from '../../../shared/acappella/route-decision';
import type { VoiceDispatchResult, VoiceRouteExecutor } from '../voice-session-service';

export interface PendingSendItem {
	decision: RouteDecision;
	scope: VoiceScope;
	agentSessionId: string;
	tabId: string;
}

export interface PendingSendQueueDeps {
	getForceSendAllowed: () => boolean;
	getSessionId: () => string | null;
	canSchedule: () => boolean;
	canSetForceSend: (enabled: boolean) => boolean;
	isSessionOpen: () => boolean;
	isReadyToRetry: () => boolean;
	hasExecutor: () => boolean;
	getRoster: () => RosterAgent[] | Promise<RosterAgent[]>;
	executeRoute: VoiceRouteExecutor;
	beginRetryTurn: () => number;
	isCurrentTurn: (turn: number) => boolean;
	finishDispatch: (decision: RouteDecision, result: VoiceDispatchResult, turn: number) => void;
	isBusyError: (error: unknown) => boolean;
	onRetryBusy: () => void;
	onRetryError: (error: Error) => void;
	onSendStateChange: (state: VoiceSendState) => void;
}

export class PendingSendQueue {
	private forceSend = false;
	private pendingSends: PendingSendItem[] = [];
	private pendingSendTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly deps: PendingSendQueueDeps) {}

	isForceSendRequested(): boolean {
		return this.forceSend;
	}

	getSendState(): VoiceSendState {
		return {
			forceSend: this.forceSend && this.deps.getForceSendAllowed(),
			pending: this.pendingSends.map(({ agentSessionId, tabId, decision }) => ({
				agentSessionId,
				tabId,
				text: decision.prompt,
			})),
		};
	}

	setForceSend(enabled: boolean): boolean {
		if (!this.deps.canSetForceSend(enabled)) return false;
		this.forceSend = enabled;
		this.publishSendState();
		this.schedule(0);
		return true;
	}

	enqueue(item: PendingSendItem): void {
		this.pendingSends.push(item);
		this.publishSendState();
	}

	appendIfPending(scope: VoiceScope | null, utterance: string): boolean {
		const pending = this.pendingSends.find(
			(item) => canonicalJson(item.scope) === canonicalJson(scope)
		);
		if (!pending) return false;
		pending.decision = {
			...pending.decision,
			prompt: `${pending.decision.prompt}\n\n${utterance}`,
		};
		this.publishSendState();
		return true;
	}

	clear(options: { resetForceSend?: boolean } = {}): void {
		if (this.pendingSendTimer !== null) clearTimeout(this.pendingSendTimer);
		this.pendingSendTimer = null;
		this.pendingSends = [];
		if (options.resetForceSend) {
			this.forceSend = false;
		}
	}

	schedule(delayMs = 750): void {
		if (!this.pendingSends.length || !this.deps.canSchedule()) return;
		if (this.pendingSendTimer !== null) clearTimeout(this.pendingSendTimer);
		this.pendingSendTimer = setTimeout(() => {
			this.pendingSendTimer = null;
			void this.retry();
		}, delayMs);
	}

	private publishSendState(): void {
		this.deps.onSendStateChange(this.getSendState());
	}

	private async retry(): Promise<void> {
		const pending = this.pendingSends[0];
		if (!pending || !this.deps.hasExecutor()) return;
		if (!this.deps.isReadyToRetry()) {
			this.schedule();
			return;
		}
		const sessionId = this.deps.getSessionId();
		try {
			const roster = await this.deps.getRoster();
			if (this.deps.getSessionId() !== sessionId || !this.deps.isReadyToRetry()) return;
			const turn = this.deps.beginRetryTurn();
			try {
				const result = await this.deps.executeRoute(pending.decision, {
					roster,
					scope: pending.scope,
					...(this.getSendState().forceSend ? { force: true } : {}),
				});
				if (!this.deps.isCurrentTurn(turn)) return;
				this.pendingSends.shift();
				this.publishSendState();
				this.deps.finishDispatch(pending.decision, result, turn);
			} catch (error) {
				if (!this.deps.isCurrentTurn(turn)) return;
				if (!this.deps.isBusyError(error)) throw error;
				this.deps.onRetryBusy();
			}
		} catch (error) {
			if (this.deps.getSessionId() !== sessionId) return;
			this.deps.onRetryError(error as Error);
		} finally {
			if (this.deps.getSessionId() === sessionId && this.deps.isSessionOpen()) {
				this.schedule();
			}
		}
	}
}
