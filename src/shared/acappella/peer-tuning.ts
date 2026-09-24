/**
 * The two pure functions both ends of an A Cappella peer connection need.
 *
 * They were written for the desktop half in
 * `renderer/acappella-audio/peer-connection.ts` and then a second endpoint
 * appeared - the browser reference client in `src/web-desktop/acappella-client/`
 * - that has to do exactly the same two things from the other side of the wire:
 *
 *   - {@link applyOpusPreferences} turns the desktop's `RemoteAudioConfig` into
 *     the SDP the encoder is actually configured by. The offerer and the
 *     answerer both apply it, to the same config, or one of them is negotiating
 *     a codec the other did not ask for.
 *   - {@link summarizeStats} reduces a `getStats()` report to the four numbers
 *     the `link-quality` message carries. Both ends send that message, and the
 *     whole point of it is that both ends draw the SAME bar from the SAME
 *     numbers rather than each measuring its own half of the link.
 *
 * Two copies of either one would drift, and the drift would be invisible: a
 * client that mapped `prflx` to `unknown` would quietly report a worse
 * connection than it has, and nothing would ever fail.
 *
 * Free of DOM and Node types on purpose. The inputs are plain strings and plain
 * report objects, which is also what makes them testable against fixtures - and
 * a fixture is the only way to notice when Chromium changes the shape of a stats
 * report.
 */

import type { DeviceCandidateType } from './device-protocol';
import type { PeerQualityStats, RemoteAudioConfig } from './webrtc-host';

/**
 * How often `getStats()` is read.
 *
 * Two seconds, because that is roughly how fast a signal indicator can change
 * without reading as noise, and because a stats poll walks every report the
 * connection has. Polling per second bought nothing a user could perceive and
 * cost measurable main-thread time on a machine already running speech.
 */
export const PEER_STATS_INTERVAL_MS = 2000;

// ---------------------------------------------------------------------------
// SDP shaping
// ---------------------------------------------------------------------------

/**
 * Turn on Opus in-band FEC and DTX and set the target bitrate, by editing the
 * `fmtp` line for Opus.
 *
 * SDP munging is unpleasant and it is also the only way to say these three
 * things: `RTCRtpSender.setParameters` can cap a bitrate but has no knob for FEC
 * or DTX, and both of them matter for exactly the network this feature runs on.
 * FEC is what makes 5% packet loss sound like nothing instead of like a robot;
 * DTX stops a phone in a pocket from transmitting silence over a metered radio.
 *
 * Written to be safe on an SDP with no Opus in it (returns the input unchanged)
 * because an offer from a client we did not write must never be able to throw
 * inside the answer path.
 */
export function applyOpusPreferences(sdp: string, config: RemoteAudioConfig): string {
	const payloadTypes = new Set<string>();
	for (const line of sdp.split(/\r?\n/)) {
		const match = /^a=rtpmap:(\d+)\s+opus\//i.exec(line);
		if (match) payloadTypes.add(match[1]);
	}
	if (payloadTypes.size === 0) return sdp;

	const wanted: Record<string, string> = {
		useinbandfec: config.fec ? '1' : '0',
		usedtx: config.dtx ? '1' : '0',
		maxaveragebitrate: String(config.maxAverageBitrate),
		// Mono. The pipeline downmixes to one channel anyway, and asking for stereo
		// doubles the bitrate to carry a duplicate of the same voice.
		stereo: '0',
	};

	const lines = sdp.split(/\r?\n/);
	const seen = new Set<string>();
	const out = lines.map((line) => {
		const match = /^a=fmtp:(\d+)\s+(.*)$/.exec(line);
		if (!match || !payloadTypes.has(match[1])) return line;
		seen.add(match[1]);
		return `a=fmtp:${match[1]} ${mergeFmtp(match[2], wanted)}`;
	});

	// An offer can name Opus without an `fmtp` line at all, in which case the
	// parameters have to be added rather than merged.
	for (const payloadType of payloadTypes) {
		if (seen.has(payloadType)) continue;
		const index = out.findIndex((line) => line.startsWith(`a=rtpmap:${payloadType} `));
		if (index === -1) continue;
		out.splice(index + 1, 0, `a=fmtp:${payloadType} ${formatFmtp(wanted)}`);
	}
	return out.join('\r\n');
}

