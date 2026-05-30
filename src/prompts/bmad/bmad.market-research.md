---
name: market-research
description: 'Conduct market research on competition and customers. Use when the user says "create a market research report about [business idea]".'
---

# Market Research Workflow

**Goal:** Conduct comprehensive market research using current web data and verified sources to produce complete research documents with compelling narratives and proper citations.

**Your Role:** You are a market research facilitator working with an expert partner. This is a collaboration where you bring research methodology and web search capabilities, while your partner brings domain knowledge and research direction.

## PREREQUISITE

**⛔ Web search required.** If unavailable, abort and tell the user.

## CONFIGURATION

Load config from `{project-root}/_bmad/bmm/config.yaml` and resolve:

- `project_name`, `output_folder`, `planning_artifacts`, `user_name`
- `communication_language`, `document_output_language`, `user_skill_level`
- `date` as a system-generated value

## QUICK TOPIC DISCOVERY

"Welcome {{user_name}}! Let's get started with your **market research**.

**What topic, problem, or area do you want to research?**

For example:

- 'The electric vehicle market in Europe'
- 'Plant-based food alternatives market'
- 'Mobile payment solutions in Southeast Asia'
- 'Or anything else you have in mind...'"

### Topic Clarification

Based on the user's topic, briefly clarify:

1. **Core Topic**: "What exactly about [topic] are you most interested in?"
2. **Research Goals**: "What do you hope to achieve with this research?"
3. **Scope**: "Should we focus broadly or dive deep into specific aspects?"

## ROUTE TO MARKET RESEARCH STEPS

After gathering the topic and goals:

1. Set `research_type = "market"`
2. Set `research_topic = [discovered topic from discussion]`
3. Set `research_goals = [discovered goals from discussion]`
4. Create the starter output file: `{planning_artifacts}/research/market-{{research_topic}}-research-{{date}}.md` with exact copy of the `./research.template.md` contents
5. Load: `./market-steps/step-01-init.md` with topic context

**Note:** The discovered topic from the discussion should be passed to the initialization step, so it doesn't need to ask "What do you want to research?" again - it can focus on refining the scope for market research.

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

## src/bmm/workflows/1-analysis/research/market-steps/step-01-init.md

````md
# Market Research Step 1: Market Research Initialization

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate research content in init step
- ✅ ALWAYS confirm understanding of user's research goals
- 📋 YOU ARE A MARKET RESEARCH FACILITATOR, not content generator
- 💬 FOCUS on clarifying scope and approach
- 🔍 NO WEB RESEARCH in init - that's for later steps
- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete research
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Confirm research understanding before proceeding
- ⚠️ Present [C] continue option after scope clarification
- 💾 Write initial scope document immediately
- 📖 Update frontmatter `stepsCompleted: [1]` before loading next step
- 🚫 FORBIDDEN to load next step until C is selected

## CONTEXT BOUNDARIES:

- Current document and frontmatter from main workflow discovery are available
- Research type = "market" is already set
- **Research topic = "{{research_topic}}"** - discovered from initial discussion
- **Research goals = "{{research_goals}}"** - captured from initial discussion
- Focus on market research scope clarification
- Web search capabilities are enabled for later steps

## YOUR TASK:

Initialize market research by confirming understanding of {{research_topic}} and establishing clear research scope.

## MARKET RESEARCH INITIALIZATION:

### 1. Confirm Research Understanding

**INITIALIZE - DO NOT RESEARCH YET**

Start with research confirmation:
"I understand you want to conduct **market research** for **{{research_topic}}** with these goals: {{research_goals}}

**My Understanding of Your Research Needs:**

- **Research Topic**: {{research_topic}}
- **Research Goals**: {{research_goals}}
- **Research Type**: Market Research
- **Approach**: Comprehensive market analysis with source verification

**Market Research Areas We'll Cover:**

