// `maestro-cli voice ...` - the Voice HUD and the Voice settings, verb for verb.
//
// The session verbs (`start`, `stop`, `listen`, `send`, `stop-reply`, `scope`,
// `wait`, `mute`) are the HUD's controls. `status`, `latency`, `self-test`,
// `setup` and `input` are the readouts and pickers of Settings > Voice. Every
// one crosses the WS bridge as one `voice_control` message and ends in the
// function the control calls, so a session started here and one started from
// the header pill are the same session, on the same microphone.
//
// A session a verb starts belongs to the window the user is looking at, which
// is what a global hotkey does: a command line has no window of its own.
//
// Push-to-talk has no "hold" here. `listen on` opens the microphone and `listen
// off --send` shuts it and sends what was said, which is a hold in two verbs.

import {
	formatSendWait,
	MAX_SEND_WAIT_MS,
	MIN_SEND_WAIT_MS,
} from '../../shared/acappella/listen-mode';
import { ACAPPELLA_SYSTEM_DEFAULT_INPUT } from '../../shared/acappella/audio-host';
import type { VoiceScope } from '../../shared/acappella/protocol';
import {
	QUICK_CHAT_VOICE_LABEL,
	QUICK_CHAT_VOICE_SCOPE,
} from '../../shared/acappella/quick-chat-scope';
import { readinessErrorMessage } from '../../shared/acappella/readiness';
import {
	DEFAULT_WAKE_TEST_SECONDS,
	MAX_WAKE_TEST_SECONDS,
	MIN_WAKE_TEST_SECONDS,
	type VoiceSessionView,
	type VoiceStatusResult,
} from '../../shared/acappella/voice-control';
import { voiceSettingProblem } from '../../shared/acappella/voice-settings-schema';
import { DEFAULT_TTS_VOLUME, clampTtsVolume } from '../../shared/acappella/voice-controls';
import { MODEL_SETS, type VoiceModelSetId } from '../../shared/acappella/voice-models';
import { formatSize } from '../../shared/formatters';
import { ExitCode, exitWith } from '../exit-codes';
import { formatSuccess, formatWarning } from '../output/formatter';
import {
	failCommand,
	resolveAgentOrFail,
	resolveTabOwner,
	failFromError,
} from '../services/session-command';
import {
	getSessionById,
	readActiveAgentId,
	readSettingValue,
	writeSettingValue,
} from '../services/storage';
import { sendVoiceControl } from '../services/voice-control';
import { resolveCliPath } from '../utils/parse';
import { downloadModelOverBridge, listModelsOverBridge } from './models-manage';

interface JsonOption {
	json?: boolean;
}

interface ScopeOptions extends JsonOption {
	agent?: string;
	tab?: string;
	conductor?: boolean;
	document?: string;
}

interface StartOptions extends ScopeOptions {
	paused?: boolean;
	quickChat?: boolean;
}

/** The self-test loads each native runtime in a child process, one after another. */
const SELF_TEST_TIMEOUT_MS = 180_000;

/** What to say when a verb needs a live session and there is none. */
const NO_SESSION = 'No voice session is live. Start one with "maestro-cli voice start".';

function printJson(value: Record<string, unknown>): void {
	console.log(JSON.stringify({ success: true, ...value }));
}

function agentLabel(agentId: string): string {
	const name = getSessionById(agentId)?.name;
	return name ? `${name} (${agentId})` : agentId;
}

/** A scope as a person reads it. */
export function describeVoiceScope(scope: VoiceScope | null): string {
	if (!scope) return 'no scope';
	if (scope.kind === 'conductor') return 'the Conductor';
	if (scope.kind === 'quick-chat') return `${QUICK_CHAT_VOICE_LABEL} (locked)`;
	if (scope.kind === 'group-chat') return `group chat ${scope.name || scope.groupChatId}`;
	if (scope.kind === 'document')
		return `document ${scope.path}, with ${agentLabel(scope.sessionId)}`;
	return scope.tabId
		? `tab ${scope.tabId} of ${agentLabel(scope.sessionId)}`
		: `agent ${agentLabel(scope.sessionId)}`;
}

