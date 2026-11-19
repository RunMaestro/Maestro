import { useCallback, useEffect, useRef, useState } from 'react';
import {
	compactPlaybookParamValues,
	type PlaybookParamValues,
} from '../../../shared/playbookParams';
import { notifyToast } from '../../stores/notificationStore';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { logger } from '../../utils/logger';
import { useDebouncedCallback } from '../utils/useThrottle';

/** How long typing settles before the answers are written to the record. */
export const PLAYBOOK_PARAM_SAVE_DEBOUNCE_MS = 400;

export interface UsePlaybookParamAnswersOptions {
	/** The agent whose playbook store holds the record. */
	sessionId: string;
	playbookId: string;
	/** The record's stored answers, read once per playbook. */
	initialAnswers: PlaybookParamValues | undefined;
}

export interface UsePlaybookParamAnswersResult {
	/** The user's answers, as typed (blank answers included until saved). */
	answers: PlaybookParamValues;
	setAnswer: (name: string, value: string) => void;
	/** Write any pending answers now. Resolves once the write has settled. */
	flush: () => Promise<void>;
}

/**
 * The user's answers to a playbook's parameter form, saved to the playbook
 * record through `playbooks:update` as they type (debounced), so an answer
 * outlives the form: the Auto Run panel, a Resume, and the CLI all read the
 * record. Blank answers are dropped on save, so a cleared field falls back
 * to its default. A pending save is written on unmount.
 */
export function usePlaybookParamAnswers({
	sessionId,
	playbookId,
	initialAnswers,
}: UsePlaybookParamAnswersOptions): UsePlaybookParamAnswersResult {
	const [answers, setAnswers] = useState<PlaybookParamValues>(() => ({ ...initialAnswers }));
	const answersRef = useRef(answers);
	answersRef.current = answers;
	const inFlightRef = useRef<Promise<void>>(Promise.resolve());

	// A different playbook in the same form starts from its own answers.
	const loadedIdRef = useRef(playbookId);
	useEffect(() => {
		if (loadedIdRef.current === playbookId) return;
		loadedIdRef.current = playbookId;
		setAnswers({ ...initialAnswers });
	}, [playbookId, initialAnswers]);

	const save = useCallback(
		(values: PlaybookParamValues) => {
			const write = (async () => {
				try {
					const result = await window.maestro.playbooks.update(sessionId, playbookId, {
						parameterValues: compactPlaybookParamValues(values),
					});
					if (!result.success) throw new Error(result.error ?? 'The playbook was not updated.');
				} catch (error) {
					logger.warn('[PlaybookParams] Could not save parameter answers:', undefined, error);
					notifyToast({
						color: 'red',
						title: 'Playbook answers not saved',
						message: ipcErrorMessage(error),
					});
				}
			})();
			inFlightRef.current = write;
			return write;
		},
		[sessionId, playbookId]
	);

	const { debouncedCallback: saveSoon, flush: flushPending } = useDebouncedCallback(
		(values: PlaybookParamValues) => {
			void save(values);
		},
		PLAYBOOK_PARAM_SAVE_DEBOUNCE_MS,
		{ flushOnUnmount: true }
	);

	const setAnswer = useCallback(
		(name: string, value: string) => {
			const next = { ...answersRef.current, [name]: value };
			answersRef.current = next;
			setAnswers(next);
			saveSoon(next);
		},
		[saveSoon]
	);

	const flush = useCallback(async () => {
		flushPending();
		await inFlightRef.current;
	}, [flushPending]);

	return { answers, setAnswer, flush };
}