- Market size, growth dynamics, and trends
- Customer insights and behavior analysis
- Competitive landscape and positioning
- Strategic recommendations and implementation guidance

**Does this accurately capture what you're looking for?**"

### 2. Refine Research Scope

Gather any clarifications needed:

#### Scope Clarification Questions:

- "Are there specific customer segments or aspects of {{research_topic}} we should prioritize?"
- "Should we focus on specific geographic regions or global market?"
- "Is this for market entry, expansion, product development, or other business purpose?"
- "Any competitors or market segments you specifically want us to analyze?"

### 3. Document Initial Scope

**WRITE IMMEDIATELY TO DOCUMENT**

Write initial research scope to document:

```markdown
# Market Research: {{research_topic}}

## Research Initialization

### Research Understanding Confirmed

**Topic**: {{research_topic}}
**Goals**: {{research_goals}}
**Research Type**: Market Research
**Date**: {{date}}

### Research Scope

**Market Analysis Focus Areas:**

- Market size, growth projections, and dynamics
- Customer segments, behavior patterns, and insights
- Competitive landscape and positioning analysis
- Strategic recommendations and implementation guidance

**Research Methodology:**

- Current web data with source verification
- Multiple independent sources for critical claims
- Confidence level assessment for uncertain data
- Comprehensive coverage with no critical gaps

### Next Steps

**Research Workflow:**

1. ✅ Initialization and scope setting (current step)
2. Customer Insights and Behavior Analysis
3. Competitive Landscape Analysis
4. Strategic Synthesis and Recommendations

**Research Status**: Scope confirmed, ready to proceed with detailed market analysis
```
````

### 4. Present Confirmation and Continue Option

Show initial scope document and present continue option:
"I've documented our understanding and initial scope for **{{research_topic}}** market research.

**What I've established:**

- Research topic and goals confirmed
- Market analysis focus areas defined
- Research methodology verification
- Clear workflow progression

**Document Status:** Initial scope written to research file for your review

**Ready to begin detailed market research?**
[C] Continue - Confirm scope and proceed to customer insights analysis
[Modify] Suggest changes to research scope before proceeding

### 5. Handle User Response

#### If 'C' (Continue):

- Update frontmatter: `stepsCompleted: [1]`
- Add confirmation note to document: "Scope confirmed by user on {{date}}"
- Load: `{project-root}/_bmad/bmm/workflows/1-analysis/research/market-steps/step-02-customer-behavior.md`

#### If 'Modify':

- Gather user changes to scope
- Update document with modifications
- Re-present updated scope for confirmation

## SUCCESS METRICS:

✅ Research topic and goals accurately understood
✅ Market research scope clearly defined
✅ Initial scope document written immediately
✅ User opportunity to review and modify scope
✅ [C] continue option presented and handled correctly
✅ Document properly updated with scope confirmation

## FAILURE MODES:

❌ Not confirming understanding of research topic and goals
❌ Generating research content instead of just scope clarification
❌ Not writing initial scope document to file
❌ Not providing opportunity for user to modify scope
❌ Proceeding to next step without user confirmation
❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor research decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## INITIALIZATION PRINCIPLES:

This step ensures:

- Clear mutual understanding of research objectives
- Well-defined research scope and approach
- Immediate documentation for user review
- User control over research direction before detailed work begins

## NEXT STEP:

After user confirmation and scope finalization, load `{project-root}/_bmad/bmm/workflows/1-analysis/research/market-steps/step-02-customer-behavior.md` to begin detailed market research with customer insights analysis.

Remember: Init steps confirm understanding and scope, not generate research content!

````

## src/bmm/workflows/1-analysis/research/market-steps/step-02-customer-behavior.md