function isLive(session: VoiceSessionView | null): session is VoiceSessionView {
	return !!session && session.state !== 'idle';
}

/** A session as one line. */
export function describeVoiceSession(session: VoiceSessionView | null): string {
	if (!isLive(session)) return 'no session';
	const microphone = session.listenPaused ? 'microphone shut' : 'microphone open';
	const held = session.origin.kind === 'remote' ? `, held by ${session.origin.deviceName}` : '';
	return `${session.state}, talking to ${describeVoiceScope(session.scope)}, ${microphone}${held}`;
}

/** `voice status` as lines a person reads. */
export function formatVoiceStatus(status: VoiceStatusResult): string {
	const lines = [
		`A Cappella: ${status.enabled ? 'on' : 'off'}`,
		`Session: ${describeVoiceSession(status.session)}`,
	];
	if (isLive(status.session)) {
		const { stt, brain, tts } = status.session.providerIds;
		lines.push(`Engines: ${stt} / ${brain} / ${tts}`);
	}
	const wait = `${formatSendWait(status.sendWait.waitMs)}${status.sendWait.overridden ? ` (default ${formatSendWait(status.sendWait.defaultMs)})` : ''}`;
	const phrases = status.sendWait.sendPhrases.length
		? `, or say: ${status.sendWait.sendPhrases.join(', ')}`
		: '';
	lines.push(`Send wait: ${wait}${phrases}`);
	if (status.readiness) {
		lines.push(
			status.readiness.canStartSession
				? 'Ready: a session can start'
				: `Not ready: ${readinessErrorMessage(status.readiness)}`
		);
		lines.push(
			`Hands-free: ${status.readiness.canRunHandsFree ? 'the wake word can run' : 'the wake word cannot run'}`
		);
		for (const slot of status.readiness.slots) {
			const state = slot.satisfied
				? 'ok'
				: [slot.detail, slot.suggestedAction].filter(Boolean).join(' ');
			lines.push(`  ${slot.slot}: ${slot.providerId} (${state})`);
		}
	}
	return lines.join('\n');
}

/** Read the scope flags of `voice start` into the scope the HUD would bind. */
async function resolveScope(options: StartOptions): Promise<VoiceScope> {
	const named = [options.agent, options.tab, options.document].some((flag) => flag !== undefined);
	if (options.quickChat) {
		// Quick Chat picks its own agent and tab, so naming one here would be a
		// flag the session ignores.
		if (named || options.conductor) {
			failCommand(
				'--quick-chat cannot be combined with --agent, --tab, --document or --conductor. Pick the agent with "maestro-cli quick-chat agent <id>".',
				options.json,
				ExitCode.InvalidUsage
			);
		}
		return { ...QUICK_CHAT_VOICE_SCOPE };
	}
	if (options.conductor) {
		if (named) {
			failCommand(
				'--conductor cannot be combined with --agent, --tab or --document.',
				options.json,
				ExitCode.InvalidUsage
			);
		}
		return { kind: 'conductor' };
	}
	if (options.document !== undefined) {
		if (!options.agent || options.tab !== undefined) {
			failCommand(
				'--document needs --agent <id> (the agent the document is discussed with) and no --tab.',
				options.json,
				ExitCode.InvalidUsage
			);
		}
		return {
			kind: 'document',
			sessionId: resolveAgentOrFail(options.agent, options.json),
			path: resolveCliPath(options.document),
		};
	}
	if (options.tab !== undefined) {
		try {
			const owner = await resolveTabOwner(options.tab, options.agent);
			return { kind: 'agent', sessionId: owner.agentId, tabId: owner.tabId };
		} catch (error) {
			failFromError(error, options.json);
		}
	}
	if (options.agent !== undefined) {
		return { kind: 'agent', sessionId: resolveAgentOrFail(options.agent, options.json) };
	}
	return { kind: 'conductor' };
}

