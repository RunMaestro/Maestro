/**
 * The browser reference client, wired to the browser.
 *
 * Everything DOM lives here: the WebSocket, the `RTCPeerConnection`, the
 * microphone, the level meter, playback, and the push-to-talk gesture. The
 * protocol itself is in `client.ts` and knows about none of it, which is what
 * lets the conformance suite drive the same code with fakes.
 *
 * Served by the desktop at `/<token>/acappella` and buildable on its own with
 * `npm run dev:web-desktop` (then open `/acappella-client/`). Point it at a
 * desktop by pasting the JSON behind the pairing QR code.
 */

import { DEFAULT_HOLD_THRESHOLD_MS } from '../../shared/acappella/voice-controls';
import type { RosterAgent, VoiceScope } from '../../shared/acappella/protocol';
import {
	ACappellaReferenceClient,
	type ClientState,
	type PairingStore,
	type PairingTarget,
	type SignalingSocket,
	type SignalingSocketHandlers,
	type StoredPairing,
} from './client';
import { appendLog, createTranscript, renderStatus, renderWheel, type StatusElements } from './ui';

/** What the app calls itself in the desktop's approval sheet and device list. */
const CLIENT_NAME = 'Browser reference client';
const CLIENT_PLATFORM = 'browser';

/** Where the pairing is kept. `localStorage` is this platform's Keychain. */
const STORAGE_KEY = 'maestro.acappella.pairing';

/**
 * How loud counts as speech, as a linear RMS.
 *
 * Crude on purpose. A real client runs a VAD; this one exists to prove the
 * ORDER of the barge-in path (duck locally, then send) rather than to be a good
 * speech detector.
 */
const VAD_RMS_THRESHOLD = 0.06;

// ---------------------------------------------------------------------------
// Element lookup
// ---------------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
	const node = document.getElementById(id);
	if (!node) throw new Error(`Missing #${id} in the reference client page.`);
	return node as T;
}

const fields = {
	payload: el<HTMLTextAreaElement>('qr-payload'),
	host: el<HTMLInputElement>('host'),
	port: el<HTMLInputElement>('port'),
	token: el<HTMLInputElement>('token'),
	code: el<HTMLInputElement>('code'),
	secure: el<HTMLInputElement>('secure'),
};
const buttons = {
	connect: el<HTMLButtonElement>('connect'),
	disconnect: el<HTMLButtonElement>('disconnect'),
	forget: el<HTMLButtonElement>('forget'),
	talk: el<HTMLButtonElement>('talk'),
	barge: el<HTMLButtonElement>('barge'),
	stop: el<HTMLButtonElement>('stop'),
};
const status: StatusElements = {
	phase: el('phase'),
	message: el('message'),
	mic: el('mic-pill'),
	floor: el('floor-line'),
	quality: el('quality-line'),
	suspect: el('suspect'),
	version: el('version-line'),
};
const wheel = el('wheel');
const transcriptNode = el('transcript');
const logNode = el('log');
const meter = el('meter-fill');
const playback = el<HTMLAudioElement>('playback');

const transcript = createTranscript(transcriptNode);

// ---------------------------------------------------------------------------
// Seams, implemented for a browser
// ---------------------------------------------------------------------------

const store: PairingStore = {
	read(): StoredPairing | null {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			return raw ? (JSON.parse(raw) as StoredPairing) : null;
		} catch {
			return null;
		}
	},
	write(pairing: StoredPairing): void {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(pairing));
	},
	clear(): void {
		localStorage.removeItem(STORAGE_KEY);
	},
};

function openSocket(url: string, handlers: SignalingSocketHandlers): SignalingSocket {
	const socket = new WebSocket(url);
	socket.onopen = () => handlers.onOpen();
	socket.onclose = () => handlers.onClose();
	socket.onerror = () => appendLog(logNode, 'error', 'The WebSocket reported an error.');
	socket.onmessage = (event) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
		} catch {
			return;
		}
		// The app's ordinary envelope. Anything that is not an A Cappella frame on
		// this socket belongs to some other feature and is not ours to read.
		const frame = parsed as { type?: string; payload?: unknown };
		if (frame.type !== 'acappella_signal' || !frame.payload) return;
		handlers.onMessage(frame.payload as Parameters<SignalingSocketHandlers['onMessage']>[0]);
	};
	return {
		send: (message) => socket.send(JSON.stringify({ type: 'acappella_signal', payload: message })),
		close: () => socket.close(),
	};
}

