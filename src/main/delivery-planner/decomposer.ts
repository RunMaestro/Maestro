import type { WorkItemCreateInput } from '../../shared/work-graph-types';
import { DeliveryPlannerValidationError } from './planner-service';
import { slugifyCcpmSegment } from './path-resolver';
import {
	parseDeliveryPlannerStructuredOutput,
	type DeliveryPlannerStructuredDecomposition,
} from './structured-output';

export interface DeliveryPlannerTaskDraft {
	title: string;
	description?: string;
	acceptanceCriteria?: string[];
	filesLikelyTouched?: string[];
	dependsOnTaskTitles?: string[];
	integrationRisks?: string[];
	parallel?: boolean;
	tags?: string[];
	capabilities?: string[];
	priority?: number;
}

export interface DeliveryPlannerDecompositionRequest {
	epicTitle: string;
	epicDescription?: string;
	projectPath: string;
	gitPath: string;
	parentWorkItemId: string;
}

export interface DeliveryPlannerDecompositionResult {
	tasks: DeliveryPlannerTaskDraft[];
}

export interface DeliveryPlannerDecompositionGateway {
	decomposeEpic(
		request: DeliveryPlannerDecompositionRequest
	): Promise<DeliveryPlannerDecompositionResult>;
}

export class DeliveryPlannerDecomposer {
	constructor(private readonly gateway: DeliveryPlannerDecompositionGateway) {}

	async draftTasks(request: DeliveryPlannerDecompositionRequest): Promise<WorkItemCreateInput[]> {
		const result = await this.gateway.decomposeEpic(request);
		if (!Array.isArray(result.tasks) || result.tasks.length === 0) {
			throw new DeliveryPlannerValidationError('Epic decomposition must return at least one task');
		}

		const epicSlug = slugifyCcpmSegment(request.epicTitle);
		const titleToTempId = new Map<string, string>();
		result.tasks.forEach((task, index) => {
			const title = task.title?.trim();
			if (!title) {
				throw new DeliveryPlannerValidationError(`Decomposed task ${index + 1} is missing a title`);
			}

			titleToTempId.set(title, `draft-${index + 1}`);
		});
		validateDependencies(result.tasks, titleToTempId);
		validateParallelFileConflicts(result.tasks);

		return result.tasks.map((task, index) => ({
			type: 'task',
			status: 'planned',
			title: task.title.trim(),
			description: renderTaskDescription(task),
			parentWorkItemId: request.parentWorkItemId,
			projectPath: request.projectPath,
			gitPath: request.gitPath,
			source: 'delivery-planner',
			readonly: false,
			tags: uniqueTags(['delivery-planner', ...(task.tags ?? [])]),
			capabilities: task.capabilities,
			priority: task.priority,
			metadata: {
				parentWorkItemId: request.parentWorkItemId,
				kind: 'task',
				ccpmSlug: epicSlug,
				ccpmTaskId: index + 1,
				acceptanceCriteria: task.acceptanceCriteria ?? [],
				filesLikelyTouched: task.filesLikelyTouched ?? [],
				integrationRisks: task.integrationRisks ?? [],
				parallel: task.parallel ?? true,
				dependsOnTaskTitles: task.dependsOnTaskTitles ?? [],
				dependsOnDraftIds: (task.dependsOnTaskTitles ?? [])
					.map((title) => titleToTempId.get(title))
					.filter((id): id is string => Boolean(id)),
			},
		}));
	}
}

export class StructuredDeliveryPlannerDecompositionGateway implements DeliveryPlannerDecompositionGateway {
	async decomposeEpic(
		request: DeliveryPlannerDecompositionRequest
	): Promise<DeliveryPlannerStructuredDecomposition> {
		return parseDeliveryPlannerStructuredOutput(buildDeterministicDecomposition(request));
	}
}

const uniqueTags = (tags: string[]) => [...new Set(tags.filter(Boolean))];