/** `voice status` - whether voice is on, the live session, and what blocks one. */
export async function voiceStatus(options: JsonOption): Promise<void> {
	const status = await sendVoiceControl({ action: 'status' }, options.json);
	if (options.json) printJson({ ...status });
	else console.log(formatVoiceStatus(status));
}

/** `voice start` - open a session on the Conductor, an agent, a tab, a document, or Quick Chat. */
export async function voiceStart(options: StartOptions): Promise<void> {
	const scope = await resolveScope(options);
	const result = await sendVoiceControl(
		{ action: 'start', scope, paused: options.paused === true },
		options.json
	);
	if (options.json) {
		printJson({ ...result });
		return;
	}
	console.log(formatSuccess(`Voice session started: ${describeVoiceSession(result.session)}`));
	for (const substitution of result.substitutions) {
		console.log(formatWarning(substitution.message));
	}
}

/** `voice stop` - end the session and close the microphone. */
export async function voiceStop(options: JsonOption): Promise<void> {
	const result = await sendVoiceControl({ action: 'stop' }, options.json);
	if (options.json) printJson({ ...result });
	else console.log(formatSuccess('Voice session ended.'));
}

/** `voice listen <on|off> [--send]` - open or shut the microphone, keeping the session. */
export async function voiceListen(
	state: string,
	options: JsonOption & { send?: boolean }
): Promise<void> {
	const word = state.trim().toLowerCase();
	if (word !== 'on' && word !== 'off') {
		failCommand(`listen expects on or off, got "${state}"`, options.json, ExitCode.InvalidUsage);
	}
	const listening = word === 'on';
	if (listening && options.send) {
		failCommand('--send goes with "listen off".', options.json, ExitCode.InvalidUsage);
	}
	const result = await sendVoiceControl(
		{ action: 'listen', listening, send: options.send === true },
		options.json
	);
	if (!result.applied) failCommand(NO_SESSION, options.json);
	if (options.json) printJson({ ...result });
	else if (listening) console.log(formatSuccess('The microphone is open.'));
	else {
		console.log(
			formatSuccess(
				options.send
					? 'The microphone is shut and what was said was sent.'
					: 'The microphone is shut.'
			)
		);
	}
}

/** `voice send` - send what was said now, without waiting out the pause. */
export async function voiceSend(options: JsonOption): Promise<void> {
	const result = await sendVoiceControl({ action: 'send' }, options.json);
	if (!isLive(result.session)) failCommand(NO_SESSION, options.json);
	if (options.json) printJson({ ...result });
	else console.log(formatSuccess('Sent what was said.'));
}

/** `voice stop-reply` - cut off the spoken reply and keep the session. */
export async function voiceStopReply(options: JsonOption): Promise<void> {
	const result = await sendVoiceControl({ action: 'stop-reply' }, options.json);
	if (options.json) printJson({ ...result });
	else
		console.log(
			result.interrupted ? formatSuccess('Stopped the reply.') : 'Nothing was being spoken.'
		);
}

/** `voice scope <conductor|agent|tab>` - the HUD's Tab / Agent / Conductor switch. */
export async function voiceScope(mode: string, options: ScopeOptions): Promise<void> {
	const word = mode.trim().toLowerCase();
	let scope: VoiceScope;
	if (word === 'conductor') {
		scope = { kind: 'conductor' };
	} else if (word === 'agent') {
		const agentId = options.agent
			? resolveAgentOrFail(options.agent, options.json)
			: readActiveAgentId();
		if (!agentId) {
			failCommand(
				'No active agent recorded. Pass --agent <id> to say which agent.',
				options.json,
				ExitCode.InvalidUsage
			);
		}
		scope = { kind: 'agent', sessionId: agentId };
	} else if (word === 'tab') {
		try {
			const owner = await resolveTabOwner(options.tab ?? 'active', options.agent);
			scope = { kind: 'agent', sessionId: owner.agentId, tabId: owner.tabId };
		} catch (error) {
			failFromError(error, options.json);
		}
	} else {
		failCommand(
			`scope expects conductor, agent or tab, got "${mode}"`,
			options.json,
			ExitCode.InvalidUsage
		);
	}
	const result = await sendVoiceControl({ action: 'scope', scope }, options.json);
	if (!result.applied) failCommand(NO_SESSION, options.json);
	if (options.json) printJson({ ...result });
	else console.log(formatSuccess(`Now talking to ${describeVoiceScope(result.scope)}.`));
}

