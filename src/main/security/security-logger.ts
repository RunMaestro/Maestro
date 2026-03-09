/**
 * Security Event Logging System
 *
 * Provides a centralized logging system for LLM Guard security events.
 * Features:
 * - Memory-efficient circular buffer (last 1000 events)
 * - Optional file persistence to ~/.maestro/security-events.jsonl
 * - Real-time event emission via IPC for UI updates
 * - Query support for recent events with pagination
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import type { LlmGuardFinding } from './llm-guard/types';

/**
 * Event types that can be logged
 */
export type SecurityEventType =
	| 'input_scan'
	| 'output_scan'
	| 'blocked'
	| 'warning'
	| 'inter_agent_scan';

/**
 * Action taken in response to the security event
 */
export type SecurityEventAction = 'none' | 'sanitized' | 'blocked' | 'warned';

/**
 * A security event logged by LLM Guard
 */
export interface SecurityEvent {
	/** Unique identifier for this event */
	id: string;
	/** Unix timestamp in milliseconds */
	timestamp: number;
	/** Maestro session ID where the event occurred */
	sessionId: string;
	/** AI tab ID within the session (optional) */
	tabId?: string;
	/** Type of security event */
	eventType: SecurityEventType;
	/** Findings from the scan */
	findings: LlmGuardFinding[];
	/** Action taken based on the findings */
	action: SecurityEventAction;
	/** Length of the original content (before sanitization) */
	originalLength: number;
	/** Length of the content after sanitization (same as original if no changes) */
	sanitizedLength: number;
	/** Group Chat ID (for inter-agent events only) */
	groupChatId?: string;
	/** Source agent name (for inter-agent events only) */
	sourceAgent?: string;
	/** Target agent name (for inter-agent events only) */
	targetAgent?: string;
}

/**
 * Parameters for creating a new security event (id and timestamp auto-generated)
 */
export type SecurityEventParams = Omit<SecurityEvent, 'id' | 'timestamp'>;

/**
 * Result of getting security events with pagination
 */
export interface SecurityEventsPage {
	events: SecurityEvent[];
	total: number;
	hasMore: boolean;
}

// Configuration
const MAX_EVENTS = 1000;
const SECURITY_EVENTS_FILE = 'security-events.jsonl';

// Circular buffer for in-memory storage
let eventsBuffer: SecurityEvent[] = [];
let bufferIndex = 0;
let totalEventsLogged = 0;

// Event listeners for real-time updates
type SecurityEventListener = (event: SecurityEvent) => void;
const eventListeners = new Set<SecurityEventListener>();

// File persistence path (initialized lazily)
let securityEventsPath: string | null = null;

/**
 * Get the path to the security events file
 */
function getSecurityEventsPath(): string {
	if (!securityEventsPath) {
		const userDataPath = app.getPath('userData');
		securityEventsPath = path.join(userDataPath, SECURITY_EVENTS_FILE);
	}
	return securityEventsPath;
}

/**
 * Log a security event to the circular buffer and optionally persist to file.
 *
 * @param params - Event parameters (id and timestamp will be auto-generated)
 * @param persistToFile - Whether to append the event to the JSONL file (default: true)
 * @returns The complete SecurityEvent with generated id and timestamp
 */
export async function logSecurityEvent(
	params: SecurityEventParams,
	persistToFile: boolean = true
): Promise<SecurityEvent> {
	const event: SecurityEvent = {
		...params,
		id: uuidv4(),
		timestamp: Date.now(),
	};

	// Add to circular buffer
	if (eventsBuffer.length < MAX_EVENTS) {
		eventsBuffer.push(event);
	} else {
		eventsBuffer[bufferIndex] = event;
		bufferIndex = (bufferIndex + 1) % MAX_EVENTS;
	}
	totalEventsLogged++;

	// Persist to file if requested
	if (persistToFile) {
		try {
			await appendEventToFile(event);
		} catch (error) {
			// Log error but don't throw - file persistence is optional
			console.error('[SecurityLogger] Failed to persist event to file:', error);
		}
	}

	// Notify listeners
	for (const listener of eventListeners) {
		try {
			listener(event);
		} catch (error) {
			console.error('[SecurityLogger] Event listener error:', error);
		}
	}

	return event;
}

