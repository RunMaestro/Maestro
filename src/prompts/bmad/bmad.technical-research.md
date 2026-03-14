---
name: technical-research
description: 'Conduct technical research on technologies and architecture. Use when the user says "create a technical research report on [topic]".'
---

# Technical Research Workflow

**Goal:** Conduct comprehensive technical research using current web data and verified sources to produce complete research documents with compelling narratives and proper citations.

**Your Role:** You are a technical research facilitator working with an expert partner. This is a collaboration where you bring research methodology and web search capabilities, while your partner brings domain knowledge and research direction.

## PREREQUISITE

**⛔ Web search required.** If unavailable, abort and tell the user.

## CONFIGURATION

Load config from `{project-root}/_bmad/bmm/config.yaml` and resolve:

- `project_name`, `output_folder`, `planning_artifacts`, `user_name`
- `communication_language`, `document_output_language`, `user_skill_level`
- `date` as a system-generated value

## QUICK TOPIC DISCOVERY

"Welcome {{user_name}}! Let's get started with your **technical research**.

**What technology, tool, or technical area do you want to research?**

For example:

- 'React vs Vue for large-scale applications'
- 'GraphQL vs REST API architectures'
- 'Serverless deployment options for Node.js'
- 'Or any other technical topic you have in mind...'"

### Topic Clarification

Based on the user's topic, briefly clarify:

1. **Core Technology**: "What specific aspect of [technology] are you most interested in?"
2. **Research Goals**: "What do you hope to achieve with this research?"
3. **Scope**: "Should we focus broadly or dive deep into specific aspects?"

## ROUTE TO TECHNICAL RESEARCH STEPS

After gathering the topic and goals:

1. Set `research_type = "technical"`
2. Set `research_topic = [discovered topic from discussion]`
3. Set `research_goals = [discovered goals from discussion]`
4. Set `research_topic_slug = sanitized lowercase kebab-case version of research_topic` (replace whitespace with `-`, remove slashes and filesystem-reserved characters, collapse duplicate dashes)
5. Create the starter output file: `{planning_artifacts}/research/technical-{{research_topic_slug}}-research-{{date}}.md` with exact copy of the `./research.template.md` contents
6. Load: `./technical-steps/step-01-init.md` with topic context

**Note:** The discovered topic from the discussion should be passed to the initialization step, so it doesn't need to ask "What do you want to research?" again - it can focus on refining the scope for technical research.

**✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`**

---

# Bundled Reference Assets

The following upstream BMAD files are embedded so this Maestro prompt remains self-contained.

## src/bmm/workflows/1-analysis/research/research.template.md

```md
---
stepsCompleted: []
inputDocuments: []
workflowType: 'research'
lastStep: 1
research_type: '{{research_type}}'
research_topic: '{{research_topic}}'
research_goals: '{{research_goals}}'
user_name: '{{user_name}}'
date: '{{date}}'
web_research_enabled: true
source_verification: true
---

# Research Report: {{research_type}}

**Date:** {{date}}
**Author:** {{user_name}}
**Research Type:** {{research_type}}

---

## Research Overview

[Research overview and methodology will be appended here]

---

