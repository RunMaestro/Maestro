/**
 * The reference client's screen: a project wheel, a talk button, a transcript,
 * and a status strip.
 *
 * Plain DOM on purpose. The main renderer is React with a theme system, stores,
 * and several hundred components, and none of that would help a Swift developer
 * work out what a `route-correction` does to a row. Everything here is one
 * function per surface, in the order the events arrive.
 *
 * The one rule this file exists to demonstrate: **the button is drawn from
 * `floor-state`, never from the gesture.** The gesture asks; the desktop
 * answers; the answer is what paints.
 */

import type { RosterAgent, VoiceEvent, VoiceScope } from '../../shared/acappella/protocol';
import type { ClientState } from './client';

/** One line of conversation, as the transcript holds it. */
interface TranscriptRow {
	id: string;
	kind: 'user' | 'assistant' | 'system';
	text: string;
	/** The routing caption under a user row. Rewritten in place, never appended. */
	caption?: string;
	pending?: boolean;
	element: HTMLElement;
}

export interface TranscriptHandle {
	apply(event: VoiceEvent): void;
	clear(): void;
}

// ---------------------------------------------------------------------------
// Project wheel
// ---------------------------------------------------------------------------

/**
 * Draw the roster.
 *
 * `agent-roster` is a snapshot and this replaces the wheel wholesale. Merging
 * would accumulate agents the desktop has already closed, which is how a phone
 * ends up offering to talk to something that no longer exists. C-24.
 */
export function renderWheel(
	container: HTMLElement,
	agents: RosterAgent[],
	selected: VoiceScope,
	onSelect: (scope: VoiceScope) => void
): void {
	container.replaceChildren();
	const entries: Array<{ scope: VoiceScope; name: string; detail: string }> = [
		{
			scope: { kind: 'conductor' },
			name: 'Conductor',
			detail: 'Routed by what you say',
		},
		...agents.map((agent) => ({
			scope: { kind: 'agent' as const, sessionId: agent.sessionId },
			name: agent.name,
			detail: agent.recentWork || `${agent.tabs.length} tab${agent.tabs.length === 1 ? '' : 's'}`,
		})),
	];

	for (const entry of entries) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'wheel-item';
		button.setAttribute('aria-pressed', String(sameScope(entry.scope, selected)));
		if (sameScope(entry.scope, selected)) button.classList.add('is-selected');
		const name = document.createElement('span');
		name.className = 'wheel-name';
		name.textContent = entry.name;
		const detail = document.createElement('span');
		detail.className = 'wheel-detail';
		detail.textContent = entry.detail;
		button.append(name, detail);
		button.addEventListener('click', () => onSelect(entry.scope));
		container.append(button);
	}
}

export function sameScope(a: VoiceScope, b: VoiceScope): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === 'document' && b.kind === 'document') {
		// Two document scopes on the same agent are still different conversations
		// when they are about different files, so the path is part of the identity.
		return a.sessionId === b.sessionId && a.path === b.path;
	}
	return a.kind === 'agent' && b.kind === 'agent' ? a.sessionId === b.sessionId : true;
}

// ---------------------------------------------------------------------------
// Status strip
// ---------------------------------------------------------------------------

/**
 * What the microphone is doing, in the client's own words.
 *
 * Three states, not two, and the reason is the same one that gives the iOS pill
 * three: the browser lights its recording indicator for any open microphone, so
 * a client that only says "on" or "off" is describing something other than what
 * the user can see. C-50.
 */
export function micPillText(state: ClientState): string {
	if (state.sending) return 'Sending';
	if (state.phase === 'connected') return 'Mic off';
	return 'Not connected';
}

export function renderStatus(elements: StatusElements, state: ClientState): void {
	elements.phase.textContent = state.phase;
	elements.phase.dataset.phase = state.phase;
	elements.message.textContent = state.message;
	elements.mic.textContent = micPillText(state);
	elements.mic.dataset.on = String(state.sending);

	const holder = state.floor.isSelf
		? 'You hold the floor'
		: state.floor.holder === 'local'
			? 'The desktop holds the floor'
			: state.floor.holder
				? `${state.floor.takenOverBy ?? 'Another device'} holds the floor`
				: 'Nobody holds the floor';
	elements.floor.textContent = holder;

	elements.quality.textContent = state.quality
		? `${state.quality.candidateType}` +
			(state.quality.rttMs === null ? '' : ` - ${state.quality.rttMs} ms`) +
			` - ${(state.quality.packetLoss * 100).toFixed(1)}% loss`
		: 'no link stats yet';

	elements.suspect.hidden = !state.transcriptSuspect;
	elements.version.textContent = `protocol v${state.protocolVersion}${
		state.desktopVersion ? ` - desktop ${state.desktopVersion}` : ''
	}`;
}

