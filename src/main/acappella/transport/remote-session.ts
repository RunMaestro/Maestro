/**
 * What it means for a phone to hold the microphone.
 *
 * The single most important property of this file is what it does NOT do. A
 * remote utterance is not a second pipeline, a second router, or a second voice.
 * The phone presses talk, this coordinator presses the SAME
 * `FloorController` the desktop hotkey presses, and the session that opens runs
 * the identical STT, routing, dispatch, translation, and TTS as a sentence
 * spoken at the keyboard. The only thing that differs is `VoiceOrigin`, which
 * exists so the desktop HUD can say which microphone is open rather than to
 * branch on.
 *
 * Three rules it enforces:
 *
 * **One floor.** There is one microphone stream feeding one recogniser, so two
 * devices talking at once cannot be mixed into one utterance without producing a
 * transcript of neither. The rule is **last press wins**: a device that presses
 * talk takes the floor, whoever had it, and the displaced device is told
 * immediately with `takenOverBy` so its button snaps back rather than lying. Any
 * other rule ends with a user pressing talk on the phone in their hand and
 * nothing happening because a laptop in another room is holding the floor - and
 * every device here was individually approved by the person doing the pressing.
 *
 * **A stale release cannot close a live floor.** Only the CURRENT holder's
 * release does anything. Without this, a device that just lost the floor sending
 * its release (which it will, a few milliseconds later) would shut the
 * microphone of the device that just took it.
 *
 * **A dropped connection ends the session, cleanly.** Not "eventually", and
 * never by leaving a `speaking` state nobody will finish or a floor nobody will
 * close. `disconnected` is deliberately not that trigger - ICE reports it during
 * an ordinary WiFi-to-LTE handover, which is the normal case on a walk - but
 * `failed`, `closed`, and a lost signaling socket are.
 *
 * Wake word and stop word stay on whichever device is capturing. That is the
 * standing rule that no audio leaves a device before the wake phrase fires, and
 * it falls out of the design rather than being enforced here: the phone's
 * microphone is not sent anywhere until the phone opens the floor.
 */

import {
	deviceChannelForMessage,
	type DeviceCandidateType,
	type DeviceMessage,
} from '../../../shared/acappella/device-protocol';
import type { VoiceEvent, VoiceOrigin, VoiceScope } from '../../../shared/acappella/protocol';
import type { PeerConnectionState } from '../../../shared/acappella/webrtc-host';
import { isTerminalPeerState } from '../../../shared/acappella/webrtc-host';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = 'ACappella';

/** The slice of `FloorController` a remote device drives. */
export interface RemoteFloor {
	press(source?: 'remote-device'): Promise<void>;
	release(source?: 'remote-device'): Promise<void>;
	close(reason: 'session-ended' | 'shutdown' | 'toggle'): Promise<void>;
	readonly isFloorOpen: boolean;
}

/** The slice of `VoiceSessionService` this coordinator needs. */
export interface RemoteVoiceSession {
	subscribe(listener: (event: VoiceEvent) => void): () => void;
	interrupt(source: 'voice' | 'client-button'): boolean;
	hardStop(source: 'voice' | 'client-button', phrase?: string): Promise<void>;
	stopSession(reason: 'user' | 'shutdown' | 'error'): Promise<void>;
	getState(): string;
}

/** Sends protocol messages to devices. In production, the audio host's peers. */
export interface RemoteMessageSink {
	send(deviceId: string, message: DeviceMessage): void;
	broadcast(message: DeviceMessage): void;
}

export interface RemoteSessionCoordinatorOptions {
	/**
	 * The one floor controller, configured for `origin` before the press.
	 *
	 * A function rather than a value because the floor's scope and origin are set
	 * immediately before a press by whoever is pressing - the same pattern the
	 * hotkeys use, and the reason there is one state machine rather than one per
	 * surface.
	 */
	acquireFloor: (scope: VoiceScope, origin: VoiceOrigin) => RemoteFloor;
	session: RemoteVoiceSession;
	sink: RemoteMessageSink;
	/** Name for a device id, for the HUD line and the takeover message. */
	getDeviceName: (deviceId: string) => string;
	/** Set when a device leaves the floor for any reason. Used by the device list. */
	onFloorChange?: (holder: string | null) => void;
}