function validateDependencies(
	tasks: DeliveryPlannerTaskDraft[],
	titleToTempId: Map<string, string>
): void {
	const graph = new Map<string, string[]>();
	for (const task of tasks) {
		const title = task.title.trim();
		const dependencies = task.dependsOnTaskTitles ?? [];
		for (const dependencyTitle of dependencies) {
			if (!titleToTempId.has(dependencyTitle)) {
				throw new DeliveryPlannerValidationError(
					`Task "${title}" depends on unknown task "${dependencyTitle}"`
				);
			}
		}
		graph.set(title, dependencies);
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (title: string): void => {
		if (visited.has(title)) {
			return;
		}
		if (visiting.has(title)) {
			throw new DeliveryPlannerValidationError(`Task dependency cycle detected at "${title}"`);
		}

		visiting.add(title);
		for (const dependencyTitle of graph.get(title) ?? []) {
			visit(dependencyTitle);
		}
		visiting.delete(title);
		visited.add(title);
	};

	for (const title of graph.keys()) {
		visit(title);
	}
}

function validateParallelFileConflicts(tasks: DeliveryPlannerTaskDraft[]): void {
	const fileOwners = new Map<string, string>();
	for (const task of tasks) {
		if (task.parallel === false) {
			continue;
		}

		for (const filePath of task.filesLikelyTouched ?? []) {
			const owner = fileOwners.get(filePath);
			if (owner) {
				throw new DeliveryPlannerValidationError(
					`Parallel task file conflict: "${task.title}" and "${owner}" both touch ${filePath}`
				);
			}
			fileOwners.set(filePath, task.title);
		}
	}
}

function renderTaskDescription(task: DeliveryPlannerTaskDraft): string | undefined {
	const sections: string[] = [];
	if (task.description?.trim()) {
		sections.push(task.description.trim());
	}

	appendListSection(sections, 'Acceptance Criteria', task.acceptanceCriteria);
	appendListSection(sections, 'Files Likely Touched', task.filesLikelyTouched);
	appendListSection(sections, 'Dependencies', task.dependsOnTaskTitles);
	appendListSection(sections, 'Integration Risks', task.integrationRisks);

	return sections.length ? sections.join('\n\n') : undefined;
}

function appendListSection(
	sections: string[],
	heading: string,
	values: string[] | undefined
): void {
	if (!values?.length) {
		return;
	}

	sections.push(`## ${heading}\n\n${values.map((value) => `- ${value}`).join('\n')}`);
}

function buildDeterministicDecomposition(
	request: DeliveryPlannerDecompositionRequest
): DeliveryPlannerStructuredDecomposition {
	const filesLikelyTouched = extractLikelyFiles(request.epicDescription).slice(0, 6);

	return {
		tasks: [
			{
				title: `Design ${request.epicTitle}`,
				description:
					'Finalize architecture decisions, dependency boundaries, and implementation strategy.',
				acceptanceCriteria: [
					'Architecture decisions and sequencing are documented.',
					'Work Graph dependencies and CCPM mirror expectations are confirmed.',
				],
				filesLikelyTouched,
				integrationRisks: ['Incorrect sequencing can create blocked downstream tasks.'],
				parallel: true,
				tags: ['task-preview'],
				priority: 1,
			},
			{
				title: `Implement ${request.epicTitle}`,
				description: 'Build the scoped workflow changes and persist concrete task metadata.',
				acceptanceCriteria: [
					'Implementation creates concrete Work Graph items with dependency metadata.',
					'Generated CCPM mirrors include task acceptance criteria and risk notes.',
				],
				dependsOnTaskTitles: [`Design ${request.epicTitle}`],
				integrationRisks: ['Generated tasks must remain parseable and deterministic.'],
				parallel: false,
				tags: ['implementation'],
				priority: 2,
			},
			{
				title: `Validate ${request.epicTitle}`,
				description: 'Run targeted checks and verify dependency previews before handoff.',
				acceptanceCriteria: [
					'Targeted tests or type checks pass.',
					'Dependency previews are deterministic before tasks are committed.',
				],
				dependsOnTaskTitles: [`Implement ${request.epicTitle}`],
				integrationRisks: [
					'Validation must catch dependency cycles and unsafe parallel file overlap.',
				],
				parallel: false,
				tags: ['validation'],
				priority: 3,
			},
		],
	};
}

function extractLikelyFiles(description: string | undefined): string[] {
	if (!description) {
		return [];
	}

	const matches = description.match(/`([^`]+\.[a-zA-Z0-9]+)`/g) ?? [];
	return [...new Set(matches.map((match) => match.slice(1, -1)))];
}
