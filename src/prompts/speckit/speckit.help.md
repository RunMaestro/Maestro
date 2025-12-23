# Spec-Kit Help

You are explaining how to use **Spec-Kit** within Maestro. Spec-Kit is a structured specification workflow from [GitHub's spec-kit project](https://github.com/github/spec-kit) that helps teams create clear, actionable specifications before implementation.

## What is Spec-Kit?

Spec-Kit provides a set of AI-powered commands that guide you through a structured approach to software specification:

1. **Define principles** - Establish your project's core values and constraints
2. **Specify features** - Create detailed, unambiguous feature specifications
3. **Clarify gaps** - Identify and resolve underspecified areas
4. **Plan implementation** - Break specifications into actionable plans
5. **Generate tasks** - Convert plans into dependency-ordered tasks
6. **Execute with Auto Run** - Use Maestro's Auto Run to implement tasks

## Core Workflow (Recommended Order)

### 1. `/speckit.constitution` - Define Project Principles
Start here to establish your project's foundational values, constraints, and guidelines. This creates a constitution that guides all subsequent specifications.

### 2. `/speckit.specify` - Create Feature Specification
Define the feature you want to build with clear requirements, acceptance criteria, and boundaries.

### 3. `/speckit.clarify` - Identify Gaps
Review your specification for ambiguities, missing details, and edge cases. The AI will ask clarifying questions to strengthen the spec.

### 4. `/speckit.plan` - Implementation Planning
Convert your specification into a high-level implementation plan with phases and milestones.

### 5. `/speckit.tasks` - Generate Tasks
Break your plan into specific, actionable tasks with dependencies clearly mapped.

### 6. `/speckit.implement` - Execute with Maestro Auto Run
**Maestro-specific command.** Converts your tasks into Auto Run documents that Maestro can execute autonomously. This integrates spec-kit's structured approach with Maestro's multi-agent capabilities.

## Optional Commands

### `/speckit.analyze` - Quality Analysis
Cross-artifact consistency and quality analysis. Use this to verify your specifications are coherent and complete.

### `/speckit.checklist` - Generate Checklist
Create a custom checklist for your feature based on the specification. Useful for QA and review processes.

### `/speckit.taskstoissues` - Export to GitHub Issues
Convert your tasks directly into GitHub issues. Useful for team collaboration and project tracking.

## Integration with Maestro Auto Run

Spec-Kit is designed to work seamlessly with Maestro's Auto Run feature:

1. **Use `/speckit.implement`** to generate Auto Run documents from your tasks
2. Documents are saved to `Auto Run Docs/` in your project
3. Each task becomes a checkbox item that Auto Run can execute and verify
4. Maestro will work through tasks sequentially, checking them off as completed
5. You can run multiple agents in parallel on different phases

## Tips for Best Results

- **Start with constitution** - Even for small projects, defining principles helps maintain consistency
- **Iterate on specifications** - Use `/speckit.clarify` multiple times to refine your spec
- **Keep specs focused** - One feature per specification cycle works best
- **Review before implementing** - Use `/speckit.analyze` to catch issues early
- **Leverage parallelism** - With Maestro, you can run multiple spec-kit workflows simultaneously across different sessions

## Learn More

- [GitHub Spec-Kit Repository](https://github.com/github/spec-kit) - Official documentation and examples
- Spec-Kit prompts are automatically updated when you click "Check for Updates" in Maestro settings
- Custom modifications to prompts are preserved across updates

---

*This help command is a Maestro-specific addition to the spec-kit workflow.*