/** Who holds the floor. `'local'` is this machine's own microphone. */
export type FloorHolder = 'local' | string;

export class RemoteSessionCoordinator {
	private readonly options: RemoteSessionCoordinatorOptions;
	private readonly connected = new Set<string>();
	private holder: FloorHolder | null = null;
	private readonly unsubscribe: () => void;
	/** Serialises floor changes so a press and a release cannot interleave. */
	private queue: Promise<void> = Promise.resolve();

	constructor(options: RemoteSessionCoordinatorOptions) {
		this.options = options;
		this.unsubscribe = options.session.subscribe((event) => this.handleVoiceEvent(event));
	}

	dispose(): void {
		this.unsubscribe();
		this.connected.clear();
		this.holder = null;
	}

	/** Who has the microphone right now, or null when nobody does. */
	get floorHolder(): FloorHolder | null {
		return this.holder;
	}

	/** Resolves once every queued floor change has run. Tests and shutdown use it. */
	whenSettled(): Promise<void> {
		return this.queue;
	}

	// -- Connection lifecycle -------------------------------------------------

	/** A device's peer connection came up. */
	handleConnected(deviceId: string): void {
		this.connected.add(deviceId);
		this.publishFloorState();
	}

	/**
	 * A peer connection changed state.
	 *
	 * Only terminal states end anything. `disconnected` is ICE noticing a network
	 * change, and a walk out of WiFi range recovers from it within seconds; ending
	 * the session there would hang up on the exact user this transport exists for.
	 */
	handlePeerState(deviceId: string, state: PeerConnectionState): void {
		if (state === 'connected') {
			this.handleConnected(deviceId);
			return;
		}
		if (!isTerminalPeerState(state)) return;
		this.handleDisconnected(deviceId, `the connection to ${this.name(deviceId)} ${state}`);
	}

	/**
	 * A device is gone: signaling closed, peer failed, or the pairing was revoked.
	 *
	 * If it was holding the floor, the session ends here rather than being left to
	 * a timeout. An orphaned `speaking` state talks to an empty room, and an
	 * orphaned open floor is a microphone nobody knows is on.
	 */
	handleDisconnected(deviceId: string, reason: string): void {
		this.connected.delete(deviceId);
		if (this.holder !== deviceId) {
			this.publishFloorState();
			return;
		}
		void this.enqueue(async () => {
			logger.info(`Remote floor lost: ${reason}`, LOG_CONTEXT);
			this.holder = null;
			// Cancel speech first, then close the session. In that order because the
			// reverse leaves a sentence in flight after the session that owns it has
			// gone: the TTS chunks are already queued in the audio host and the thing
			// that cancels them is the interrupt, not the stop.
			this.options.session.interrupt('client-button');
			await this.options.session.stopSession('user');
			this.options.onFloorChange?.(null);
			this.publishFloorState();
		});
	}

	// -- Inbound device messages ---------------------------------------------

	/** One protocol message from a device. Unknown or unauthorised ones are dropped. */
	handleDeviceMessage(deviceId: string, message: DeviceMessage): void {
		switch (message.type) {
			case 'floor':
				if (message.action === 'press') this.requestFloor(deviceId, message.scope);
				else this.releaseFloor(deviceId);
				return;
			case 'interrupt':
				// Barge-in keeps the floor; the stop word ends the session. Both are
				// refused from a device that is not holding the floor, because
				// interrupting a conversation you are not in is not a thing.
				if (this.holder !== deviceId) return;
				if (message.kind === 'stop-word') void this.options.session.hardStop('client-button');
				else this.options.session.interrupt('client-button');
				return;
			case 'audio-level':
			case 'hello':
			case 'link-quality':
				// Handled by the peer host and the device list, not by the floor.
				return;
			default:
				return;
		}
	}

