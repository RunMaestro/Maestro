import { WorkGraphDB } from './work-graph-db';

let workGraphDbInstance: WorkGraphDB | null = null;

export function getWorkGraphDB(): WorkGraphDB {
	if (!workGraphDbInstance) {
		workGraphDbInstance = new WorkGraphDB();
	}
	return workGraphDbInstance;
}

export function initializeWorkGraphDB(): void {
	getWorkGraphDB().initialize();
}

export function closeWorkGraphDB(): void {
	if (workGraphDbInstance) {
		workGraphDbInstance.close();
		workGraphDbInstance = null;
	}
}
