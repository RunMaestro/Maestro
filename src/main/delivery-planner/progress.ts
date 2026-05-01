export type DeliveryPlannerOperationType = 'external-mirror-sync' | 'decomposition' | 'github-sync';
export type DeliveryPlannerOperationStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface DeliveryPlannerProgressSnapshot {
	id: string;
	type: DeliveryPlannerOperationType;
	status: DeliveryPlannerOperationStatus;
	attempt: number;
	retryable: boolean;
	message?: string;
	totalSteps?: number;
	completedSteps: number;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	error?: string;
	metadata?: Record<string, unknown>;
}

export interface DeliveryPlannerProgressStore {
	start(
		type: DeliveryPlannerOperationType,
		metadata?: Record<string, unknown>,
		totalSteps?: number
	): DeliveryPlannerProgressSnapshot;
	update(
		id: string,
		patch: Partial<
			Pick<
				DeliveryPlannerProgressSnapshot,
				'status' | 'message' | 'completedSteps' | 'totalSteps' | 'retryable' | 'metadata'
			>
		>
	): DeliveryPlannerProgressSnapshot;
	complete(id: string, message?: string): DeliveryPlannerProgressSnapshot;
	fail(id: string, error: Error | string, retryable?: boolean): DeliveryPlannerProgressSnapshot;
	get(id: string): DeliveryPlannerProgressSnapshot | undefined;
	list(): DeliveryPlannerProgressSnapshot[];
	prepareRetry(id: string): DeliveryPlannerProgressSnapshot;
}

export type DeliveryPlannerProgressChangeHandler = (
	operation: DeliveryPlannerProgressSnapshot
) => void;

const now = () => new Date().toISOString();

export class InMemoryDeliveryPlannerProgressStore implements DeliveryPlannerProgressStore {
	private operations = new Map<string, DeliveryPlannerProgressSnapshot>();
	private sequence = 0;

	constructor(private readonly onChange?: DeliveryPlannerProgressChangeHandler) {}

	start(
		type: DeliveryPlannerOperationType,
		metadata: Record<string, unknown> = {},
		totalSteps?: number
	): DeliveryPlannerProgressSnapshot {
		const timestamp = now();
		const operation: DeliveryPlannerProgressSnapshot = {
			id: `delivery-planner-${++this.sequence}`,
			type,
			status: 'running',
			attempt: 1,
			retryable: false,
			completedSteps: 0,
			totalSteps,
			startedAt: timestamp,
			updatedAt: timestamp,
			metadata,
		};

		this.operations.set(operation.id, operation);
		this.emitChange(operation);
		return operation;
	}

	update(
		id: string,
		patch: Partial<
			Pick<
				DeliveryPlannerProgressSnapshot,
				'status' | 'message' | 'completedSteps' | 'totalSteps' | 'retryable' | 'metadata'
			>
		>
	): DeliveryPlannerProgressSnapshot {
		const current = this.requireOperation(id);
		const next: DeliveryPlannerProgressSnapshot = {
			...current,
			...patch,
			updatedAt: now(),
		};

		this.operations.set(id, next);
		this.emitChange(next);
		return next;
	}

	complete(id: string, message?: string): DeliveryPlannerProgressSnapshot {
		const current = this.requireOperation(id);
		const timestamp = now();
		const next: DeliveryPlannerProgressSnapshot = {
			...current,
			status: 'completed',
			retryable: false,
			message,
			completedSteps: current.totalSteps ?? current.completedSteps,
			updatedAt: timestamp,
			completedAt: timestamp,
			error: undefined,
		};

		this.operations.set(id, next);
		this.emitChange(next);
		return next;
	}

	fail(id: string, error: Error | string, retryable = true): DeliveryPlannerProgressSnapshot {
		const current = this.requireOperation(id);
		const timestamp = now();
		const next: DeliveryPlannerProgressSnapshot = {
			...current,
			status: 'failed',
			retryable,
			updatedAt: timestamp,
			completedAt: timestamp,
			error: typeof error === 'string' ? error : error.message,
		};

		this.operations.set(id, next);
		this.emitChange(next);
		return next;
	}

	get(id: string): DeliveryPlannerProgressSnapshot | undefined {
		return this.operations.get(id);
	}

	list(): DeliveryPlannerProgressSnapshot[] {
		return [...this.operations.values()];
	}

	prepareRetry(id: string): DeliveryPlannerProgressSnapshot {
		const current = this.requireOperation(id);
		if (!current.retryable) {
			throw new Error(`Delivery Planner operation ${id} is not retryable`);
		}

		const next: DeliveryPlannerProgressSnapshot = {
			...current,
			status: 'running',
			attempt: current.attempt + 1,
			retryable: false,
			completedSteps: 0,
			completedAt: undefined,
			error: undefined,
			updatedAt: now(),
		};

		this.operations.set(id, next);
		this.emitChange(next);
		return next;
	}

	private requireOperation(id: string): DeliveryPlannerProgressSnapshot {
		const operation = this.operations.get(id);
		if (!operation) {
			throw new Error(`Unknown Delivery Planner operation: ${id}`);
		}

		return operation;
	}

	private emitChange(operation: DeliveryPlannerProgressSnapshot): void {
		this.onChange?.(operation);
	}
}