export interface StatusElements {
	phase: HTMLElement;
	message: HTMLElement;
	mic: HTMLElement;
	floor: HTMLElement;
	quality: HTMLElement;
	suspect: HTMLElement;
	version: HTMLElement;
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

/**
 * The transcript, driven straight off the session-event catalogue.
 *
 * Two behaviours here are the ones a first client usually gets wrong, so they
 * are written plainly:
 *
 *   - a `partial-transcript` REPLACES the in-flight user row rather than
 *     appending, because `text` is the whole hypothesis rather than a delta;
 *   - a `route-correction` REWRITES the caption of the row it corrects. The user
 *     said one sentence, so there is one row. Appending a second is how a
 *     transcript starts disagreeing with the conversation. C-25.
 */
export function createTranscript(container: HTMLElement): TranscriptHandle {
	let rows: TranscriptRow[] = [];
	/** The utterance whose sentences are currently being spoken. */
	let speakingUtteranceId: string | null = null;

	function addRow(kind: TranscriptRow['kind'], text: string, pending = false): TranscriptRow {
		const element = document.createElement('div');
		element.className = `row row-${kind}`;
		const body = document.createElement('div');
		body.className = 'row-text';
		body.textContent = text;
		element.append(body);
		container.append(element);
		container.scrollTop = container.scrollHeight;
		const row: TranscriptRow = { id: `${kind}-${rows.length}`, kind, text, pending, element };
		rows.push(row);
		return row;
	}

	function setText(row: TranscriptRow, text: string): void {
		row.text = text;
		const body = row.element.querySelector('.row-text');
		if (body) body.textContent = text;
	}

	function setCaption(row: TranscriptRow, caption: string): void {
		row.caption = caption;
		let node = row.element.querySelector<HTMLElement>('.row-caption');
		if (!node) {
			node = document.createElement('div');
			node.className = 'row-caption';
			row.element.append(node);
		}
		node.textContent = caption;
	}

	function pendingRow(kind: TranscriptRow['kind']): TranscriptRow | undefined {
		return [...rows].reverse().find((row) => row.kind === kind && row.pending);
	}

	function lastRow(kind: TranscriptRow['kind']): TranscriptRow | undefined {
		return [...rows].reverse().find((row) => row.kind === kind);
	}

	return {
		clear(): void {
			rows = [];
			speakingUtteranceId = null;
			container.replaceChildren();
		},

		apply(event: VoiceEvent): void {
			switch (event.type) {
				case 'listen-start':
					addRow('system', `Listening (${event.sttProviderId}).`);
					return;

				case 'partial-transcript': {
					const row = pendingRow('user') ?? addRow('user', '', true);
					setText(row, event.text);
					return;
				}

				case 'final-transcript': {
					const row = pendingRow('user') ?? addRow('user', '', true);
					setText(row, event.text);
					row.pending = false;
					row.element.classList.remove('is-pending');
					return;
				}

				case 'route-decision': {
					const row = lastRow('user');
					if (row) {
						setCaption(row, `Routing (${event.brainProviderId}, ${event.latencyMs} ms)`);
					}
					return;
				}

				case 'dispatch': {
					const row = lastRow('user');
					if (row) {
						setCaption(
							row,
							`${event.action} ${event.agentName} / ${event.tabName ?? event.tabId}` +
								(event.promptSent ? '' : ' (prompt not sent)')
						);
					}
					return;
				}

				case 'route-correction': {
					// In place. One sentence, one row.
					const row = lastRow('user');
					if (row) {
						setCaption(
							row,
							`corrected to ${event.agentName} / ${event.tabName ?? event.tabId}` +
								(event.promptSent ? '' : ' (prompt not sent)')
						);
					}
					return;
				}

				case 'agent-reply':
					addRow('assistant', event.text, true);
					return;

				case 'speak-start':
					speakingUtteranceId = event.utteranceId;
					addRow(
						'system',
						`Speaking ${event.sentenceCount}${event.streaming ? '+' : ''} sentence(s) via ${
							event.ttsProviderId
						}.`
					);
					return;

				case 'speak-sentence': {
					// A sentence from a cancelled run arriving late is dropped, and the
					// index is never clamped to `sentenceCount`: while `streaming` is true
					// that count is a lower bound. C-26, C-27.
					if (event.utteranceId !== speakingUtteranceId) return;
					const row = pendingRow('assistant') ?? addRow('assistant', '', true);
					setCaption(row, `sentence ${event.index + 1}`);
					return;
				}

				case 'speak-end': {
					speakingUtteranceId = null;
					const row = pendingRow('assistant');
					if (row) {
						row.pending = false;
						setCaption(row, `spoken: ${event.reason}`);
					}
					return;
				}

				case 'barge-in':
					addRow('system', `Interrupted (${event.source}). The floor is kept.`);
					return;

				case 'stop-word':
					addRow('system', `Stopped${event.phrase ? ` on "${event.phrase}"` : ''}.`);
					return;

				case 'session-error':
					// The message is written for a human and is shown as written.
					addRow('system', `${event.code}: ${event.message}`);
					return;

				case 'provider-state':
					// Verbatim, wherever the app answers "where does my audio go". C-30.
					addRow('system', event.egressStatement);
					return;

				default:
					// Every other event either updates a surface other than the
					// transcript or is deliberately not shown. An unrecognised type lands
					// here too, and doing nothing with it is the correct behaviour. C-23.
					return;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

export function appendLog(container: HTMLElement, level: string, text: string): void {
	const line = document.createElement('div');
	line.className = `log-line log-${level}`;
	line.textContent = text;
	container.append(line);
	while (container.childElementCount > 200) container.firstElementChild?.remove();
	container.scrollTop = container.scrollHeight;
}