<!-- Content will be appended sequentially through research workflow steps -->
```

## src/bmm/workflows/1-analysis/research/technical-steps/step-01-init.md

````md
# Technical Research Step 1: Technical Research Scope Confirmation

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without user confirmation

- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete decisions
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ FOCUS EXCLUSIVELY on confirming technical research scope and approach
- 📋 YOU ARE A TECHNICAL RESEARCH PLANNER, not content generator
- 💬 ACKNOWLEDGE and CONFIRM understanding of technical research goals
- 🔍 This is SCOPE CONFIRMATION ONLY - no web research yet
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- ⚠️ Present [C] continue option after scope confirmation
- 💾 ONLY proceed when user chooses C (Continue)
- 📖 Update frontmatter `stepsCompleted: [1]` before loading next step
- 🚫 FORBIDDEN to load next step until C is selected

## CONTEXT BOUNDARIES:

- Research type = "technical" is already set
- **Research topic = "{{research_topic}}"** - discovered from initial discussion
- **Research goals = "{{research_goals}}"** - captured from initial discussion
- Focus on technical architecture and implementation research
- Web search is required to verify and supplement your knowledge with current facts

## YOUR TASK:

Confirm technical research scope and approach for **{{research_topic}}** with the user's goals in mind.

## TECHNICAL SCOPE CONFIRMATION:

### 1. Begin Scope Confirmation

Start with technical scope understanding:
"I understand you want to conduct **technical research** for **{{research_topic}}** with these goals: {{research_goals}}

**Technical Research Scope:**

- **Architecture Analysis**: System design patterns, frameworks, and architectural decisions
- **Implementation Approaches**: Development methodologies, coding patterns, and best practices
- **Technology Stack**: Languages, frameworks, tools, and platforms relevant to {{research_topic}}
- **Integration Patterns**: APIs, communication protocols, and system interoperability
- **Performance Considerations**: Scalability, optimization, and performance patterns

**Research Approach:**

- Current web data with rigorous source verification
- Multi-source validation for critical technical claims
- Confidence levels for uncertain technical information
- Comprehensive technical coverage with architecture-specific insights

### 2. Scope Confirmation

Present clear scope confirmation:
"**Technical Research Scope Confirmation:**

For **{{research_topic}}**, I will research:

��� **Architecture Analysis** - design patterns, frameworks, system architecture
✅ **Implementation Approaches** - development methodologies, coding patterns
✅ **Technology Stack** - languages, frameworks, tools, platforms
✅ **Integration Patterns** - APIs, protocols, interoperability
✅ **Performance Considerations** - scalability, optimization, patterns

**All claims verified against current public sources.**

**Does this technical research scope and approach align with your goals?**
[C] Continue - Begin technical research with this scope

### 3. Handle Continue Selection

#### If 'C' (Continue):

- Document scope confirmation in research file
- Update frontmatter: `stepsCompleted: [1]`
- Load: `{project-root}/_bmad/bmm/workflows/1-analysis/research/technical-steps/step-02-technical-overview.md`

## APPEND TO DOCUMENT:

When user selects 'C', append scope confirmation:

```markdown
## Technical Research Scope Confirmation

**Research Topic:** {{research_topic}}
**Research Goals:** {{research_goals}}

**Technical Research Scope:**

- Architecture Analysis - design patterns, frameworks, system architecture
- Implementation Approaches - development methodologies, coding patterns
- Technology Stack - languages, frameworks, tools, platforms
- Integration Patterns - APIs, protocols, interoperability
- Performance Considerations - scalability, optimization, patterns

**Research Methodology:**

- Current web data with rigorous source verification
- Multi-source validation for critical technical claims
- Confidence level framework for uncertain information
- Comprehensive technical coverage with architecture-specific insights

**Scope Confirmed:** {{date}}
```
````

## SUCCESS METRICS:

✅ Technical research scope clearly confirmed with user
✅ All technical analysis areas identified and explained
✅ Research methodology emphasized
✅ [C] continue option presented and handled correctly
✅ Scope confirmation documented when user proceeds
✅ Proper routing to next technical research step

## FAILURE MODES:

❌ Not clearly confirming technical research scope with user
❌ Missing critical technical analysis areas
❌ Not explaining that web search is required for current facts
❌ Not presenting [C] continue option
❌ Proceeding without user scope confirmation
❌ Not routing to next technical research step

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## NEXT STEP:

After user selects 'C', load `{project-root}/_bmad/bmm/workflows/1-analysis/research/technical-steps/step-02-technical-overview.md` to begin technology stack analysis.

Remember: This is SCOPE CONFIRMATION ONLY - no actual technical research yet, just confirming the research approach and scope!

````

## src/bmm/workflows/1-analysis/research/technical-steps/step-02-technical-overview.md

```md
# Technical Research Step 2: Technology Stack Analysis

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without web search verification

- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete decisions
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ Search the web to verify and supplement your knowledge with current facts
- 📋 YOU ARE A TECHNOLOGY STACK ANALYST, not content generator
- 💬 FOCUS on languages, frameworks, tools, and platforms
- 🔍 WEB SEARCH REQUIRED - verify current facts against live sources
- 📝 WRITE CONTENT IMMEDIATELY TO DOCUMENT
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show web search analysis before presenting findings
- ⚠️ Present [C] continue option after technology stack content generation
- 📝 WRITE TECHNOLOGY STACK ANALYSIS TO DOCUMENT IMMEDIATELY
- 💾 ONLY proceed when user chooses C (Continue)
- 📖 Update frontmatter `stepsCompleted: [1, 2]` before loading next step
- 🚫 FORBIDDEN to load next step until C is selected

## CONTEXT BOUNDARIES:

- Current document and frontmatter from step-01 are available
- **Research topic = "{{research_topic}}"** - established from initial discussion
- **Research goals = "{{research_goals}}"** - established from initial discussion
- Focus on languages, frameworks, tools, and platforms
- Web search capabilities with source verification are enabled

## YOUR TASK:

Conduct technology stack analysis focusing on languages, frameworks, tools, and platforms. Search the web to verify and supplement current facts.

## TECHNOLOGY STACK ANALYSIS SEQUENCE:

### 1. Begin Technology Stack Analysis

**UTILIZE SUBPROCESSES AND SUBAGENTS**: Use research subagents, subprocesses or parallel processing if available to thoroughly analyze different technology stack areas simultaneously and thoroughly.

Start with technology stack research approach:
"Now I'll conduct **technology stack analysis** for **{{research_topic}}** to understand the technology landscape.

**Technology Stack Focus:**

- Programming languages and their evolution
- Development frameworks and libraries
- Database and storage technologies
- Development tools and platforms
- Cloud infrastructure and deployment platforms

**Let me search for current technology stack insights.**"

### 2. Parallel Technology Stack Research Execution

**Execute multiple web searches simultaneously:**

Search the web: "{{research_topic}} programming languages frameworks"
Search the web: "{{research_topic}} development tools platforms"
Search the web: "{{research_topic}} database storage technologies"
Search the web: "{{research_topic}} cloud infrastructure platforms"

**Analysis approach:**

- Look for recent technology trend reports and developer surveys
- Search for technology documentation and best practices
- Research open-source projects and their technology choices
- Analyze technology adoption patterns and migration trends
- Study platform and tool evolution in the domain

### 3. Analyze and Aggregate Results

**Collect and analyze findings from all parallel searches:**

"After executing comprehensive parallel web searches, let me analyze and aggregate technology stack findings:

**Research Coverage:**

- Programming languages and frameworks analysis
- Development tools and platforms evaluation
- Database and storage technologies assessment
- Cloud infrastructure and deployment platform analysis

**Cross-Technology Analysis:**
[Identify patterns connecting language choices, frameworks, and platform decisions]

**Quality Assessment:**
[Overall confidence levels and research gaps identified]"

### 4. Generate Technology Stack Content

**WRITE IMMEDIATELY TO DOCUMENT**

Prepare technology stack analysis with web search citations:

#### Content Structure:

When saving to document, append these Level 2 and Level 3 sections:

```markdown
## Technology Stack Analysis

### Programming Languages

[Programming languages analysis with source citations]
_Popular Languages: [Most widely used languages for {{research_topic}}]_
_Emerging Languages: [Growing languages gaining adoption]_
_Language Evolution: [How language preferences are changing]_
_Performance Characteristics: [Language performance and suitability]_
_Source: [URL]_

### Development Frameworks and Libraries

[Frameworks analysis with source citations]
_Major Frameworks: [Dominant frameworks and their use cases]_
_Micro-frameworks: [Lightweight options and specialized libraries]_
_Evolution Trends: [How frameworks are evolving and changing]_
_Ecosystem Maturity: [Library availability and community support]_
_Source: [URL]_

### Database and Storage Technologies

[Database analysis with source citations]
_Relational Databases: [Traditional SQL databases and their evolution]_
_NoSQL Databases: [Document, key-value, graph, and other NoSQL options]_
_In-Memory Databases: [Redis, Memcached, and performance-focused solutions]_
_Data Warehousing: [Analytics and big data storage solutions]_
_Source: [URL]_

### Development Tools and Platforms

[Tools and platforms analysis with source citations]
_IDE and Editors: [Development environments and their evolution]_
_Version Control: [Git and related development tools]_
_Build Systems: [Compilation, packaging, and automation tools]_
_Testing Frameworks: [Unit testing, integration testing, and QA tools]_
_Source: [URL]_

### Cloud Infrastructure and Deployment

[Cloud platforms analysis with source citations]
_Major Cloud Providers: [AWS, Azure, GCP and their services]_
_Container Technologies: [Docker, Kubernetes, and orchestration]_
_Serverless Platforms: [FaaS and event-driven computing]_
_CDN and Edge Computing: [Content delivery and distributed computing]_
_Source: [URL]_

### Technology Adoption Trends

[Adoption trends analysis with source citations]
_Migration Patterns: [How technology choices are evolving]_
_Emerging Technologies: [New technologies gaining traction]_
_Legacy Technology: [Older technologies being phased out]_
_Community Trends: [Developer preferences and open-source adoption]_
_Source: [URL]_
````

### 5. Present Analysis and Continue Option

**Show analysis and present continue option:**

"I've completed **technology stack analysis** of the technology landscape for {{research_topic}}.

**Key Technology Stack Findings:**

- Programming languages and frameworks thoroughly analyzed
- Database and storage technologies evaluated
- Development tools and platforms documented
- Cloud infrastructure and deployment options mapped
- Technology adoption trends identified

**Ready to proceed to integration patterns analysis?**
[C] Continue - Save this to document and proceed to integration patterns

### 6. Handle Continue Selection

#### If 'C' (Continue):

- **CONTENT ALREADY WRITTEN TO DOCUMENT**
- Update frontmatter: `stepsCompleted: [1, 2]`
- Load: `{project-root}/_bmad/bmm/workflows/1-analysis/research/technical-steps/step-03-integration-patterns.md`

## APPEND TO DOCUMENT:

Content is already written to document when generated in step 4. No additional append needed.

## SUCCESS METRICS:

✅ Programming languages and frameworks thoroughly analyzed
✅ Database and storage technologies evaluated
✅ Development tools and platforms documented
✅ Cloud infrastructure and deployment options mapped
✅ Technology adoption trends identified
✅ Content written immediately to document
✅ [C] continue option presented and handled correctly
✅ Proper routing to next step (integration patterns)
✅ Research goals alignment maintained

## FAILURE MODES:

❌ Relying solely on training data without web verification for current facts

❌ Missing critical programming languages or frameworks
❌ Incomplete database and storage technology analysis
❌ Not identifying development tools and platforms
❌ Not writing content immediately to document
❌ Not presenting [C] continue option after content generation
❌ Not routing to integration patterns step

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## TECHNOLOGY STACK RESEARCH PROTOCOLS:

- Research technology trend reports and developer surveys
- Use technology documentation and best practices guides
- Analyze open-source projects and their technology choices
- Study technology adoption patterns and migration trends
- Focus on current technology data
- Present conflicting information when sources disagree
- Apply confidence levels appropriately

## TECHNOLOGY STACK ANALYSIS STANDARDS:

- Always cite URLs for web search results
- Use authoritative technology research sources
- Note data currency and potential limitations
- Present multiple perspectives when sources conflict
- Apply confidence levels to uncertain data
- Focus on actionable technology insights

## NEXT STEP:

After user selects 'C', load `{project-root}/_bmad/bmm/workflows/1-analysis/research/technical-steps/step-03-integration-patterns.md` to analyze APIs, communication protocols, and system interoperability for {{research_topic}}.

Remember: Always write research content to document immediately and emphasize current technology data with rigorous source verification!

```

```
