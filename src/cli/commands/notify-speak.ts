// Notify-speak command - say one line aloud on the computer running Maestro.
//
// The CLI path to spoken notices: the same main-process queue, the same local
// voice, and the same rules as the notice Maestro speaks when an agent
// finishes a turn (Settings > Notifications) and as the Test button there. An
// explicit request, so the setting is not consulted; everything else holds:
// notices never overlap, and nothing is spoken while a voice session is live.
//
// The command waits until the line was spoken (or refused) and says which, so
// a script can tell "heard" from "skipped, and why".

import { withMaestroClient } from '../services/maestro-client';
import { ExitCode, exitCodeForError, exitWith } from '../exit-codes';
import {
	SPOKEN_NOTICE_MAX_REQUEST_CHARS,
	type SpokenNoticeResult,
} from '../../shared/spokenNotices';

interface NotifySpeakOptions {
	json?: boolean;
}

/**
 * Above the longest a notice can wait in the app's queue before it is dropped
 * as stale, plus the speech itself, so the app's own verdict arrives first.
 */
const SPEAK_TIMEOUT_MS = 150_000;

function fail(message: string, json: boolean | undefined, code = ExitCode.GeneralError): never {
	if (json) console.log(JSON.stringify({ success: false, spoken: false, error: message }));
	else console.error(`Error: ${message}`);
	return exitWith(code);
}

export async function notifySpeak(text: string, options: NotifySpeakOptions): Promise<void> {
	if (!text.trim()) {
		fail('text cannot be empty', options.json, ExitCode.InvalidUsage);
	}
	if (text.length > SPOKEN_NOTICE_MAX_REQUEST_CHARS) {
		fail(
			`text is limited to ${SPOKEN_NOTICE_MAX_REQUEST_CHARS} characters`,
			options.json,
			ExitCode.InvalidUsage
		);
	}

	let reply: { success: boolean; result?: SpokenNoticeResult; error?: string };
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<{ success: boolean; result?: SpokenNoticeResult; error?: string }>(
				{ type: 'notify_speak', text },
				'notify_speak_result',
				SPEAK_TIMEOUT_MS
			)
		);
	} catch (error) {
		fail(
			error instanceof Error ? error.message : String(error),
			options.json,
			exitCodeForError(error)
		);
	}

	const result = reply.result;
	if (!reply.success || !result) {
		fail(reply.error || 'Failed to speak', options.json);
	}

	if (result.spoken) {
		if (options.json) {
			console.log(JSON.stringify({ success: true, spoken: true, text: result.text }));
		} else {
			console.log(`Spoken: ${result.text}`);
		}
		return;
	}

	// Not spoken is an answer the app gave on purpose (a voice session is live,
	// the voice could not speak), so it carries its code rather than a bare error.
	if (options.json) {
		console.log(
			JSON.stringify({ success: false, spoken: false, code: result.code, error: result.message })
		);
	} else {
		console.error(`Not spoken (${result.code}): ${result.message}`);
	}
	exitWith(ExitCode.GeneralError);
}
