/** Host-only readback request. item is the complete expected persisted row,
 * including image-store references (not transient renderer data URLs).
 * Comparing the whole row also binds turn settings, routing and recovery metadata.
 */
export interface QueueItemReceiptRequest {
	agentId: string;
	tabId: string;
	itemId: string;
	pendingAdmissionId: string;
	item: Readonly<Record<string, unknown>>;
}

/** Evidence at the serialized readback point, never permission to release a hold. */
export type QueueItemReceipt =
	| { durable: true; request: QueueItemReceiptRequest }
	| {
			durable: false;
			reason:
				| 'invalid-request'
				| 'session-missing'
				| 'tab-missing'
				| 'item-missing'
				| 'item-changed'
				| 'store-unavailable';
	  };

export type ConfirmQueueItem = (request: QueueItemReceiptRequest) => Promise<QueueItemReceipt>;

/** Host capability only. Runs on the same lock as saves and readback. commit
 * must durably journal uncertainty before returning a release generation.
 * The supplied guard rechecks the live cache after asynchronous disk I/O. */
export type ReleaseQueueItem = (
	request: QueueItemReceiptRequest & {
		tabIdentity: { createdAt: number; agentSessionId?: string | null };
	},
	commit: (guard: () => void) => { generation: string; guard: () => void }
) => Promise<{ generation: string; guard: () => void }>;
