/** @import { MaestroSdk } from '@maestro/plugin-sdk' */
/* global module */
let sdk;
module.exports = {
	/** @param {MaestroSdk} maestro */
	async activate(maestro) {
		sdk = maestro;
		maestro.commands.register('refresh', async () => {
			const readiness = await maestro.services.readiness('transcription');
			await maestro.ui.panelPost('config', readiness);
		});
		await maestro.services.register('transcription', async (request, context) => {
			// All media I/O remains in the host broker. These are minted call aliases,
			// never the consumer's job/audio IDs, filesystem paths or download URLs.
			await maestro.services.media.probe(request.callId, request.audioId);
			const decoded = await maestro.services.media.decode(request.callId, request.audioId);
			const probe = await maestro.services.media.probe(request.callId, decoded.audioId);
			if (context.isCancelled()) throw new Error('ServiceCancelled');
			const output = await maestro.services.media.run(request.callId, decoded.audioId);
			const report = JSON.parse(output.json);
			// Normalize only after checking the actual Whisper metadata. Do not trust
			// successful process exit as evidence for the requested language/model mode.
			if (
				report?.model?.multilingual !== true ||
				report?.params?.language !== request.language ||
				report?.params?.translate !== false ||
				report?.result?.language !== request.language ||
				!Array.isArray(report.transcription) ||
				report.transcription.length > 1000
			)
				throw new Error('ServiceInvalid');
			let text = '';
			for (const segment of report.transcription) {
				if (typeof segment?.text !== 'string') throw new Error('ServiceInvalid');
				text += segment.text;
				if (text.length > 12000) throw new Error('ServiceInvalid');
			}
			text = text.trim();
			if (!text) throw new Error('ServiceEmpty');
			if (context.isCancelled()) throw new Error('ServiceCancelled');
			return {
				text,
				language: request.language,
				model: request.model,
				durationSeconds: probe.durationSeconds,
				multilingual: true,
				translated: false,
			};
		});
	},
	async deactivate() {
		if (sdk) await sdk.services.unregister('transcription');
	},
};