/**
 * Append a security event to the JSONL file
 */
async function appendEventToFile(event: SecurityEvent): Promise<void> {
	const filePath = getSecurityEventsPath();
	const line = JSON.stringify(event) + '\n';
	await fs.appendFile(filePath, line, 'utf-8');
}

/**
 * Get recent security events from the buffer with pagination support.
 *
 * @param limit - Maximum number of events to return (default: 50)
 * @param offset - Number of events to skip (default: 0)
 * @returns Page of events sorted by timestamp descending (most recent first)
 */
export function getRecentEvents(limit: number = 50, offset: number = 0): SecurityEventsPage {
	// Get all events sorted by timestamp descending
	const sortedEvents = [...eventsBuffer].sort((a, b) => b.timestamp - a.timestamp);

	const total = sortedEvents.length;
	const start = Math.min(offset, total);
	const end = Math.min(offset + limit, total);
	const events = sortedEvents.slice(start, end);

	return {
		events,
		total,
		hasMore: end < total,
	};
}

/**
 * Get all events from the buffer (for export or debugging)
 */
export function getAllEvents(): SecurityEvent[] {
	return [...eventsBuffer].sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Get events filtered by type
 */
export function getEventsByType(eventType: SecurityEventType, limit: number = 50): SecurityEvent[] {
	return [...eventsBuffer]
		.filter((event) => event.eventType === eventType)
		.sort((a, b) => b.timestamp - a.timestamp)
		.slice(0, limit);
}

/**
 * Get events for a specific session
 */
export function getEventsBySession(sessionId: string, limit: number = 50): SecurityEvent[] {
	return [...eventsBuffer]
		.filter((event) => event.sessionId === sessionId)
		.sort((a, b) => b.timestamp - a.timestamp)
		.slice(0, limit);
}

/**
 * Clear all events from the in-memory buffer.
 * Does NOT clear the persisted file.
 */
export function clearEvents(): void {
	eventsBuffer = [];
	bufferIndex = 0;
	totalEventsLogged = 0;
}

/**
 * Clear both in-memory buffer and persisted file.
 */
export async function clearAllEvents(): Promise<void> {
	clearEvents();

	try {
		const filePath = getSecurityEventsPath();
		await fs.writeFile(filePath, '', 'utf-8');
	} catch (error) {
		// Ignore file errors (file may not exist)
	}
}

/**
 * Subscribe to real-time security events.
 *
 * @param listener - Callback invoked when a new event is logged
 * @returns Unsubscribe function
 */
export function subscribeToEvents(listener: SecurityEventListener): () => void {
	eventListeners.add(listener);
	return () => {
		eventListeners.delete(listener);
	};
}

/**
 * Get statistics about the event buffer
 */
export function getEventStats(): {
	bufferSize: number;
	totalLogged: number;
	maxSize: number;
} {
	return {
		bufferSize: eventsBuffer.length,
		totalLogged: totalEventsLogged,
		maxSize: MAX_EVENTS,
	};
}

/**
 * Load events from the persisted file into the buffer.
 * Called during app startup if persistence is enabled.
 *
 * @param maxToLoad - Maximum number of events to load (default: MAX_EVENTS)
 */
export async function loadEventsFromFile(maxToLoad: number = MAX_EVENTS): Promise<number> {
	try {
		const filePath = getSecurityEventsPath();
		const content = await fs.readFile(filePath, 'utf-8');

		if (!content.trim()) {
			return 0;
		}

		const lines = content.trim().split('\n');
		const events: SecurityEvent[] = [];

		// Parse lines from newest to oldest (file is append-only, so newest are at end)
		for (let i = lines.length - 1; i >= 0 && events.length < maxToLoad; i--) {
			const line = lines[i].trim();
			if (!line) continue;

			try {
				const event = JSON.parse(line) as SecurityEvent;
				events.push(event);
			} catch {
				// Skip malformed lines
			}
		}

		// Reverse to maintain chronological order in buffer
		events.reverse();

		// Load into buffer
		eventsBuffer = events;
		bufferIndex = events.length % MAX_EVENTS;
		totalEventsLogged = events.length;

		return events.length;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			// File doesn't exist yet, that's fine
			return 0;
		}
		throw error;
	}
}

