import { generateUUID } from '../../uuid';
import { canonicalJson } from '../../canonicalJson';
import { translationHash } from './identity';
import { encodeGrokCwdDirname } from './native-records';
import type {
	TranslationAdapter,
	TranslationIdentity,
	TranslationPlan,
	TranslationScope,
	PortableConversation,
	TranslationLimitation,
	TranslationDirection,
	TranslationArtifact,
	PortableRecord,
} from './types';

/** Records a native stage writes: user and assistant rows, never sidechains. */
function isProjectedRecord(record: PortableRecord): boolean {
	return (
		(record.role === 'user' || record.role === 'assistant') &&
		!(record.native as { isSidechain?: boolean } | undefined)?.isSidechain
	);
}

/**
 * What a Grok destination cannot carry. Grok's
 * `ContentPart` has only text and image, its tool result has no error flag, its
 * rows have no timestamps, and the stage writes only the transcript and summary.
 */
function grokDestinationLimitations(
	destination: TranslationIdentity,
	conversations: PortableConversation[]
): TranslationLimitation[] {
	const limitations: TranslationLimitation[] = [];
	for (const conversation of conversations) {
		const tabId = conversation.tabId;
		const records = conversation.records.filter(isProjectedRecord);
		const blocks = records.flatMap((record) => record.blocks.map((block) => ({ record, block })));
		for (const { record, block } of blocks)
			if (
				block.kind === 'attachment' &&
				record.role === 'user' &&
				!/^image\/[A-Za-z0-9.+-]+$/.test(block.mediaType)
			)
				limitations.push({
					code: 'unsupported-attachment-type',
					severity: 'block',
					tabId,
					artifactId: block.artifactId,
					message: `Grok messages carry only text and images; the ${block.mediaType} attachment cannot be written.`,
				});
		if (blocks.some(({ block }) => block.kind === 'tool-call' && block.custom))
			limitations.push({
				code: 'custom-tool-flattened',
				severity: 'warning',
				tabId,
				message:
					'Custom tool calls are written as ordinary Grok tool calls with their raw input as arguments.',
			});
		if (blocks.some(({ block }) => block.kind === 'tool-result' && block.isError))
			limitations.push({
				code: 'tool-error-flag-lost',
				severity: 'warning',
				tabId,
				message:
					'Grok tool results have no error flag. Failed tool results keep their text, but are not marked as errors.',
			});
		if (records.some((record) => record.timestamp))
			limitations.push({
				code: 'source-timestamps-dropped',
				severity: 'warning',
				tabId,
				message:
					'Grok history rows have no timestamps; the original message times are not carried.',
			});
	}
	if (encodeGrokCwdDirname(destination.projectRoot) === null)
		limitations.push({
			code: 'grok-long-cwd-unsupported',
			severity: 'block',
			message:
				'Grok stores this project under a hashed folder name that Maestro does not reproduce.',
		});
	limitations.push(
		{
			code: 'grok-native-replay-absent',
			severity: 'warning',
			message:
				"Grok's own screen replay of the carried turns may be empty: only the model history and summary are written, not its UI update stream.",
		},
		{
			code: 'grok-search-index-unaffected',
			severity: 'warning',
			message: "Grok's session search may not find the carried session until Grok reindexes it.",
		},
		{
			code: 'grok-remote-session-sync-unverified',
			severity: 'warning',
			message:
				'A Grok account configured for remote session storage may upload the carried session after resume; this is unverified.',
		}
	);
	return limitations;
}

export class TranslationRegistry {
	private readonly adapters = new Map<string, TranslationAdapter>();
	private readonly directions: TranslationDirection[] = [];
	register(adapter: TranslationAdapter): void {
		if (this.adapters.has(adapter.provider))
			throw new Error(`Translation adapter already registered: ${adapter.provider}`);
		this.adapters.set(adapter.provider, adapter);
	}
	get(provider: string): TranslationAdapter | undefined {
		return this.adapters.get(provider);
	}
	declareDirection(direction: TranslationDirection): void {
		if (
			direction.verification === 'verified' &&
			(!direction.evidence?.nativeResume ||
				!direction.evidence.roundTrip ||
				!direction.evidence.resources ||
				!direction.evidence.payloadClasses.length)
		)
			throw new Error(
				'Native translation certification requires resume, round-trip and resource evidence'
			);
		this.directions.push(direction);
	}
	direction(
		source: TranslationIdentity,
		destination: TranslationIdentity
	): TranslationDirection | undefined {
		return this.directions.find(
			(d) =>
				d.source === source.provider &&
				d.destination === destination.provider &&
				d.sourceVersions.includes(source.version) &&
				d.destinationVersions.includes(destination.version)
		);
	}
}

