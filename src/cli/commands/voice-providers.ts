// `maestro-cli voice providers|voices|credentials|wake-phrase ...` - the Voice
// Providers, Voice Output and Voice Controls panels of Settings.
//
// A provider, a voice and a wake phrase are fields of the one `acappella`
// settings object. These verbs write that object in the settings file, the way
// `models assign` writes its setting: it works with Maestro closed, and the
// settings watcher reloads every window. Each value is checked against the
// table the panels' own bounds come from (`voice-settings-schema.ts`), so a
// verb cannot store what a panel would refuse.
//
// A provider or a voice then has to reach the running pipeline, which is the
// second thing the panel does after it saves: it asks the app to apply. The
// same request is sent here, and the app's answer is reported as it is. A swap
// refused because a turn is in flight is not a failure of the write: the
// setting is saved and takes effect when the turn ends.
//
// A key never touches the settings file. `credentials set` reads it from
// standard input and hands it to the app, which files it in the OS keychain.

import {
	LOCAL_PROVIDER_IDS,
	VOICE_CREDENTIAL_SERVICES,
	credentialLabel,
	getVoiceProvider,
	voiceProvidersForRole,
	type VoiceCredentialService,
	type VoiceProviderDescriptor,
} from '../../shared/acappella/provider-catalog';
import type { VoiceProviderRole } from '../../shared/acappella/providers';
import {
	VOICE_ROUTING_TASK_ID,
	effectiveBrainProviderId,
	isVoiceRoutingOnSystemOne,
	resolveVoiceBrainSource,
} from '../../shared/acappella/voice-routing';
import {
	VOICE_PROVIDER_SLOTS,
	isVoiceProviderSlot,
	readAgentWakePhrases,
	voiceSettingProblem,
	withAgentWakePhrase,
	type VoiceProviderSlot,
} from '../../shared/acappella/voice-settings-schema';
import type { VoiceControlResults } from '../../shared/acappella/voice-control';
import { OFF_ASSIGNMENT, withLocalModelAssignment } from '../../shared/local-models/tasks';
import { ExitCode, exitWith } from '../exit-codes';
import { formatSuccess, formatWarning } from '../output/formatter';
import { failCommand, resolveAgentOrFail } from '../services/session-command';
import { isStdinTerminal, readStdinText } from '../services/stdin';
import {
	getSessionById,
	readLocalModelAssignments,
	readLocalModelEndpoints,
	readSettingValue,
	writeLocalModelAssignments,
	writeSettingValue,
} from '../services/storage';
import { sendVoiceControl, tryVoiceControl } from '../services/voice-control';

interface JsonOption {
	json?: boolean;
}

/** The word `providers set` takes for the pipeline shape, beside the four slots. */
const PIPELINE_SLOT = 'pipeline';

function printJson(value: Record<string, unknown>): void {
	console.log(JSON.stringify({ success: true, ...value }));
}