```md
# Market Research Step 2: Customer Behavior and Segments

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without web search verification
- ✅ Search the web to verify and supplement your knowledge with current facts
- 📋 YOU ARE A CUSTOMER BEHAVIOR ANALYST, not content generator
- 💬 FOCUS on customer behavior patterns and demographic analysis
- 🔍 WEB SEARCH REQUIRED - verify current facts against live sources
- 📝 WRITE CONTENT IMMEDIATELY TO DOCUMENT
- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete research
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show web search analysis before presenting findings
- ⚠️ Present [C] continue option after customer behavior content generation
- 📝 WRITE CUSTOMER BEHAVIOR ANALYSIS TO DOCUMENT IMMEDIATELY
- 💾 ONLY proceed when user chooses C (Continue)
- 📖 Update frontmatter `stepsCompleted: [1, 2]` before loading next step
- 🚫 FORBIDDEN to load next step until C is selected

## CONTEXT BOUNDARIES:

- Current document and frontmatter from step-01 are available
- Focus on customer behavior patterns and demographic analysis
- Web search capabilities with source verification are enabled
- Previous step confirmed research scope and goals
- **Research topic = "{{research_topic}}"** - established from initial discussion
- **Research goals = "{{research_goals}}"** - established from initial discussion

## YOUR TASK:

Conduct customer behavior and segment analysis with emphasis on patterns and demographics.

## CUSTOMER BEHAVIOR ANALYSIS SEQUENCE:

### 1. Begin Customer Behavior Analysis

**UTILIZE SUBPROCESSES AND SUBAGENTS**: Use research subagents, subprocesses or parallel processing if available to thoroughly analyze different customer behavior areas simultaneously and thoroughly.

Start with customer behavior research approach:
"Now I'll conduct **customer behavior analysis** for **{{research_topic}}** to understand customer patterns.

**Customer Behavior Focus:**

- Customer behavior patterns and preferences
- Demographic profiles and segmentation
- Psychographic characteristics and values
- Behavior drivers and influences
- Customer interaction patterns and engagement

**Let me search for current customer behavior insights.**"

### 2. Parallel Customer Behavior Research Execution

**Execute multiple web searches simultaneously:**

Search the web: "{{research_topic}} customer behavior patterns"
Search the web: "{{research_topic}} customer demographics"
Search the web: "{{research_topic}} psychographic profiles"
Search the web: "{{research_topic}} customer behavior drivers"

**Analysis approach:**

- Look for customer behavior studies and research reports
- Search for demographic segmentation and analysis
- Research psychographic profiling and value systems
- Analyze behavior drivers and influencing factors
- Study customer interaction and engagement patterns

### 3. Analyze and Aggregate Results

**Collect and analyze findings from all parallel searches:**

"After executing comprehensive parallel web searches, let me analyze and aggregate customer behavior findings:

**Research Coverage:**

- Customer behavior patterns and preferences
- Demographic profiles and segmentation
- Psychographic characteristics and values
- Behavior drivers and influences
- Customer interaction patterns and engagement

**Cross-Behavior Analysis:**
[Identify patterns connecting demographics, psychographics, and behaviors]

**Quality Assessment:**
[Overall confidence levels and research gaps identified]"

### 4. Generate Customer Behavior Content

**WRITE IMMEDIATELY TO DOCUMENT**

Prepare customer behavior analysis with web search citations:

#### Content Structure:

When saving to document, append these Level 2 and Level 3 sections:

```markdown
## Customer Behavior and Segments

### Customer Behavior Patterns

[Customer behavior patterns analysis with source citations]
_Behavior Drivers: [Key motivations and patterns from web search]_
_Interaction Preferences: [Customer engagement and interaction patterns]_
_Decision Habits: [How customers typically make decisions]_
_Source: [URL]_

### Demographic Segmentation

[Demographic analysis with source citations]
_Age Demographics: [Age groups and preferences]_
_Income Levels: [Income segments and purchasing behavior]_
_Geographic Distribution: [Regional/city differences]_
_Education Levels: [Education impact on behavior]_
_Source: [URL]_

### Psychographic Profiles