/**
 * Export filter options for audit log export
 */
export interface ExportFilterOptions {
	/** Start date filter (Unix timestamp in milliseconds) */
	startDate?: number;
	/** End date filter (Unix timestamp in milliseconds) */
	endDate?: number;
	/** Filter by event types */
	eventTypes?: SecurityEventType[];
	/** Filter by session IDs */
	sessionIds?: string[];
	/** Minimum confidence level for findings (0-1) */
	minConfidence?: number;
}

/**
 * Export format types
 */
export type ExportFormat = 'json' | 'csv' | 'html';

/**
 * Apply filter options to events
 */
function filterEvents(events: SecurityEvent[], filters: ExportFilterOptions): SecurityEvent[] {
	let filtered = [...events];

	if (filters.startDate) {
		filtered = filtered.filter((e) => e.timestamp >= filters.startDate!);
	}

	if (filters.endDate) {
		filtered = filtered.filter((e) => e.timestamp <= filters.endDate!);
	}

	if (filters.eventTypes && filters.eventTypes.length > 0) {
		filtered = filtered.filter((e) => filters.eventTypes!.includes(e.eventType));
	}

	if (filters.sessionIds && filters.sessionIds.length > 0) {
		filtered = filtered.filter((e) => filters.sessionIds!.includes(e.sessionId));
	}

	if (filters.minConfidence !== undefined) {
		filtered = filtered.filter((e) =>
			e.findings.some((f) => f.confidence >= filters.minConfidence!)
		);
	}

	return filtered;
}

/**
 * Escape CSV field value
 */