/** `voice wait [<ms>|default]` - how long a pause sends a request, for this conversation. */
export async function voiceWait(value: string | undefined, options: JsonOption): Promise<void> {
	if (value === undefined) {
		const { sendWait } = await sendVoiceControl({ action: 'status' }, options.json);
		if (options.json) printJson({ ...sendWait });
		else {
			console.log(
				`${formatSendWait(sendWait.waitMs)}${sendWait.overridden ? ` (default ${formatSendWait(sendWait.defaultMs)})` : ' (the default)'}`
			);
		}
		return;
	}
	let waitMs: number | null = null;
	if (value.trim().toLowerCase() !== 'default') {
		waitMs = Number(value);
		if (!Number.isFinite(waitMs) || waitMs < MIN_SEND_WAIT_MS || waitMs > MAX_SEND_WAIT_MS) {
			failCommand(
				`wait expects milliseconds from ${MIN_SEND_WAIT_MS} to ${MAX_SEND_WAIT_MS}, or "default". Got "${value}".`,
				options.json,
				ExitCode.InvalidUsage
			);
		}
	}
	const sendWait = await sendVoiceControl({ action: 'wait', waitMs }, options.json);
	if (options.json) printJson({ ...sendWait });
	else {
		console.log(
			formatSuccess(
				sendWait.overridden
					? `A pause of ${formatSendWait(sendWait.waitMs)} sends a request, until the session's HUD is closed.`
					: `Back to the default: a pause of ${formatSendWait(sendWait.waitMs)} sends a request.`
			)
		);
	}
}

/** Apply a volume to what is playing and report it. Shared by `volume`, `mute` and `unmute`. */
async function applyVolume(
	volume: number,
	options: JsonOption,
	extra: Record<string, unknown>,
	message: string
): Promise<void> {
	const result = await sendVoiceControl({ action: 'volume', volume }, options.json);
	if (options.json) {
		printJson({ ...result, ...extra });
		return;
	}
	console.log(formatSuccess(message));
	if (!result.applied) console.log('  Nothing is playing now; it applies to the next reply.');
}

/** `voice volume <0.1-1>` - the Settings volume slider: saved, and applied to what is playing. */
export async function voiceVolume(value: string, options: JsonOption): Promise<void> {
	const volume = Number(value);
	const problem = voiceSettingProblem('voice.volume', volume);
	if (problem) failCommand(problem, options.json, ExitCode.InvalidUsage);
	writeSettingValue('acappella.voice.volume', volume);
	await applyVolume(volume, options, { saved: true }, `Voice volume is ${volume}.`);
}

/** `voice mute` - silence the spoken reply for now. Not saved, like the HUD's mute button. */
export async function voiceMute(options: JsonOption): Promise<void> {
	await applyVolume(
		0,
		options,
		{ muted: true },
		'Voice is muted until "maestro-cli voice unmute".'
	);
}

/** `voice unmute` - return to the saved volume. */
export async function voiceUnmute(options: JsonOption): Promise<void> {
	const stored = readSettingValue('acappella.voice.volume');
	const volume = stored === undefined ? DEFAULT_TTS_VOLUME : clampTtsVolume(stored);
	await applyVolume(volume, options, { muted: false }, `Voice is back at volume ${volume}.`);
}