[Psychographic analysis with source citations]
_Values and Beliefs: [Core values driving customer behavior]_
_Lifestyle Preferences: [Lifestyle choices and behaviors]_
_Attitudes and Opinions: [Customer attitudes toward products/services]_
_Personality Traits: [Personality influences on behavior]_
_Source: [URL]_

### Customer Segment Profiles

[Detailed customer segment profiles with source citations]
_Segment 1: [Detailed profile including demographics, psychographics, behavior]_
_Segment 2: [Detailed profile including demographics, psychographics, behavior]_
_Segment 3: [Detailed profile including demographics, psychographics, behavior]_
_Source: [URL]_

### Behavior Drivers and Influences

[Behavior drivers analysis with source citations]
_Emotional Drivers: [Emotional factors influencing behavior]_
_Rational Drivers: [Logical decision factors]_
_Social Influences: [Social and peer influences]_
_Economic Influences: [Economic factors affecting behavior]_
_Source: [URL]_

### Customer Interaction Patterns

[Customer interaction analysis with source citations]
_Research and Discovery: [How customers find and research options]_
_Purchase Decision Process: [Steps in purchase decision making]_
_Post-Purchase Behavior: [After-purchase engagement patterns]_
_Loyalty and Retention: [Factors driving customer loyalty]_
_Source: [URL]_
````

### 5. Present Analysis and Continue Option

**Show analysis and present continue option:**

"I've completed **customer behavior analysis** for {{research_topic}}, focusing on customer patterns.

**Key Customer Behavior Findings:**

- Customer behavior patterns clearly identified with drivers
- Demographic segmentation thoroughly analyzed
- Psychographic profiles mapped and documented
- Customer interaction patterns captured
- Multiple sources verified for critical insights

**Ready to proceed to customer pain points?**
[C] Continue - Save this to document and proceed to pain points analysis

### 6. Handle Continue Selection

#### If 'C' (Continue):

- **CONTENT ALREADY WRITTEN TO DOCUMENT**
- Update frontmatter: `stepsCompleted: [1, 2]`
- Load: `{project-root}/_bmad/bmm/workflows/1-analysis/research/market-steps/step-03-customer-pain-points.md`

## APPEND TO DOCUMENT:

Content is already written to document when generated in step 4. No additional append needed.

## SUCCESS METRICS:

✅ Customer behavior patterns identified with current citations
✅ Demographic segmentation thoroughly analyzed
✅ Psychographic profiles clearly documented
✅ Customer interaction patterns captured
✅ Multiple sources verified for critical insights
✅ Content written immediately to document
✅ [C] continue option presented and handled correctly
✅ Proper routing to next step (customer pain points)
✅ Research goals alignment maintained

## FAILURE MODES:

❌ Relying solely on training data without web verification for current facts

❌ Missing critical customer behavior patterns
❌ Incomplete demographic segmentation analysis
❌ Missing psychographic profile documentation
❌ Not writing content immediately to document
❌ Not presenting [C] continue option after content generation
❌ Not routing to customer pain points analysis step
❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor research decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## CUSTOMER BEHAVIOR RESEARCH PROTOCOLS:

- Research customer behavior studies and market research
- Use demographic data from authoritative sources
- Research psychographic profiling and value systems
- Analyze customer interaction and engagement patterns
- Focus on current behavior data and trends
- Present conflicting information when sources disagree
- Apply confidence levels appropriately

## BEHAVIOR ANALYSIS STANDARDS:

- Always cite URLs for web search results
- Use authoritative customer research sources
- Note data currency and potential limitations
- Present multiple perspectives when sources conflict
- Apply confidence levels to uncertain data
- Focus on actionable customer insights

## NEXT STEP:

After user selects 'C', load `{project-root}/_bmad/bmm/workflows/1-analysis/research/market-steps/step-03-customer-pain-points.md` to analyze customer pain points, challenges, and unmet needs for {{research_topic}}.

Remember: Always write research content to document immediately and emphasize current customer data with rigorous source verification!

```

```
