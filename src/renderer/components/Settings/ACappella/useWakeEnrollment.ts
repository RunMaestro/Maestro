/**
 * One phrase's wake word enrollment, as a panel needs it.
 *
 * The flow itself lives in the main process (it holds the microphone and the
 * recordings); this is a projection of it. Status is REPLACED from each event
 * rather than patched, so a client that missed one is put right by the next,
 * and every event is filtered by the phrase's key: the channel is a broadcast,
 * and a second Settings window recording a different phrase must not move this
 * one's counter.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
	describeWakeClipRejection,
	wakePhraseKey,
	type WakeEnrollmentRecordingKind,
	type WakeEnrollmentReply,
	type WakeEnrollmentRequest,
	type WakeEnrollmentStatus,
	type WakeTrainingPhase,
} from '../../../../shared/acappella/wake-enrollment';
import { useDebouncedValue } from '../../../hooks/utils/useThrottle';

/** Typing a phrase should not read the disk on every keystroke. */
const STATUS_DEBOUNCE_MS = 250;

/** How long "that was too short" stays on screen. */
const NOTICE_MS = 3000;

export interface WakeTrainingProgress {
	phase: WakeTrainingPhase;
	/** 0 to 1 across the whole run. */
	progress: number;
}

export interface WakeEnrollment {
	/** Null until the first read lands. */
	status: WakeEnrollmentStatus | null;
	/** Microphone level while recording, 0 to 1. Zero otherwise. */
	level: number;
	/** A take that was heard and not kept, as a sentence. Clears itself. */
	notice: string | null;
	/** Training progress, or null when nothing is training. */
	training: WakeTrainingProgress | null;
	/** Why the last request was refused or failed, as a sentence. */
	error: string | null;
	record: (kind: WakeEnrollmentRecordingKind) => Promise<void>;
	stop: () => Promise<void>;
	removeLastClip: () => Promise<void>;
	clearBackground: () => Promise<void>;
	train: () => Promise<boolean>;
	remove: () => Promise<void>;
	refresh: () => Promise<void>;
}

export function useWakeEnrollment(phrase: string, enabled: boolean): WakeEnrollment {
	const settled = useDebouncedValue(phrase, STATUS_DEBOUNCE_MS);
	const key = useMemo(() => wakePhraseKey(settled), [settled]);
	const [status, setStatus] = useState<WakeEnrollmentStatus | null>(null);
	const [level, setLevel] = useState(0);
	const [notice, setNotice] = useState<string | null>(null);
	const [training, setTraining] = useState<WakeTrainingProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	/** Send one request; a refusal becomes the error line rather than an exception. */
	const send = useCallback(async (request: WakeEnrollmentRequest): Promise<WakeEnrollmentReply> => {
		const reply = await window.maestro.voice
			.wakeEnrollment(request)
			.catch((err: Error): WakeEnrollmentReply => ({ ok: false, reason: err.message }));
		if (reply.ok) {
			setError(null);
			if (reply.status) setStatus(reply.status);
		} else {
			setError(reply.reason);
		}
		return reply;
	}, []);

	const refresh = useCallback(async () => {
		await send({ action: 'status', phrase: settled });
	}, [send, settled]);

	useEffect(() => {
		setStatus(null);
		setLevel(0);
		setTraining(null);
		setError(null);
		void refresh();
	}, [refresh, enabled]);

	useEffect(() => {
		if (!key) return;
		return window.maestro.voice.onWakeEnrollment((event) => {
			if (event.type === 'status') {
				if (event.status.key !== key) return;
				setStatus(event.status);
				if (!event.status.recording) setLevel(0);
				if (!event.status.training) setTraining(null);
				return;
			}
			if (event.key !== key) return;
			if (event.type === 'level') {
				setLevel(event.level);
			} else if (event.type === 'clip-rejected') {
				setNotice(describeWakeClipRejection(event.reason));
				if (noticeTimer.current) clearTimeout(noticeTimer.current);
				noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
			} else if (event.type === 'training') {
				setTraining({ phase: event.phase, progress: event.progress });
			} else if (event.type === 'error') {
				setError(event.message);
			}
		});
	}, [key]);

	useEffect(
		() => () => {
			if (noticeTimer.current) clearTimeout(noticeTimer.current);
		},
		[]
	);

	const record = useCallback(
		async (kind: WakeEnrollmentRecordingKind) => {
			await send({ action: 'record', phrase: settled, kind });
		},
		[send, settled]
	);
	const stop = useCallback(async () => {
		await send({ action: 'stop' });
		// `stop` answers for whichever phrase was recording; re-read this one.
		await send({ action: 'status', phrase: settled });
	}, [send, settled]);
	const removeLastClip = useCallback(async () => {
		await send({ action: 'remove-last-clip', phrase: settled });
	}, [send, settled]);
	const clearBackground = useCallback(async () => {
		await send({ action: 'clear-background', phrase: settled });
	}, [send, settled]);
	const train = useCallback(async () => {
		setTraining({ phase: 'listening', progress: 0 });
		const reply = await send({ action: 'train', phrase: settled });
		setTraining(null);
		return reply.ok;
	}, [send, settled]);
	const remove = useCallback(async () => {
		await send({ action: 'remove', phrase: settled });
	}, [send, settled]);

	return {
		// A status for the phrase as it was a keystroke ago would label the wrong
		// phrase as trained, so it is withheld until it matches.
		status: status && status.key === wakePhraseKey(phrase) ? status : null,
		level,
		notice,
		training,
		error,
		record,
		stop,
		removeLastClip,
		clearBackground,
		train,
		remove,
		refresh,
	};
}