/** `voice input list` - the microphones the app has seen, and the one selected. */
export async function voiceInputList(options: JsonOption): Promise<void> {
	const result = await sendVoiceControl({ action: 'inputs' }, options.json);
	if (options.json) {
		printJson({ ...result });
		return;
	}
	const isDefault = result.selectedId === ACAPPELLA_SYSTEM_DEFAULT_INPUT;
	console.log(`${isDefault ? '*' : ' '} default  (follows the system default)`);
	for (const device of result.devices) {
		const mark = device.deviceId === result.selectedId ? '*' : ' ';
		console.log(`${mark} ${device.deviceId}  ${device.label || '(no name yet)'}`);
	}
	if (result.devices.length === 0) {
		console.log(
			'No microphones are listed yet: the app learns them the first time a voice session opens the microphone.'
		);
	}
}

/** `voice input set <device-id|default>` - choose the microphone, from the next capture on. */
export async function voiceInputSet(deviceId: string, options: JsonOption): Promise<void> {
	const wanted = deviceId.trim();
	const isDefault = wanted.toLowerCase() === 'default' || wanted === ACAPPELLA_SYSTEM_DEFAULT_INPUT;
	if (!isDefault) {
		const { devices } = await sendVoiceControl({ action: 'inputs' }, options.json);
		if (!devices.some((device) => device.deviceId === wanted)) {
			failCommand(
				`No microphone has the id "${wanted}". See "maestro-cli voice input list".`,
				options.json,
				ExitCode.InvalidUsage
			);
		}
	}
	const result = await sendVoiceControl(
		{ action: 'set-input', deviceId: isDefault ? ACAPPELLA_SYSTEM_DEFAULT_INPUT : wanted },
		options.json
	);
	if (options.json) printJson({ ...result });
	else {
		console.log(
			formatSuccess(
				isDefault
					? 'Voice follows the system default microphone.'
					: `Voice uses microphone ${result.selectedId}, from the next capture on.`
			)
		);
	}
}

/** `voice latency` - where the time went in the last finished turn. */
export async function voiceLatency(options: JsonOption): Promise<void> {
	const result = await sendVoiceControl({ action: 'latency' }, options.json);
	if (options.json) printJson({ turn: result.turn });
	else console.log(result.text ?? 'No voice turn has finished since Maestro started.');
}

/** `voice self-test` - load each native runtime and read the microphone permission. */
export async function voiceSelfTest(options: JsonOption): Promise<void> {
	const result = await sendVoiceControl(
		{ action: 'self-test' },
		options.json,
		SELF_TEST_TIMEOUT_MS
	);
	if (options.json) printJson({ report: result.report });
	else console.log(result.text);
}

/** The bundle Voice Setup offers. One set today; named so a second cannot be assumed. */
const SETUP_SET: VoiceModelSetId = 'hands-free-local';

/**
 * `voice setup [--download]` - the Voice Setup dialog.
 *
 * Without `--download` it reads what the bundle is and what is on disk, and
 * fetches nothing: the dialog downloads only when its button is pressed, and
 * `--download` is that button.
 */