const client = new ACappellaReferenceClient({
	identity: { name: CLIENT_NAME, platform: CLIENT_PLATFORM, appVersion: __APP_VERSION__ },
	store,
	openSocket,
	createPeerConnection: (config) => new RTCPeerConnection(config),
	openMicrophone: () =>
		navigator.mediaDevices.getUserMedia({
			audio: {
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
			},
		}),
});

// ---------------------------------------------------------------------------
// Level meter and the local VAD
// ---------------------------------------------------------------------------

let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let meterFrame = 0;
let speaking = false;

function startMeter(stream: MediaStream): void {
	stopMeter();
	audioContext = new AudioContext();
	analyser = audioContext.createAnalyser();
	analyser.fftSize = 512;
	audioContext.createMediaStreamSource(stream).connect(analyser);
	const buffer = new Float32Array(analyser.fftSize);

	const tick = (): void => {
		if (!analyser) return;
		analyser.getFloatTimeDomainData(buffer);
		let sum = 0;
		for (const sample of buffer) sum += sample * sample;
		const rms = Math.sqrt(sum / buffer.length);
		meter.style.width = `${Math.min(100, Math.round(rms * 400))}%`;
		const isSpeech = rms > VAD_RMS_THRESHOLD;
		client.reportAudioLevel(rms, isSpeech);
		// Talking over the reply. The duck happens inside `requestBargeIn` before
		// the frame goes out, which is the whole point of doing this locally.
		if (isSpeech && speaking) client.requestBargeIn();
		meterFrame = requestAnimationFrame(tick);
	};
	meterFrame = requestAnimationFrame(tick);
}

function stopMeter(): void {
	if (meterFrame) cancelAnimationFrame(meterFrame);
	meterFrame = 0;
	analyser = null;
	void audioContext?.close();
	audioContext = null;
	meter.style.width = '0%';
}

// ---------------------------------------------------------------------------
// Push to talk
// ---------------------------------------------------------------------------

/**
 * Tap to toggle, or press and hold to release.
 *
 * `press` goes out on pointer-down, before the gesture has been classified,
 * because the desktop's press is idempotent and waiting out the threshold would
 * put it in front of every utterance. Only the RELEASE depends on which gesture
 * this turned out to be. The threshold is the desktop's own
 * `DEFAULT_HOLD_THRESHOLD_MS` rather than a second copy of the number.
 */
let pressedAt = 0;
let latched = false;

buttons.talk.addEventListener('pointerdown', (event) => {
	event.preventDefault();
	buttons.talk.setPointerCapture(event.pointerId);
	if (latched) {
		// A tap while latched is the second half of the toggle.
		latched = false;
		client.releaseFloor();
		pressedAt = 0;
		return;
	}
	pressedAt = performance.now();
	client.pressFloor(selectedScope);
});

buttons.talk.addEventListener('pointerup', () => {
	if (!pressedAt) return;
	const held = performance.now() - pressedAt;
	pressedAt = 0;
	if (held >= DEFAULT_HOLD_THRESHOLD_MS) {
		client.releaseFloor();
		latched = false;
		return;
	}
	// A tap latches the floor open until the next tap.
	latched = true;
	buttons.talk.classList.add('is-latched');
});

buttons.barge.addEventListener('click', () => client.requestBargeIn());
buttons.stop.addEventListener('click', () => {
	latched = false;
	client.requestStop();
});

// ---------------------------------------------------------------------------
// Connection form
// ---------------------------------------------------------------------------

/**
 * Read the JSON behind the desktop's pairing QR code.
 *
 * The desktop encodes `JSON.stringify(PairingPayload)` into the QR, so pasting
 * it is exactly what a camera scan produces. Tolerant of a raw code being typed
 * into the field instead.
 */
