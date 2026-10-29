import { useCallback, useEffect, useRef, useState } from 'react';
import type {
	MemoryCommandDraft,
	MemoryCommandEditorPreview,
} from '../../../shared/memoryCommandDraft';
import {
	previewMemoryCommandDraft,
	saveMemoryCommandDraft,
} from '../../services/memoryCommandDraft';
import { useModalStore } from '../../stores/modalStore';
import { useSettingsStore } from '../../stores/settingsStore';

/** App-wide transient delivery to the existing Settings command form, including while closed. */
export function useMemoryCommandEditor(settingsOpen: boolean) {
	const pluginsEnabled = useSettingsStore((state) => state.encoreFeatures.plugins === true);
	const [preview, setPreview] = useState<MemoryCommandEditorPreview | null>(null);
	const [staged, setStaged] = useState<MemoryCommandEditorPreview | null>(null);
	const current = useRef(preview);
	const pending = useRef(staged);
	const retired = useRef(new Set<string>());
	const open = useRef(settingsOpen);
	open.current = settingsOpen;
	const wasOpen = useRef(settingsOpen);
	const complete = useCallback((status: 'saved' | 'cancelled', requestId: string) => {
		const target = [current.current, pending.current].find((item) => item?.requestId === requestId);
		if (!target) return;
		retired.current.add(requestId);
		if (current.current === target) {
			current.current = null;
			setPreview(null);
		}
		if (pending.current === target) {
			pending.current = null;
			setStaged(null);
		}
		if (status !== 'saved')
			void window.maestro.memory.closeCommandViewer(target.viewerId).catch(() => {});
	}, []);
	useEffect(() => {
		if (!pluginsEnabled) return;
		let subscribed = true;
		const off = window.maestro.memory.onCommandEditor?.((value) => {
			if (
				!subscribed ||
				!useSettingsStore.getState().encoreFeatures.plugins ||
				retired.current.has(value.requestId)
			)
				return;
			const validated = previewMemoryCommandDraft(value.requestId, value.draft);
			const existing = [current.current, pending.current].find(
				(item) => item?.requestId === value.requestId
			);
			if (existing && existing.viewerId !== value.viewerId) return;
			if (!existing) {
				if (pending.current) complete('cancelled', pending.current.requestId);
				const next = { ...validated, viewerId: value.viewerId, background: value.background };
				pending.current = next;
				setStaged(next);
			}
			// Opening Settings is separate from accepting a draft into the current form.
			if (!value.background && !open.current)
				useModalStore.getState().openModal('settings', { tab: 'aicommands' });
		});
		return () => {
			subscribed = false;
			off?.();
			if (current.current) complete('cancelled', current.current.requestId);
			if (pending.current) complete('cancelled', pending.current.requestId);
		};
	}, [pluginsEnabled, complete]);
	useEffect(() => {
		if (wasOpen.current && !settingsOpen) {
			if (current.current) complete('cancelled', current.current.requestId);
			if (pending.current) complete('cancelled', pending.current.requestId);
		}
		wasOpen.current = settingsOpen;
	}, [settingsOpen, complete]);
	const activate = useCallback((requestId: string) => {
		const target = pending.current;
		if (
			!useSettingsStore.getState().encoreFeatures.plugins ||
			current.current ||
			target?.requestId !== requestId
		)
			return;
		pending.current = null;
		setStaged(null);
		current.current = target;
		setPreview(target);
	}, []);
	const save = useCallback(
		async (draft: MemoryCommandDraft) => {
			if (
				!useSettingsStore.getState().encoreFeatures.plugins ||
				!preview ||
				current.current !== preview
			)
				return false;
			return saveMemoryCommandDraft(preview.viewerId, preview.requestId, draft);
		},
		[preview]
	);
	return {
		preview: pluginsEnabled ? preview : null,
		staged: pluginsEnabled ? staged : null,
		activate,
		save,
		complete,
	};
}