export async function voiceSetup(options: JsonOption & { download?: boolean }): Promise<void> {
	const set = MODEL_SETS[SETUP_SET];
	const wanted = new Set(set.modelIds);
	const read = async () =>
		(await listModelsOverBridge(options.json)).filter((listing) => wanted.has(listing.entry.id));

	let listings = await read();
	const failures: Array<{ modelId: string; error: string }> = [];
	if (options.download) {
		for (const listing of listings) {
			if (listing.status.status === 'installed') continue;
			if (!options.json) {
				console.log(
					`Downloading ${listing.entry.displayName} (${formatSize(listing.entry.bytes)})...`
				);
			}
			const outcome = await downloadModelOverBridge(listing.entry.id, options.json);
			if (outcome.status !== 'complete') {
				failures.push({
					modelId: listing.entry.id,
					error: outcome.error ?? `the download was ${outcome.status}`,
				});
			} else if (
				outcome.runtime?.status === 'failed' ||
				outcome.runtime?.status === 'unavailable'
			) {
				failures.push({
					modelId: listing.entry.id,
					error: `its engine (${outcome.runtime.runtimeId}) is ${outcome.runtime.status}${outcome.runtime.error ? `: ${outcome.runtime.error}` : ''}`,
				});
			}
		}
		listings = await read();
	}

	const models = listings.map((listing) => ({
		modelId: listing.entry.id,
		name: listing.entry.displayName,
		bytes: listing.entry.bytes,
		status: listing.status.status,
	}));
	const ready =
		models.length === wanted.size && models.every((model) => model.status === 'installed');
	if (options.json) {
		console.log(
			JSON.stringify({
				success: failures.length === 0,
				set: set.id,
				bytes: set.bytes,
				ready,
				models,
				...(failures.length ? { failures } : {}),
			})
		);
	} else {
		console.log(`${set.displayName} (${formatSize(set.bytes)}): ${set.description}`);
		for (const model of models) {
			console.log(
				`  ${model.status === 'installed' ? 'installed' : model.status}  ${model.name} (${formatSize(model.bytes)})`
			);
		}
		for (const failure of failures) {
			console.error(formatWarning(`${failure.modelId}: ${failure.error}`));
		}
		if (ready) console.log(formatSuccess('Voice has the models it needs.'));
		else if (!options.download) {
			console.log('Run "maestro-cli voice setup --download" to fetch what is missing.');
		}
	}
	if (failures.length > 0) exitWith(ExitCode.GeneralError);
}

/** `voice wake test [phrase]` - run the wake word alone and count how often it fired. */
export async function voiceWakeTest(
	phrase: string | undefined,
	options: JsonOption & { seconds?: string; sensitivity?: string }
): Promise<void> {
	let seconds = DEFAULT_WAKE_TEST_SECONDS;
	if (options.seconds !== undefined) {
		seconds = Number(options.seconds);
		if (
			!Number.isFinite(seconds) ||
			seconds < MIN_WAKE_TEST_SECONDS ||
			seconds > MAX_WAKE_TEST_SECONDS
		) {
			failCommand(
				`--seconds expects ${MIN_WAKE_TEST_SECONDS} to ${MAX_WAKE_TEST_SECONDS}, got "${options.seconds}"`,
				options.json,
				ExitCode.InvalidUsage
			);
		}
	}
	let sensitivity: number | undefined;
	if (options.sensitivity !== undefined) {
		sensitivity = Number(options.sensitivity);
		const problem = voiceSettingProblem('controls.wakeSensitivity', sensitivity);
		if (problem) {
			failCommand(
				`--sensitivity expects a number from 0 to 1, got "${options.sensitivity}"`,
				options.json,
				ExitCode.InvalidUsage
			);
		}
	}
	if (!options.json) {
		console.log(`Listening for ${seconds} s. Say the phrase now.`);
	}
	const result = await sendVoiceControl(
		{
			action: 'wake-test',
			seconds,
			...(phrase?.trim() ? { phrase: phrase.trim() } : {}),
			...(sensitivity !== undefined ? { sensitivity } : {}),
		},
		options.json,
		// The app answers when the run ends, so the wait is the run plus a margin.
		seconds * 1000 + 30_000
	);
	if (options.json) {
		printJson({ ...result });
		return;
	}
	const heard = result.phrase ? `"${result.phrase}"` : 'The wake phrase';
	if (result.hits.length === 0) {
		console.log(`${heard} did not fire in ${result.seconds} s.`);
		return;
	}
	const best = Math.max(...result.hits.map((hit) => hit.score));
	console.log(
		formatSuccess(
			`${heard} fired ${result.hits.length} time${result.hits.length === 1 ? '' : 's'} in ${result.seconds} s (best score ${best.toFixed(2)}).`
		)
	);
}