function escapeCsvField(value: string): string {
	if (value.includes(',') || value.includes('"') || value.includes('\n')) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

/**
 * Export events to JSON format
 */
export function exportToJson(filters: ExportFilterOptions = {}): string {
	const events = filterEvents(getAllEvents(), filters);

	const exportData = {
		exportedAt: new Date().toISOString(),
		totalEvents: events.length,
		filters: {
			startDate: filters.startDate ? new Date(filters.startDate).toISOString() : null,
			endDate: filters.endDate ? new Date(filters.endDate).toISOString() : null,
			eventTypes: filters.eventTypes || null,
			sessionIds: filters.sessionIds || null,
			minConfidence: filters.minConfidence ?? null,
		},
		events,
	};

	return JSON.stringify(exportData, null, 2);
}

/**
 * Export events to CSV format
 */
export function exportToCsv(filters: ExportFilterOptions = {}): string {
	const events = filterEvents(getAllEvents(), filters);

	// CSV header
	const headers = [
		'ID',
		'Timestamp',
		'Date/Time',
		'Session ID',
		'Tab ID',
		'Event Type',
		'Action',
		'Finding Count',
		'Finding Types',
		'Max Confidence',
		'Original Length',
		'Sanitized Length',
		'Group Chat ID',
		'Source Agent',
		'Target Agent',
	];

	const rows = events.map((event) => {
		const findingTypes = [...new Set(event.findings.map((f) => f.type))].join('; ');
		const maxConfidence =
			event.findings.length > 0
				? Math.max(...event.findings.map((f) => f.confidence)).toFixed(2)
				: '';

		return [
			event.id,
			event.timestamp.toString(),
			new Date(event.timestamp).toISOString(),
			event.sessionId,
			event.tabId || '',
			event.eventType,
			event.action,
			event.findings.length.toString(),
			findingTypes,
			maxConfidence,
			event.originalLength.toString(),
			event.sanitizedLength.toString(),
			event.groupChatId || '',
			event.sourceAgent || '',
			event.targetAgent || '',
		].map(escapeCsvField);
	});

	return [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

/**
 * Export events to HTML format (formatted report)
 */
export function exportToHtml(filters: ExportFilterOptions = {}): string {
	const events = filterEvents(getAllEvents(), filters);

	// Calculate statistics
	const stats = {
		totalEvents: events.length,
		blocked: events.filter((e) => e.action === 'blocked').length,
		warned: events.filter((e) => e.action === 'warned').length,
		sanitized: events.filter((e) => e.action === 'sanitized').length,
		inputScans: events.filter((e) => e.eventType === 'input_scan').length,
		outputScans: events.filter((e) => e.eventType === 'output_scan').length,
		interAgentScans: events.filter((e) => e.eventType === 'inter_agent_scan').length,
	};

	// Group findings by type
	const findingTypeStats: Record<string, number> = {};
	for (const event of events) {
		for (const finding of event.findings) {
			findingTypeStats[finding.type] = (findingTypeStats[finding.type] || 0) + 1;
		}
	}

	// Format timestamp for display
	const formatTime = (timestamp: number) => new Date(timestamp).toLocaleString();

	// Build event rows
	const eventRows = events
		.map((event) => {
			const findingsHtml =
				event.findings.length > 0
					? event.findings
							.map(
								(f) => `
						<div class="finding">
							<span class="finding-type">${escapeHtml(f.type)}</span>
							<span class="finding-confidence">${(f.confidence * 100).toFixed(0)}%</span>
							<div class="finding-value">${escapeHtml(f.value.substring(0, 100))}${f.value.length > 100 ? '...' : ''}</div>
							${f.replacement ? `<div class="finding-replacement">→ ${escapeHtml(f.replacement)}</div>` : ''}
						</div>
					`
							)
							.join('')
					: '<span class="no-findings">No findings</span>';

			const actionClass =
				event.action === 'blocked'
					? 'action-blocked'
					: event.action === 'warned'
						? 'action-warned'
						: event.action === 'sanitized'
							? 'action-sanitized'
							: '';

			return `
				<tr class="event-row">
					<td class="timestamp">${formatTime(event.timestamp)}</td>
					<td class="event-type">${escapeHtml(event.eventType)}</td>
					<td class="session-id">${escapeHtml(event.sessionId.split('-')[0])}</td>
					<td class="action ${actionClass}">${escapeHtml(event.action)}</td>
					<td class="findings-cell">${findingsHtml}</td>
				</tr>
			`;
		})
		.join('');

	// Finding type stats table
	const findingTypeRows = Object.entries(findingTypeStats)
		.sort(([, a], [, b]) => b - a)
		.map(
			([type, count]) => `
			<tr>
				<td>${escapeHtml(type)}</td>
				<td>${count}</td>
			</tr>
		`
		)
		.join('');

	// Filter description
	const filterDescription = [];
	if (filters.startDate) {
		filterDescription.push(`From: ${new Date(filters.startDate).toLocaleDateString()}`);
	}
	if (filters.endDate) {
		filterDescription.push(`To: ${new Date(filters.endDate).toLocaleDateString()}`);
	}
	if (filters.eventTypes && filters.eventTypes.length > 0) {
		filterDescription.push(`Event Types: ${filters.eventTypes.join(', ')}`);
	}
	if (filters.sessionIds && filters.sessionIds.length > 0) {
		filterDescription.push(`Sessions: ${filters.sessionIds.length} selected`);
	}
	if (filters.minConfidence !== undefined) {
		filterDescription.push(`Min Confidence: ${(filters.minConfidence * 100).toFixed(0)}%`);
	}

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>LLM Guard Security Audit Log - Maestro</title>
	<style>
		:root {
			--bg-primary: #1a1b26;
			--bg-secondary: #24283b;
			--bg-tertiary: #1f2335;
			--text-primary: #c0caf5;
			--text-secondary: #9aa5ce;
			--text-dim: #565f89;
			--border: #3b4261;
			--accent: #7aa2f7;
			--success: #9ece6a;
			--warning: #e0af68;
			--error: #f7768e;
		}

		* {
			box-sizing: border-box;
			margin: 0;
			padding: 0;
		}

		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
			background-color: var(--bg-primary);
			color: var(--text-primary);
			line-height: 1.6;
			padding: 2rem;
		}

		.container {
			max-width: 1200px;
			margin: 0 auto;
		}

		.header {
			text-align: center;
			margin-bottom: 2rem;
			padding-bottom: 1.5rem;
			border-bottom: 1px solid var(--border);
		}

		.header h1 {
			font-size: 1.75rem;
			font-weight: 600;
			margin-bottom: 0.5rem;
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 0.5rem;
		}

		.header h1 .shield-icon {
			font-size: 1.5rem;
		}

		.subtitle {
			color: var(--text-secondary);
			font-size: 0.875rem;
		}

		.filters-applied {
			background-color: var(--bg-tertiary);
			border-radius: 0.5rem;
			padding: 0.75rem 1rem;
			margin-bottom: 1.5rem;
			font-size: 0.875rem;
			color: var(--text-secondary);
		}

		.stats-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
			gap: 1rem;
			margin-bottom: 2rem;
		}

		.stat-card {
			background-color: var(--bg-secondary);
			border-radius: 0.5rem;
			padding: 1rem;
			text-align: center;
			border: 1px solid var(--border);
		}

		.stat-value {
			font-size: 1.75rem;
			font-weight: 700;
			color: var(--text-primary);
		}

		.stat-value.blocked { color: var(--error); }
		.stat-value.warned { color: var(--warning); }
		.stat-value.sanitized { color: var(--accent); }

		.stat-label {
			font-size: 0.75rem;
			color: var(--text-secondary);
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.section {
			margin-bottom: 2rem;
		}

		.section-title {
			font-size: 1rem;
			font-weight: 600;
			color: var(--text-secondary);
			margin-bottom: 1rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		table {
			width: 100%;
			border-collapse: collapse;
			font-size: 0.875rem;
		}

		th, td {
			padding: 0.75rem;
			text-align: left;
			border-bottom: 1px solid var(--border);
		}

		th {
			background-color: var(--bg-secondary);
			font-weight: 600;
			color: var(--text-secondary);
			text-transform: uppercase;
			font-size: 0.75rem;
			letter-spacing: 0.05em;
		}

		tr:hover {
			background-color: var(--bg-tertiary);
		}

		.event-row .timestamp {
			white-space: nowrap;
			font-family: 'SF Mono', Monaco, monospace;
			font-size: 0.8rem;
			color: var(--text-dim);
		}

		.event-row .session-id {
			font-family: 'SF Mono', Monaco, monospace;
			text-transform: uppercase;
		}

		.event-row .event-type {
			text-transform: uppercase;
			font-size: 0.75rem;
			font-weight: 600;
		}

		.action {
			text-transform: uppercase;
			font-size: 0.75rem;
			font-weight: 600;
			padding: 0.25rem 0.5rem;
			border-radius: 0.25rem;
		}

		.action-blocked { background-color: rgba(247, 118, 142, 0.2); color: var(--error); }
		.action-warned { background-color: rgba(224, 175, 104, 0.2); color: var(--warning); }
		.action-sanitized { background-color: rgba(122, 162, 247, 0.2); color: var(--accent); }

		.findings-cell {
			max-width: 400px;
		}

		.finding {
			background-color: var(--bg-tertiary);
			border-radius: 0.25rem;
			padding: 0.5rem;
			margin-bottom: 0.25rem;
			font-size: 0.8rem;
		}

		.finding-type {
			font-weight: 600;
			color: var(--accent);
			text-transform: uppercase;
		}

		.finding-confidence {
			color: var(--text-dim);
			margin-left: 0.5rem;
		}

		.finding-value {
			font-family: 'SF Mono', Monaco, monospace;
			color: var(--error);
			text-decoration: line-through;
			margin-top: 0.25rem;
			word-break: break-all;
		}

		.finding-replacement {
			font-family: 'SF Mono', Monaco, monospace;
			color: var(--success);
			margin-top: 0.25rem;
		}

		.no-findings {
			color: var(--text-dim);
			font-style: italic;
		}

		.footer {
			margin-top: 3rem;
			padding-top: 1.5rem;
			border-top: 1px solid var(--border);
			text-align: center;
			color: var(--text-dim);
			font-size: 0.75rem;
		}

		.footer a {
			color: var(--accent);
			text-decoration: none;
		}

		.footer a:hover {
			text-decoration: underline;
		}

		@media print {
			body {
				background-color: white;
				color: black;
			}

			.stat-card, .finding {
				background-color: #f5f5f5;
			}
		}

		@media (max-width: 768px) {
			body { padding: 1rem; }
			.stats-grid { grid-template-columns: repeat(2, 1fr); }
			table { font-size: 0.75rem; }
			th, td { padding: 0.5rem; }
		}
	</style>
</head>
<body>
	<div class="container">
		<header class="header">
			<h1><span class="shield-icon">🛡️</span> LLM Guard Security Audit Log</h1>
			<p class="subtitle">Generated on ${new Date().toLocaleString()}</p>
		</header>

		${
			filterDescription.length > 0
				? `<div class="filters-applied"><strong>Filters Applied:</strong> ${filterDescription.join(' | ')}</div>`
				: ''
		}

		<div class="stats-grid">
			<div class="stat-card">
				<div class="stat-value">${stats.totalEvents}</div>
				<div class="stat-label">Total Events</div>
			</div>
			<div class="stat-card">
				<div class="stat-value blocked">${stats.blocked}</div>
				<div class="stat-label">Blocked</div>
			</div>
			<div class="stat-card">
				<div class="stat-value warned">${stats.warned}</div>
				<div class="stat-label">Warned</div>
			</div>
			<div class="stat-card">
				<div class="stat-value sanitized">${stats.sanitized}</div>
				<div class="stat-label">Sanitized</div>
			</div>
			<div class="stat-card">
				<div class="stat-value">${stats.inputScans}</div>
				<div class="stat-label">Input Scans</div>
			</div>
			<div class="stat-card">
				<div class="stat-value">${stats.outputScans}</div>
				<div class="stat-label">Output Scans</div>
			</div>
			<div class="stat-card">
				<div class="stat-value">${stats.interAgentScans}</div>
				<div class="stat-label">Inter-Agent Scans</div>
			</div>
		</div>

		${
			Object.keys(findingTypeStats).length > 0
				? `
		<section class="section">
			<h2 class="section-title">Findings by Type</h2>
			<table>
				<thead>
					<tr>
						<th>Finding Type</th>
						<th>Count</th>
					</tr>
				</thead>
				<tbody>
					${findingTypeRows}
				</tbody>
			</table>
		</section>
		`
				: ''
		}

		<section class="section">
			<h2 class="section-title">Event Log (${events.length} events)</h2>
			${
				events.length > 0
					? `
			<table>
				<thead>
					<tr>
						<th>Timestamp</th>
						<th>Event Type</th>
						<th>Session</th>
						<th>Action</th>
						<th>Findings</th>
					</tr>
				</thead>
				<tbody>
					${eventRows}
				</tbody>
			</table>
			`
					: '<p class="no-findings">No events match the specified filters.</p>'
			}
		</section>

		<footer class="footer">
			<p>Exported from <a href="https://runmaestro.ai" target="_blank">Maestro</a> - LLM Guard Security Module</p>
		</footer>
	</div>
</body>
</html>`;
}

/**
 * Export security events in the specified format
 */
export function exportSecurityEvents(
	format: ExportFormat,
	filters: ExportFilterOptions = {}
): string {
	switch (format) {
		case 'json':
			return exportToJson(filters);
		case 'csv':
			return exportToCsv(filters);
		case 'html':
			return exportToHtml(filters);
		default:
			throw new Error(`Unsupported export format: ${format}`);
	}
}

/**
 * Get unique session IDs from events (for filter UI)
 */
export function getUniqueSessionIds(): string[] {
	const sessionIds = new Set<string>();
	for (const event of eventsBuffer) {
		sessionIds.add(event.sessionId);
	}
	return [...sessionIds].sort();
}

// Export for testing
export { MAX_EVENTS };
