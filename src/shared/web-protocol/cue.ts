export interface CueSubscriptionInfo {
	id: string;
	name: string;
	eventType: string;
	pattern?: string;
	schedule?: string;
	sessionId: string;
	sessionName: string;
	enabled: boolean;
	lastTriggered?: number;
	triggerCount: number;
}

export interface CueActivityEntry {
	id: string;
	subscriptionId: string;
	subscriptionName: string;
	eventType: string;
	sessionId: string;
	timestamp: number;
	status: 'triggered' | 'running' | 'completed' | 'failed';
	result?: string;
	duration?: number;
}
