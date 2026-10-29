import type {
	MemoryCommandSelection,
	MemoryCommandSnapshot,
	MemoryCommandPreview,
	MemoryCommandDraft,
} from '../../shared/memoryCommandDraft';
import { generateId } from '../utils/ids';
import { useSettingsStore } from '../stores/settingsStore';
import {
	isMemoryCommandDraft,
	validateMemoryCommandSnapshot,
} from '../../shared/memoryCommandDraft';

/** Capture only after an explicit user action; no persistence, plugin call or agent launch. */
export function selectMemoryCommandDraft(
	snapshot: MemoryCommandSnapshot,
	generator: MemoryCommandSelection['generator']
): MemoryCommandSelection {
	validateMemoryCommandSnapshot(snapshot);
	if (generator.provider !== 'codex' || !generator.agentId) {
		throw new Error('Choose a Codex generator agent');
	}
	const selection = snapshot.selection;
	return {
		...snapshot,
		sourceRef: { ...snapshot.sourceRef, location: { ...snapshot.sourceRef.location } },
		selection: selection && selection.start !== selection.end ? { ...selection } : undefined,
		requestId: generateId(),
		status: 'selected',
		generator: { ...generator },
	};
}

/** Revalidate the host event and detach fields before exposing the editable global form. */
export function previewMemoryCommandDraft(requestId: string, draft: unknown): MemoryCommandPreview {
	if (!requestId || !isMemoryCommandDraft(draft)) throw new Error('Invalid command preview');
	return { requestId, draft: { ...draft } };
}

/** Both command forms await the same host save; update local settings only from its receipt. */
export async function saveMemoryCommandDraft(
	viewerId: string,
	requestId: string,
	draft: MemoryCommandDraft
): Promise<boolean> {
	const result = await window.maestro.memory.saveCommand(viewerId, requestId, draft);
	if (result.requestId !== requestId) return false;
	if (result.status === 'collision') throw new Error('MemoryCommandCollision');
	if (result.status !== 'saved') return false;
	useSettingsStore.setState({ customAICommands: result.commands });
	return true;
}
