/** Attach-to-existing-host contract. Workload capabilities describe host-owned execution. */
export const MAESTRO_REMOTE_PROTOCOL_VERSION = 1;

export interface MaestroRemoteHandshake {
	protocolVersion: number;
	instanceId: string;
	hostName: string;
	appVersion: string;
	platform: string;
	ready: boolean;
	unavailableReason?: string;
	authentication: { loginEnabled: boolean; authenticated: boolean };
	capabilities: { sessions: boolean; terminal: boolean; files: boolean; browserRelay: boolean };
}