export function planTranslation(options: {
	agentId: string;
	source: TranslationIdentity;
	destination: TranslationIdentity;
	scope: TranslationScope;
	conversations: PortableConversation[];
	registry: TranslationRegistry;
	busy?: boolean;
	limitations?: TranslationLimitation[];
	newRecords?: Record<string, number>;
	resources?: TranslationArtifact[];
}): TranslationPlan {
	const { source, destination, registry, conversations } = options;
	const noop =
		source.provider === destination.provider && source.accountRoot === destination.accountRoot;
	const direction = registry.direction(source, destination);
	const payloadClasses = new Set<string>();
	for (const conversation of conversations) {
		for (const artifact of conversation.artifacts) payloadClasses.add(artifact.kind);
		for (const record of conversation.records) {
			if (record.role) payloadClasses.add('conversation');
			if (record.boundary) payloadClasses.add(record.boundary);
			if (record.branchId || (record.native as { isSidechain?: boolean } | undefined)?.isSidechain)
				payloadClasses.add('branch');
			for (const block of record.blocks) if (block.kind !== 'text') payloadClasses.add(block.kind);
		}
	}
	for (const resource of options.resources ?? []) payloadClasses.add(resource.kind);
	const limitations: TranslationLimitation[] = noop
		? []
		: [...(options.limitations ?? []), ...conversations.flatMap((c) => c.limitations)];
	if (!noop) {
		if (destination.provider === 'codex' || destination.provider === 'grok')
			for (const conversation of conversations) {
				if (
					conversation.records.some(
						(record) =>
							record.role === 'assistant' &&
							record.blocks.some((block) => block.kind === 'attachment')
					)
				)
					limitations.push({
						code: 'assistant-attachment-projection',
						severity: 'warning',
						tabId: conversation.tabId,
						message:
							destination.provider === 'codex'
								? 'Assistant image output is preserved in the archive but is not projected into Codex assistant Responses messages.'
								: 'Assistant image output is preserved in the archive but is not projected: Grok assistant messages have no image field.',
					});
			}
		if (destination.provider === 'grok')
			limitations.push(...grokDestinationLimitations(destination, conversations));
		if (destination.provider === 'claude-code')
			for (const conversation of conversations)
				if (conversation.records.some((record) => isProjectedRecord(record) && !record.timestamp))
					limitations.push({
						code: 'synthetic-timestamps',
						severity: 'warning',
						tabId: conversation.tabId,
						message:
							'Some source messages have no recorded time; the destination shows the migration time for them, not when they were written.',
					});
		for (const identity of [source, destination]) {
			const adapter = registry.get(identity.provider);
			if (!adapter)
				limitations.push({
					code: 'unsupported-provider',
					severity: 'block',
					message: `No translation adapter for ${identity.provider}. Native resume support is separate.`,
				});
			else if (!adapter.versions.includes(identity.version))
				limitations.push({
					code: 'unknown-version',
					severity: 'block',
					message: `${identity.provider} ${identity.version || 'unknown'} has no declared schema mapping.`,
				});
		}
		if (!direction)
			limitations.push({
				code: 'unsupported-direction',
				severity: 'block',
				message: 'This direction/version pair has no declared translation contract.',
			});
		if (direction?.verification === 'verified') {
			const uncovered = [...payloadClasses].filter(
				(kind) => !direction.evidence?.payloadClasses.includes(kind)
			);
			if (uncovered.length)
				limitations.push({
					code: 'uncertified-payload',
					severity: 'warning',
					message: `Native acceptance evidence does not cover selected payload classes: ${uncovered.join(', ')}.`,
				});
		}
		if (direction?.verification !== 'verified')
			limitations.push({
				code: 'unverified-native-resume',
				severity: 'warning',
				message: `${source.provider} -> ${destination.provider} native resume and repeated round-trip continuity have not been verified.`,
			});
	}
	const unique = [...new Map(limitations.map((l) => [canonicalJson(l), l])).values()];
	const artifacts = [...conversations.flatMap((c) => c.artifacts), ...(options.resources ?? [])];
	return {
		schemaVersion: 1,
		id: generateUUID(),
		agentId: options.agentId,
		source,
		destination,
		scope: options.scope,
		status: noop
			? 'noop'
			: unique.some((l) => l.severity === 'block')
				? 'blocked'
				: options.busy
					? 'deferred'
					: 'ready',
		verification:
			direction?.verification === 'verified' && unique.length === 0 ? 'verified' : 'unverified',
		limitations: unique,
		tabs: conversations.map((c) => ({
			tabId: c.tabId,
			sourceSessionId: c.nativeSessionId,
			records: c.records.length,
			newRecords: options.newRecords?.[c.tabId] ?? c.records.length,
		})),
		counts: {
			records: conversations.reduce((n, c) => n + c.records.length, 0),
			artifacts: artifacts.length,
			bytes: artifacts.reduce((n, a) => n + Buffer.from(a.bytesBase64, 'base64').length, 0),
		},
		fingerprint: translationHash(
			canonicalJson({
				source,
				destination,
				scope: options.scope,
				conversations,
				resources: options.resources ?? [],
				limitations: unique,
			})
		),
	};
}