function mergeFmtp(existing: string, wanted: Record<string, string>): string {
	const params = new Map<string, string>();
	for (const part of existing.split(';')) {
		const [key, value] = part.split('=');
		if (!key?.trim()) continue;
		params.set(key.trim(), (value ?? '').trim());
	}
	for (const [key, value] of Object.entries(wanted)) params.set(key, value);
	return [...params].map(([key, value]) => (value ? `${key}=${value}` : key)).join(';');
}

function formatFmtp(wanted: Record<string, string>): string {
	return Object.entries(wanted)
		.map(([key, value]) => `${key}=${value}`)
		.join(';');
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/**
 * Reduce a `getStats()` report to the four numbers a signal indicator needs.
 *
 * Takes a plain iterable of report objects rather than an `RTCStatsReport` so it
 * can be tested with fixtures, which matters: the shape of these reports is the
 * thing that changes between Chromium versions, and a fixture is the only way to
 * notice.
 */
export function summarizeStats(
	deviceId: string,
	reports: Iterable<Record<string, unknown>>,
	previous?: { bytesReceived: number; at: number },
	/** Now, in the caller's clock. Defaulted so callers keep one line. */
	at: number = performance.now()
): PeerQualityStats & { bytesReceived: number } {
	let rttMs: number | null = null;
	let jitterMs: number | null = null;
	let packetsReceived = 0;
	let packetsLost = 0;
	let bytesReceived = 0;
	let localCandidateId: string | undefined;
	let remoteCandidateId: string | undefined;
	const candidates = new Map<string, string>();

	for (const report of reports) {
		const type = report.type as string | undefined;
		if (type === 'candidate-pair' && (report.selected === true || report.state === 'succeeded')) {
			if (typeof report.currentRoundTripTime === 'number') {
				rttMs = Math.round(report.currentRoundTripTime * 1000);
			}
			if (report.selected === true || localCandidateId === undefined) {
				localCandidateId = report.localCandidateId as string | undefined;
				remoteCandidateId = report.remoteCandidateId as string | undefined;
			}
		} else if (type === 'inbound-rtp' && report.kind === 'audio') {
			if (typeof report.jitter === 'number') jitterMs = Math.round(report.jitter * 1000);
			if (typeof report.packetsReceived === 'number') packetsReceived += report.packetsReceived;
			if (typeof report.packetsLost === 'number') packetsLost += report.packetsLost;
			if (typeof report.bytesReceived === 'number') bytesReceived += report.bytesReceived;
		} else if (type === 'local-candidate' || type === 'remote-candidate') {
			if (typeof report.id === 'string' && typeof report.candidateType === 'string') {
				candidates.set(report.id, report.candidateType);
			}
		}
	}

	const total = packetsReceived + packetsLost;
	const inboundBitrate =
		previous && at > previous.at
			? Math.max(
					0,
					Math.round(((bytesReceived - previous.bytesReceived) * 8000) / (at - previous.at))
				)
			: null;

	return {
		deviceId,
		rttMs,
		jitterMs,
		packetLoss: total > 0 ? packetsLost / total : 0,
		candidateType: worstCandidateType(
			candidates.get(localCandidateId ?? ''),
			candidates.get(remoteCandidateId ?? '')
		),
		inboundBitrate,
		bytesReceived,
	};
}

/** Local `host` + remote `relay` means the media is relayed. The worse end wins. */
export function worstCandidateType(local?: string, remote?: string): DeviceCandidateType {
	const rank: Record<DeviceCandidateType, number> = { unknown: -1, lan: 0, stun: 1, relay: 2 };
	const map = (value?: string): DeviceCandidateType => {
		if (value === 'host') return 'lan';
		if (value === 'srflx' || value === 'prflx') return 'stun';
		if (value === 'relay') return 'relay';
		return 'unknown';
	};
	const a = map(local);
	const b = map(remote);
	if (a === 'unknown' || b === 'unknown') return 'unknown';
	return rank[a] >= rank[b] ? a : b;
}