	/**
	 * A device pressed talk.
	 *
	 * Last press wins. The displaced holder is told before the new session starts,
	 * so its button lets go while the takeover is happening rather than after.
	 */
	requestFloor(deviceId: string, scope?: VoiceScope): Promise<void> {
		return this.enqueue(async () => {
			if (this.holder === deviceId) return;
			const previous = this.holder;
			this.holder = deviceId;

			if (previous && previous !== 'local') {
				this.options.sink.send(previous, {
					type: 'floor-state',
					holder: deviceId,
					isSelf: false,
					takenOverBy: this.name(deviceId),
				});
			}

			const origin: VoiceOrigin = {
				kind: 'remote',
				deviceId,
				deviceName: this.name(deviceId),
			};
			const floor = this.options.acquireFloor(scope ?? { kind: 'conductor' }, origin);
			// `press()` on the shared controller: the session it opens is a normal
			// session in every respect, which is the point.
			await floor.press('remote-device');
			this.options.onFloorChange?.(deviceId);
			this.publishFloorState();
		});
	}

	/** A device let go. Ignored unless that device is the one holding the floor. */
	releaseFloor(deviceId: string): Promise<void> {
		return this.enqueue(async () => {
			if (this.holder !== deviceId) return;
			const origin: VoiceOrigin = {
				kind: 'remote',
				deviceId,
				deviceName: this.name(deviceId),
			};
			const floor = this.options.acquireFloor({ kind: 'conductor' }, origin);
			await floor.release('remote-device');
			// The floor stays credited to the device until the session actually ends:
			// in tap-to-toggle a release is a no-op, and in hold-to-talk the session
			// lives on to answer. `listen-stop` is what clears the holder.
			this.publishFloorState();
		});
	}

	/** The desktop took the floor back. Every device is told it is not holding it. */
	takeLocalFloor(): void {
		const previous = this.holder;
		this.holder = 'local';
		if (previous && previous !== 'local') {
			this.options.sink.send(previous, {
				type: 'floor-state',
				holder: 'local',
				isSelf: false,
				takenOverBy: 'this computer',
			});
		}
		this.options.onFloorChange?.('local');
		this.publishFloorState();
	}

	// -- Outbound -------------------------------------------------------------

	/**
	 * Forward one session event to every connected device, on the channel the
	 * protocol table says it belongs on.
	 *
	 * Every device sees the whole stream, including while another device holds the
	 * floor, because a phone in a pocket still has to be able to show what the Mac
	 * is doing. Only the microphone is exclusive.
	 */
	private handleVoiceEvent(event: VoiceEvent): void {
		if (this.connected.size > 0) {
			this.options.sink.broadcast({ type: 'voice-event', event });
		}

		// The floor is released by the SESSION ending, not by the release message,
		// so this is where a remote holder stops being the holder.
		if (event.type === 'listen-stop' || event.type === 'stop-word') {
			if (this.holder && this.holder !== 'local') {
				this.holder = null;
				this.options.onFloorChange?.(null);
				this.publishFloorState();
			}
		}
		if (event.type === 'listen-start' && event.origin?.kind === 'local') {
			// A local wake or hotkey opened the floor without going through this
			// coordinator. Reflecting it keeps the phones honest rather than leaving
			// them showing a floor that moved without telling them.
			if (this.holder !== 'local') {
				this.holder = 'local';
				this.publishFloorState();
			}
		}
	}

	private publishFloorState(): void {
		for (const deviceId of this.connected) {
			this.options.sink.send(deviceId, {
				type: 'floor-state',
				holder: this.holder,
				isSelf: this.holder === deviceId,
			});
		}
	}

	private name(deviceId: string): string {
		return this.options.getDeviceName(deviceId) || 'a paired device';
	}

	private enqueue(action: () => Promise<void>): Promise<void> {
		const next = this.queue.then(action).catch((error: Error) => {
			logger.error(`Remote floor failure: ${error.message}`, LOG_CONTEXT);
		});
		this.queue = next;
		return next;
	}
}

/**
 * Which channel a message goes out on, re-exported so a sink implementation does
 * not have to reach into the protocol module to find out.
 */
export { deviceChannelForMessage };
export type { DeviceCandidateType };
