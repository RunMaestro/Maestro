// The model an init envelope names.
//
// `claude -p` names the resolved model in its init (`claude-opus-5-5[1m]`).
// The TUI does not announce one when it starts, so maestro-p's init said
// `model: null`. The transcript does name it, twice:
//
//  - A `model` attachment row carries the exact id, `[1m]` included. claude
//    writes it once, at the start of a session's first turn.
//  - Every assistant row carries `message.model`, the id the API answered
//    with, which drops the `[1m]` marker.
//
// So init waits for the first row that names a model. A resumed session gets
// no attachment row, so the id an earlier turn's attachment recorded is used
// when it is the same model as the assistant reply, which keeps the `[1m]`.

import * as fs from 'fs';
import { normalizeModelId } from '../shared/modelPricing';
import { localCommandOutput } from './local-command-row';

/** A row that lets init go out, and the model it names (null when it names none). */
export interface InitTrigger {
	model: string | null;
}

function modelAttachmentId(row: Record<string, unknown>): string | null {
	if (row.type !== 'attachment') return null;
	const attachment = row.attachment as { type?: unknown; identity?: { modelId?: unknown } } | null;
	if (!attachment || attachment.type !== 'model') return null;
	const id = attachment.identity?.modelId;
	return typeof id === 'string' && id ? id : null;
}

/**
 * Whether this transcript row should release the init envelope, and with which
 * model. Rows before the first model-naming row (the prompt echo, other
 * attachments, bookkeeping) return null and keep init waiting. A local slash
 * command never reaches the model, so its output row releases init with none.
 */
export function initModelFromEntry(entry: unknown): InitTrigger | null {
	if (!entry || typeof entry !== 'object') return null;
	const row = entry as Record<string, unknown>;
	const attached = modelAttachmentId(row);
	if (attached) return { model: attached };
	if (row.type === 'assistant') {
		const model = (row.message as { model?: unknown } | undefined)?.model;
		return { model: typeof model === 'string' && model && model !== '<synthetic>' ? model : null };
	}
	if (localCommandOutput(entry) !== null) return { model: null };
	return null;
}

/** The model id the last `model` attachment in a transcript recorded, or null. */
export function lastModelAttachment(transcriptPath: string): string | null {
	let text: string;
	try {
		text = fs.readFileSync(transcriptPath, 'utf-8');
	} catch {
		return null;
	}
	const lines = text.split('\n');
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i];
		if (!line.includes('"attachment"') || !line.includes('"model"')) continue;
		try {
			const id = modelAttachmentId(JSON.parse(line) as Record<string, unknown>);
			if (id) return id;
		} catch {
			// A torn last line; keep looking further up.
		}
	}
	return null;
}

/** Whether two ids name the same model, ignoring the `[1m]` marker and a date suffix. */
export function sameModel(a: string, b: string): boolean {
	return normalizeModelId(a) === normalizeModelId(b);
}

/** The model an init should name, from the trigger row and a resumed session's earlier id. */
export function resolveInitModel(trigger: string | null, resumed: string | null): string | null {
	if (trigger === null) return resumed;
	if (resumed !== null && sameModel(trigger, resumed)) return resumed;
	return trigger;
}
