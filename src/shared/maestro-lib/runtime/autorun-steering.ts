/**
 * Steering notes for a run a headless host drives: the same four gestures the desktop's Thought
 * Stream offers (send, list, cancel, dismiss), answered with the desktop's own wire shapes
 * (`SteeringCommandResult`), so a client steers a hosted run as it steers a local one.
 *
 * A note waits for the next task (or goal iteration), which takes every waiting note at once and
 * opens its prompt with the one block an agent reads (`formatSteeringNotesBlock()`), placed as the
 * desktop places it (`joinAutoRunPromptBlocks()`). The task's reply comes back to the notes it
 * took. A run's start clears everything; its end drops only the notes no task took, so the reply
 * to the last one is still there to read.
 *
 * Pure state over a clock and an id source: the runtime owns when a run starts and ends.
 */

import {
	MAX_PENDING_STEERING_NOTES,
	normalizeSteeringNoteText,
	type AutoRunSteeringNote,
} from '../../autorunSteering';
import type {
	SteeringCommandInput,
	SteeringCommandResult,
	SteeringDeliverySummary,
	SteeringNoteSummary,
	SteeringReplySummary,
} from '../../autoRunSteeringCommands';
import { historySummaryLine } from '../../history';

/** Deliveries kept per agent, oldest dropped first. The desktop keeps as many notes. */
export const MAX_STEERING_DELIVERIES = 50;
/** The longest reply kept beside a delivery. The desktop keeps as much. */
export const MAX_STEERING_REPLY_CHARS = 20_000;

/** The notes one task took, and that task's reply once it ends. */
interface Delivery {
	deliveryId: string;
	notes: AutoRunSteeringNote[];
	reply?: SteeringReplySummary;
}

export interface SteeringLedger {
	/** Answer one command. `blocker` is why a `send` is refused right now, or null when it is not. */
	command(
		agentId: string,
		input: SteeringCommandInput,
		blocker: string | null
	): SteeringCommandResult;
	/** Take every waiting note for the task about to start. `undefined` when none waits. */
	take(agentId: string): { deliveryId: string; notes: AutoRunSteeringNote[] } | undefined;
	/** Attach a finished task's reply to the notes it took. */
	reply(
		agentId: string,
		deliveryId: string,
		reply: { text: string; success: boolean; summary?: string }
	): void;
	/** A run starts: it begins with no notes. */
	startRun(agentId: string): void;
	/** A run ends: the notes no task took go, the delivered ones and their replies stay. */
	endRun(agentId: string): void;
}

export interface SteeringLedgerOptions {
	now(): number;
	newId(): string;
}

function noteSummary(note: AutoRunSteeringNote): SteeringNoteSummary {
	return { id: note.id, text: note.text, timestamp: note.timestamp };
}

function deliverySummary(delivery: Delivery): SteeringDeliverySummary {
	return {
		deliveryId: delivery.deliveryId,
		notes: delivery.notes.map(noteSummary),
		...(delivery.reply ? { reply: { ...delivery.reply } } : {}),
	};
}

export function createSteeringLedger(options: SteeringLedgerOptions): SteeringLedger {
	const pending = new Map<string, AutoRunSteeringNote[]>();
	const delivered = new Map<string, Delivery[]>();

	return {
		command(agentId, input, blocker) {
			const waiting = pending.get(agentId) ?? [];
			const deliveries = delivered.get(agentId) ?? [];

			if (input.action === 'list') {
				return {
					success: true,
					steerable: blocker === null,
					pending: waiting.map(noteSummary),
					deliveries: deliveries.map(deliverySummary),
				};
			}

			if (input.action === 'send') {
				if (blocker) return { success: false, error: blocker };
				const text = normalizeSteeringNoteText(input.text ?? '');
				if (!text) return { success: false, error: 'A steering note needs some text' };
				if (waiting.length >= MAX_PENDING_STEERING_NOTES) {
					return {
						success: false,
						error: `${MAX_PENDING_STEERING_NOTES} steering notes are already waiting for the next task`,
					};
				}
				const note: AutoRunSteeringNote = { id: options.newId(), text, timestamp: options.now() };
				pending.set(agentId, [...waiting, note]);
				return { success: true, note: noteSummary(note) };
			}

			if (input.action === 'dismiss') {
				const deliveryId = input.deliveryId;
				if (!deliveryId)
					return { success: false, error: 'steering dismiss requires a delivery id' };
				const target = deliveries.find((delivery) => delivery.deliveryId === deliveryId);
				if (!target) {
					const isPending = waiting.some((note) => note.id === deliveryId);
					return {
						success: false,
						error: isPending
							? 'That is a pending note, not a delivery; take it back with steer-auto-run cancel'
							: `No delivered steering notes with delivery id ${deliveryId}`,
					};
				}
				delivered.set(
					agentId,
					deliveries.filter((delivery) => delivery !== target)
				);
				return { success: true, delivery: deliverySummary(target) };
			}

			const noteId = input.noteId;
			if (!noteId) return { success: false, error: 'steering cancel requires a note id' };
			const target = waiting.find((note) => note.id === noteId);
			if (!target) {
				const taken = deliveries.some((delivery) => delivery.notes.some((n) => n.id === noteId));
				return {
					success: false,
					error: taken
						? 'That steering note was already delivered to a task and cannot be taken back'
						: `No pending steering note with id ${noteId}`,
				};
			}
			pending.set(
				agentId,
				waiting.filter((note) => note !== target)
			);
			return { success: true, note: noteSummary(target) };
		},

		take(agentId) {
			const waiting = pending.get(agentId);
			if (!waiting?.length) return undefined;
			pending.delete(agentId);
			const delivery: Delivery = { deliveryId: options.newId(), notes: waiting };
			const deliveries = [...(delivered.get(agentId) ?? []), delivery];
			delivered.set(agentId, deliveries.slice(-MAX_STEERING_DELIVERIES));
			return { deliveryId: delivery.deliveryId, notes: waiting };
		},

		reply(agentId, deliveryId, reply) {
			const delivery = delivered.get(agentId)?.find((d) => d.deliveryId === deliveryId);
			// Dismissed, or dropped by a new run: nothing to attach it to.
			if (!delivery) return;
			const text = reply.text.slice(0, MAX_STEERING_REPLY_CHARS);
			delivery.reply = {
				summary: reply.summary ?? (historySummaryLine(text) || (reply.success ? 'Done' : 'Failed')),
				text,
				success: reply.success,
				timestamp: options.now(),
			};
		},

		startRun(agentId) {
			pending.delete(agentId);
			delivered.delete(agentId);
		},

		endRun(agentId) {
			pending.delete(agentId);
		},
	};
}