function asId(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** What `apply-providers` came back with, in the words a caller needs. */
type ApplyReport =
	| { applied: VoiceControlResults['apply-providers']['status']; reason?: string }
	| { applied: null; reason: string };

/**
 * Ask the running app to pick a saved change up, as the panel does after it
 * saves. Maestro being closed is not an error: the file is the setting.
 */
async function applyToRunningApp(): Promise<ApplyReport> {
	const attempt = await tryVoiceControl({ action: 'apply-providers' });
	if (attempt.kind === 'done') {
		return {
			applied: attempt.result.status,
			...(attempt.result.reason ? { reason: attempt.result.reason } : {}),
		};
	}
	return { applied: null, reason: attempt.reason };
}

function printApplyReport(report: ApplyReport): void {
	if (report.applied === 'swapped') console.log('  The running app switched to it.');
	else if (report.applied === 'refused') {
		console.log(formatWarning(`Saved. Not applied yet: ${report.reason ?? 'a turn is in flight'}`));
	} else if (report.applied === null) {
		console.log(
			`  Saved. The running app was not told (${report.reason}); it applies at the next start.`
		);
	}
}

function describeProvider(provider: VoiceProviderDescriptor): string {
	const needs =
		provider.requires.kind === 'api-key'
			? `, needs the ${credentialLabel(provider.requires.service)} key`
			: provider.requires.kind === 'model'
				? `, needs the model ${provider.requires.modelId}`
				: '';
	return `${provider.id} (${provider.tier}${needs})`;
}

/** The slots as the Voice Providers panel shows them: what each runs, and what it could. */
function readProviderSelection() {
	const providers = (readSettingValue('acappella.providers') ?? {}) as Record<string, unknown>;
	const brainSource = resolveVoiceBrainSource(
		readSettingValue('localModelAssignments'),
		readLocalModelEndpoints()
	);
	const roles: VoiceProviderRole[] = ['stt', 'tts', 'brain'];
	const slots = roles.map((slot) => {
		const stored = asId(providers[slot]);
		const selected =
			slot === 'brain'
				? (effectiveBrainProviderId(brainSource, stored) ?? LOCAL_PROVIDER_IDS.brain)
				: (stored ?? LOCAL_PROVIDER_IDS[slot]);
		return {
			slot,
			providerId: selected,
			label: getVoiceProvider(selected)?.label ?? selected,
			// Whether the id is a stored choice or the default an unset slot reads as.
			stored: stored !== undefined,
			options: voiceProvidersForRole(slot).map((provider) => ({
				id: provider.id,
				label: provider.label,
				tier: provider.tier,
			})),
		};
	});
	return {
		pipeline: readSettingValue('acappella.pipeline') === 'realtime' ? 'realtime' : 'cascade',
		realtime: asId(providers.realtime) ?? null,
		slots,
		brainSource: brainSource ? { spec: brainSource.spec, label: brainSource.label } : null,
		routedBySystemOne: isVoiceRoutingOnSystemOne(readSettingValue('localModelAssignments')),
	};
}

/** `voice providers list` - what each slot runs and what it could run. */
export function voiceProvidersList(options: JsonOption): void {
	const selection = readProviderSelection();
	if (options.json) {
		printJson({ ...selection });
		return;
	}
	console.log(`Pipeline: ${selection.pipeline}`);
	for (const slot of selection.slots) {
		console.log(
			`${slot.slot}: ${slot.providerId}  ${slot.label}${slot.stored ? '' : '  (default)'}`
		);
		if (slot.slot === 'brain' && selection.brainSource) {
			console.log(
				`  Runs on ${selection.brainSource.label}, the Voice routing assignment (${selection.brainSource.spec}).`
			);
		}
		if (slot.slot === 'brain' && selection.routedBySystemOne) {
			console.log('  System One decides which agent a request is for; this Brain only speaks.');
		}
		console.log(`  Options: ${voiceProvidersForRole(slot.slot).map(describeProvider).join(', ')}`);
	}
	const realtime = voiceProvidersForRole('realtime');
	if (realtime.length > 0) {
		console.log(
			`realtime: ${selection.realtime ?? '(unset)'}\n  Options: ${realtime.map(describeProvider).join(', ')}`
		);
	}
}

/** `voice providers set <slot> <id>` - pick what a slot runs, then tell the running app. */
export async function voiceProvidersSet(
	slot: string,
	providerId: string,
	options: JsonOption
): Promise<void> {
	const wantedSlot = slot.trim().toLowerCase();
	const value = providerId.trim();
	if (wantedSlot !== PIPELINE_SLOT && !isVoiceProviderSlot(wantedSlot)) {
		failCommand(
			`Unknown slot "${slot}". Slots: ${[...VOICE_PROVIDER_SLOTS, PIPELINE_SLOT].join(', ')}.`,
			options.json,
			ExitCode.InvalidUsage
		);
	}
	const path = wantedSlot === PIPELINE_SLOT ? PIPELINE_SLOT : `providers.${wantedSlot}`;
	const problem = voiceSettingProblem(path, value);
	if (problem) failCommand(problem, options.json, ExitCode.InvalidUsage);

	// A model assigned to Voice routing fills the Brain slot and would keep
	// deciding it. Picking a Brain here switches that assignment off first, as
	// the panel's picker does. A System One assignment fills no slot and stays.
	let clearedAssignment: string | null = null;
	if ((wantedSlot as VoiceProviderSlot) === 'brain') {
		const brainSource = resolveVoiceBrainSource(
			readSettingValue('localModelAssignments'),
			readLocalModelEndpoints()
		);
		if (brainSource) {
			writeLocalModelAssignments(
				withLocalModelAssignment(readLocalModelAssignments(), VOICE_ROUTING_TASK_ID, OFF_ASSIGNMENT)
			);
			clearedAssignment = brainSource.spec;
		}
	}

	writeSettingValue(`acappella.${path}`, value);
	const report = await applyToRunningApp();

	if (options.json) {
		printJson({
			slot: wantedSlot,
			value,
			...(clearedAssignment ? { clearedAssignment } : {}),
			...report,
		});
		return;
	}
	console.log(formatSuccess(`${wantedSlot} = ${value}`));
	if (clearedAssignment) {
		console.log(`  Switched the Voice routing assignment off (it was ${clearedAssignment}).`);
	}
	printApplyReport(report);
}

/** `voice voices list` - the voices the Text-to-Speech provider offers, and the one selected. */
export async function voiceVoicesList(options: JsonOption): Promise<void> {
	const { voices } = await sendVoiceControl({ action: 'voices' }, options.json);
	const selected = asId(readSettingValue('acappella.voice.voiceId')) ?? null;
	if (options.json) {
		printJson({ selected, voices });
		return;
	}
	if (voices.length === 0) {
		console.log('The Text-to-Speech provider has one voice (the provider default).');
		return;
	}
	for (const voice of voices) {
		console.log(`${voice.id === selected ? '*' : ' '} ${voice.id}  ${voice.name}`);
	}
	if (!selected) console.log('No voice is selected: the provider default speaks.');
}

/** `voice voices set <id>` - pick the voice replies are spoken in. */
export async function voiceVoicesSet(voiceId: string, options: JsonOption): Promise<void> {
	const wanted = voiceId.trim();
	const problem = voiceSettingProblem('voice.voiceId', wanted);
	if (problem) failCommand(problem, options.json, ExitCode.InvalidUsage);

	// Checked against the provider's own list when the app can be asked: a voice
	// id nothing offers is a setting that silently speaks in the default voice.
	const listed = await tryVoiceControl({ action: 'voices' });
	if (
		listed.kind === 'done' &&
		listed.result.voices.length > 0 &&
		!listed.result.voices.some((voice) => voice.id === wanted)
	) {
		failCommand(
			`The Text-to-Speech provider has no voice "${wanted}". See "maestro-cli voice voices list".`,
			options.json,
			ExitCode.InvalidUsage
		);
	}

	writeSettingValue('acappella.voice.voiceId', wanted);
	const report = await applyToRunningApp();
	if (options.json) {
		printJson({ voiceId: wanted, ...report });
		return;
	}
	console.log(formatSuccess(`Voice is ${wanted}.`));
	printApplyReport(report);
}

/** `voice voices preview [id]` - speak one line in a voice, selected or not. */
export async function voiceVoicesPreview(
	voiceId: string | undefined,
	options: JsonOption & { text?: string }
): Promise<void> {
	const result = await sendVoiceControl(
		{
			action: 'preview',
			...(options.text?.trim() ? { text: options.text } : {}),
			...(voiceId?.trim() ? { voiceId: voiceId.trim() } : {}),
		},
		options.json,
		// The first preview builds the pipeline, which may load a local voice model.
		120_000
	);
	if (!result.spoke) {
		failCommand(
			'Nothing was spoken. A voice session is live, or the Text-to-Speech provider produced no audio.',
			options.json
		);
	}
	if (options.json) printJson({ ...result });
	else console.log(formatSuccess('Spoke the preview line.'));
}

function requireService(service: string, json: boolean | undefined): VoiceCredentialService {
	const wanted = service.trim().toLowerCase();
	if (!(VOICE_CREDENTIAL_SERVICES as readonly string[]).includes(wanted)) {
		failCommand(
			`Unknown service "${service}". Services: ${VOICE_CREDENTIAL_SERVICES.join(', ')}.`,
			json,
			ExitCode.InvalidUsage
		);
	}
	return wanted as VoiceCredentialService;
}

/**
 * Read a key from standard input. A terminal is refused: a key typed at a
 * prompt this command does not hide would be on the screen, and a key given as
 * an argument would be in shell history.
 */
function readKeyFromStdin(verb: string, json: boolean | undefined): string {
	if (isStdinTerminal()) {
		failCommand(
			`Pipe the key on standard input, for example: pbpaste | maestro-cli voice credentials ${verb}`,
			json,
			ExitCode.InvalidUsage
		);
	}
	let text: string;
	try {
		text = readStdinText();
	} catch {
		failCommand('Could not read the key from standard input.', json);
	}
	const key = text.trim();
	if (!key) failCommand('The key on standard input was empty.', json, ExitCode.InvalidUsage);
	return key;
}

/** `voice credentials list` - which cloud keys are stored. Never the keys. */
export async function voiceCredentialsList(options: JsonOption): Promise<void> {
	const { credentials } = await sendVoiceControl({ action: 'credentials' }, options.json);
	if (options.json) {
		printJson({ credentials });
		return;
	}
	for (const credential of credentials) {
		const state = !credential.keyringAvailable
			? 'no credential store on this machine'
			: credential.configured
				? 'stored'
				: 'not set';
		console.log(`${credential.service}  ${credential.label}: ${state}`);
	}
}

/** `voice credentials set <service>` - store a key read from standard input. */
export async function voiceCredentialsSet(service: string, options: JsonOption): Promise<void> {
	const wanted = requireService(service, options.json);
	const key = readKeyFromStdin(`set ${wanted}`, options.json);
	const result = await sendVoiceControl(
		{ action: 'set-credential', service: wanted, key },
		options.json
	);
	if (options.json) printJson({ ...result });
	else console.log(formatSuccess(`Stored the ${credentialLabel(wanted)} key in the OS keychain.`));
}

/** `voice credentials clear <service>` - remove a stored key. */
export async function voiceCredentialsClear(service: string, options: JsonOption): Promise<void> {
	const wanted = requireService(service, options.json);
	const result = await sendVoiceControl(
		{ action: 'clear-credential', service: wanted },
		options.json
	);
	if (options.json) printJson({ ...result });
	else console.log(formatSuccess(`Removed the ${credentialLabel(wanted)} key.`));
}

/**
 * `voice credentials test <service> [--stdin]` - ask the service whether a key
 * works: the stored one, or one read from standard input before it is stored.
 */
export async function voiceCredentialsTest(
	service: string,
	options: JsonOption & { stdin?: boolean }
): Promise<void> {
	const wanted = requireService(service, options.json);
	const key = options.stdin ? readKeyFromStdin(`test ${wanted} --stdin`, options.json) : undefined;
	const result = await sendVoiceControl(
		{ action: 'test-credential', service: wanted, ...(key ? { key } : {}) },
		options.json
	);
	const valid = result.status === 'valid';
	if (options.json) {
		// The verdict is the whole answer, so it is printed whole; a key that
		// does not work still exits non-zero.
		console.log(JSON.stringify({ success: valid, ...result }));
		if (!valid) exitWith(ExitCode.GeneralError);
		return;
	}
	if (!valid) failCommand(result.message, false);
	console.log(formatSuccess(result.message));
}

function agentName(agentId: string): string {
	return getSessionById(agentId)?.name ?? agentId;
}

/** `voice wake-phrase list` - every agent with a wake phrase of its own. */
export function voiceWakePhraseList(options: JsonOption): void {
	const phrases = readAgentWakePhrases(readSettingValue('acappella.controls.agentPhrases'));
	if (options.json) {
		printJson({
			phrases: phrases.map((entry) => ({
				agentId: entry.agentSessionId,
				name: agentName(entry.agentSessionId),
				phrase: entry.phrase,
			})),
		});
		return;
	}
	if (phrases.length === 0) {
		console.log('No agent has a wake phrase of its own.');
		return;
	}
	for (const entry of phrases) {
		console.log(`${agentName(entry.agentSessionId)} (${entry.agentSessionId}): "${entry.phrase}"`);
	}
}

/** Rewrite one agent's entry and leave every other one as it is stored. */
function writeAgentPhrase(agentId: string, phrase: string): void {
	const stored = readAgentWakePhrases(readSettingValue('acappella.controls.agentPhrases'));
	writeSettingValue(
		'acappella.controls.agentPhrases',
		withAgentWakePhrase(stored, agentId, phrase)
	);
}

/** `voice wake-phrase set <agent> <phrase>` - saying the phrase opens a session on that agent. */
export function voiceWakePhraseSet(agent: string, phrase: string, options: JsonOption): void {
	const agentId = resolveAgentOrFail(agent, options.json);
	const wanted = phrase.trim();
	if (!wanted) {
		failCommand(
			'phrase cannot be empty. Use "voice wake-phrase clear" to remove one.',
			options.json,
			ExitCode.InvalidUsage
		);
	}
	writeAgentPhrase(agentId, wanted);
	if (options.json) printJson({ agentId, phrase: wanted });
	else console.log(formatSuccess(`"${wanted}" now wakes ${agentName(agentId)}.`));
}

/** `voice wake-phrase clear <agent>` - remove an agent's own wake phrase. */
export function voiceWakePhraseClear(agent: string, options: JsonOption): void {
	const agentId = resolveAgentOrFail(agent, options.json);
	writeAgentPhrase(agentId, '');
	if (options.json) printJson({ agentId, phrase: null });
	else console.log(formatSuccess(`${agentName(agentId)} has no wake phrase of its own.`));
}