export function parsePairingPayload(text: string): Partial<PairingTarget> | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const payload = parsed as {
		kind?: string;
		hosts?: unknown;
		port?: unknown;
		token?: unknown;
		code?: unknown;
	};
	// A scanner has to be able to reject an unrelated QR code, which is the only
	// reason `kind` is in the payload at all.
	if (payload.kind !== 'maestro-acappella') return null;
	const hosts = Array.isArray(payload.hosts) ? payload.hosts.filter(isString) : [];
	return {
		host: hosts[0],
		port: typeof payload.port === 'number' ? payload.port : undefined,
		token: isString(payload.token) ? payload.token : undefined,
		code: isString(payload.code) ? payload.code : undefined,
	};
}

function isString(value: unknown): value is string {
	return typeof value === 'string';
}

fields.payload.addEventListener('input', () => {
	const parsed = parsePairingPayload(fields.payload.value);
	if (!parsed) return;
	if (parsed.host) fields.host.value = parsed.host;
	if (parsed.port) fields.port.value = String(parsed.port);
	if (parsed.token) fields.token.value = parsed.token;
	if (parsed.code) fields.code.value = parsed.code;
	appendLog(logNode, 'info', 'Read the pairing payload. Press Connect.');
});

buttons.connect.addEventListener('click', () => {
	const target: PairingTarget = {
		host: fields.host.value.trim(),
		port: Number(fields.port.value),
		token: fields.token.value.trim(),
		code: fields.code.value.trim() || undefined,
		secure: fields.secure.checked,
	};
	if (!target.host || !target.port || !target.token) {
		appendLog(logNode, 'error', 'Host, port, and token are all required.');
		return;
	}
	transcript.clear();
	client.connect(target);
});

buttons.disconnect.addEventListener('click', () => client.disconnect());
buttons.forget.addEventListener('click', () => client.forget());

// ---------------------------------------------------------------------------
// The wheel
// ---------------------------------------------------------------------------

let agents: RosterAgent[] = [];
let selectedScope: VoiceScope = { kind: 'conductor' };

function paintWheel(): void {
	renderWheel(wheel, agents, selectedScope, (scope) => {
		selectedScope = scope;
		paintWheel();
	});
}
paintWheel();

// ---------------------------------------------------------------------------
// Client events
// ---------------------------------------------------------------------------

let lastState: ClientState | null = null;

client.subscribe((event) => {
	switch (event.type) {
		case 'state': {
			const state = event.state;
			renderStatus(status, state);
			buttons.talk.dataset.self = String(state.floor.isSelf);
			buttons.talk.textContent = state.floor.isSelf ? 'Talking' : 'Hold to talk';
			if (!state.floor.isSelf) buttons.talk.classList.remove('is-latched');
			buttons.disconnect.disabled = state.phase === 'idle';
			// The meter follows the microphone, which follows the floor.
			if (state.sending && !lastState?.sending) {
				const stream = client.microphone;
				if (stream) startMeter(stream);
			}
			if (!state.sending && lastState?.sending) stopMeter();
			lastState = state;
			return;
		}

		case 'voice-event':
			if (event.event.type === 'agent-roster') {
				// A snapshot. Replaced wholesale, never merged.
				agents = event.event.agents;
				paintWheel();
			}
			if (event.event.type === 'speak-start') speaking = true;
			if (event.event.type === 'speak-end') speaking = false;
			transcript.apply(event.event);
			return;

		case 'remote-track':
			playback.srcObject = event.stream;
			void playback.play().catch(() => {
				appendLog(logNode, 'warn', 'Playback needs a click. Press Connect again to allow audio.');
			});
			return;

		case 'duck':
			// One property, applied immediately. A duck is a level change, not a
			// pause: the reply is still being spoken and may be resumed.
			playback.volume = event.ducked ? 0.15 : 1;
			return;

		case 'log':
			appendLog(logNode, event.level, event.text);
			return;
	}
});

// A deliberate teardown on the way out, so the desktop is not left waiting for
// ICE to notice. C-14.
window.addEventListener('beforeunload', () => client.disconnect('the browser page closed'));
