// `maestro-cli models config show` and `maestro-cli models config set
// download-base <url>` - the Local Models download source from the command line.
//
// The download base is the host model files and Hugging Face metadata are
// requested from (the `localModelsDownloadBase` setting; Settings -> Models ->
// Library -> Advanced). Point it at a mirror when a network blocks Hugging
// Face. It changes the host only: every download is still checked against the
// catalog hash.
//
// Both verbs read and write the settings file, exactly as `models endpoints`
// does, so they work with Maestro closed; a running app picks the change up
// from its settings watcher and uses it for the next request. The value is
// validated by the same `downloadBaseProblem()` the Settings field uses, so the
// CLI cannot save a value the app would ignore.
//
// Exit codes: 0 on success, 2 (invalid usage) for an unknown key or a value
// that is not a usable URL.

import { readSettingValue, writeSettingValue } from '../services/storage';
import { ExitCode } from '../exit-codes';
import { formatSuccess } from '../output/formatter';
import {
	DEFAULT_DOWNLOAD_BASE,
	LOCAL_MODELS_DOWNLOAD_BASE_SETTING,
	downloadBaseProblem,
	isMirrorDownloadBase,
	normalizeDownloadBase,
	resolveDownloadBase,
} from '../../shared/local-models/download-base';
import { failCommand } from '../services/session-command';

interface JsonOption {
	json?: boolean;
}

/** The keys `models config set` takes, spelled as the user types them. */
const CONFIG_KEY_DOWNLOAD_BASE = 'download-base';

/** The base in force, read through the validator the app reads it with. */
function currentBase(): string {
	return resolveDownloadBase(readSettingValue(LOCAL_MODELS_DOWNLOAD_BASE_SETTING));
}

export function modelsConfigShow(options: JsonOption): void {
	const base = currentBase();
	const mirror = isMirrorDownloadBase(base);
	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				downloadBase: base,
				default: DEFAULT_DOWNLOAD_BASE,
				mirror,
			})
		);
		return;
	}
	console.log(`download-base: ${base}${mirror ? '' : ' (default)'}`);
}

export function modelsConfigSet(key: string, value: string, options: JsonOption): void {
	if (key !== CONFIG_KEY_DOWNLOAD_BASE) {
		failCommand(
			`Unknown key "${key}". The key is: ${CONFIG_KEY_DOWNLOAD_BASE}`,
			options.json,
			ExitCode.InvalidUsage
		);
	}
	const problem = downloadBaseProblem(value);
	if (problem) failCommand(problem, options.json, ExitCode.InvalidUsage);

	const base = normalizeDownloadBase(value);
	writeSettingValue(LOCAL_MODELS_DOWNLOAD_BASE_SETTING, base);

	const mirror = isMirrorDownloadBase(base);
	if (options.json) {
		console.log(JSON.stringify({ success: true, downloadBase: base, mirror }));
		return;
	}
	console.log(
		formatSuccess(
			mirror
				? `Models will download from ${base}. Every file is still checked against its hash.`
				: `Models will download from Hugging Face (${DEFAULT_DOWNLOAD_BASE}).`
		)
	);
}
