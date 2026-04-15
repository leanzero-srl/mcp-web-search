/**
 * Prompt Builder - Structured prompts for LLM research tasks
 */

/**
 * Research task type
 */
export type ResearchType = 
  | 'comparison'      // Compare multiple options
  | 'analysis'        // Deep dive analysis
  | 'summary'         // Concise summary
  | 'tutorial'        // Step-by-step guide
  | 'troubleshooting' // Problem solving
  | 'trends'          // Current trends and insights
  | 'comparison-table'; // Structured comparison with table

/**
 * Context structure for research
 */
export interface ResearchContext {
  webSearchResults?: string;
  userPreferences?: Record<string, string>;
  constraints?: string[];
}

/**
 * Build a research prompt with structured instructions
 */
export function buildResearchPrompt(
  query: string,
  options?: {
    type?: ResearchType;
    context?: ResearchContext;
    maxWords?: number;
    includeExamples?: boolean;
    tone?: 'professional' | 'technical' | 'casual';
    systemPrompt?: string;
  }
): string {
  const {
    type = 'analysis',
    context,
    maxWords = 2000,
    includeExamples = true,
    tone = 'professional',
    systemPrompt
  } = options || {};

  // Base instructions based on research type
  const typeInstructions = getTypeInstructions(type, includeExamples);
  
  // Tone-specific guidance
  const toneGuidance = getToneGuidance(tone);

  // Build prompt structure
  let prompt = '';

  if (systemPrompt) {
    prompt += `SYSTEM: ${systemPrompt}\n\n`;
  }

  prompt += `You are an expert research assistant. Your task is to provide high-quality, well-structured information.

RESEARCH QUERY:
"${query}"

TASK TYPE: ${type.toUpperCase()}
${toneGuidance}

INSTRUCTIONS:
1. Analyze the query and identify key information needs
2. Provide a comprehensive response within ~${maxWords} words
3. Include ${includeExamples ? 'practical examples' : 'detailed explanations'}
4. Structure your response with clear headings

${typeInstructions}

${context?.webSearchResults 
  ? `WEB SEARCH CONTEXT (REQUIRED - MUST cite specific sources):
\`\`\`
${context.webSearchResults}
\`\`\`

CRITICAL: You MUST use the above web search results to inform your response. 
- Cite sources by number like [1], [2], etc.
- Reference URLs directly in your text
- Compare information across multiple sources
- If sources contradict, explain the discrepancies and provide the most reliable answer
- Do NOT make claims that conflict with the provided search results
` 
  : `WEB SEARCH CONTEXT:
No web search context available. Use your own knowledge but be clear about what is fact vs opinion.
`

}${
    context?.constraints && context.constraints.length > 0
      ? `CONSTRAINTS TO CONSIDER:
${context.constraints.map(c => `- ${c}`).join('\n')}
`
      : ''
  }${
    context?.userPreferences &&
    Object.keys(context.userPreferences).length > 0
      ? `USER PREFERENCES:
${Object.entries(context.userPreferences)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join('\n')}
` 
      : ''
  }

FORMAT REQUIREMENTS:
- Use Markdown formatting with appropriate headings
- Include bullet points for lists
- Use code blocks for any technical content or commands
- Add tables when comparing multiple items
- Keep paragraphs concise (3-5 sentences max)

End your response with a brief summary of key findings.`;

  return prompt;
}

/**
 * Get type-specific instructions
 */
function getTypeInstructions(type: ResearchType, includeExamples: boolean): string {
  const examplesGuidance = includeExamples 
    ? '- Include practical examples where applicable' 
    : '';

  switch (type) {
    case 'comparison':
      return `COMPARISON ANALYSIS:
- Identify and compare at least 3 relevant options
- Create a comparison table if possible
- Discuss pros and cons of each option
- Provide recommendations based on use cases

${examplesGuidance}`;

    case 'analysis':
      return `DEEP DIVE ANALYSIS:
- Break down the topic into key components
- Analyze current state, trends, and future outlook
- Discuss technical aspects and practical implications
- Evaluate different perspectives or approaches

${examplesGuidance}`;

    case 'summary':
      return `CONCISE SUMMARY:
- Focus on the most important information
- Use bullet points for key takeaways
- Maintain clarity while being brief
- Highlight critical insights

${examplesGuidance}`;

    case 'tutorial':
      return `STEP-BY-STEP GUIDE:
- Provide clear, actionable steps
- Include code examples or commands
- Anticipate common pitfalls and solutions
- Order steps logically from start to finish

${examplesGuidance}`;

    case 'troubleshooting':
      return `TROUBLESHOOTING GUIDANCE:
- Identify potential root causes
- Provide diagnostic steps
- Offer specific fixes for each issue
- Include verification steps

${examplesGuidance}`;

    case 'trends':
      return `CURRENT TRENDS ANALYSIS:
- Identify recent developments (last 6-12 months)
- Discuss adoption rates and industry impact
- Compare emerging vs established approaches
- Predict future directions

${examplesGuidance}`;

    case 'comparison-table':
      return `STRUCTURED COMPARISON:
- Create a comprehensive comparison table
- Include at least 5 relevant criteria
- Rate each option on a consistent scale
- Add notes for each rating

${examplesGuidance}`;
  }
}

/**
 * Get tone-specific guidance
 */
function getToneGuidance(tone: 'professional' | 'technical' | 'casual'): string {
  switch (tone) {
    case 'technical':
      return `TONE: Technical/Engineering
- Use precise technical terminology
- Include specific metrics and benchmarks
- Reference standards, specifications, or APIs
- Assume reader has technical background`;

    case 'casual':
      return `TONE: Casual/Conversational
- Use accessible language
- Include relatable analogies
- Keep explanations simple
- Be engaging and approachable`;

    case 'professional':
    default:
      return `TONE: Professional/Business
- Maintain formal but clear language
- Focus on business impact and value
- Include practical recommendations
- Balance depth with readability`;
  }
}

/**
 * Build a prompt for result synthesis across multiple subtasks
 */
export function buildSynthesisPrompt(
  query: string,
  subtaskResults: Array<{ deviceId: string; content: string }>,
  options?: {
    maxSummaryWords?: number;
    priorityDevices?: string[];
  }
): string {
  const { maxSummaryWords = 3000, priorityDevices = [] } = options || {};

  // Format results with device info
  const formattedResults = subtaskResults.map((result, idx) => {
    const isPriority = priorityDevices.includes(result.deviceId);
    return `RESULT ${idx + 1} (Device: ${result.deviceId}${isPriority ? ' [PRIORITY]' : ''}}):
\`\`\`
${result.content}
\`\`\`
`;
  }).join('\n');

  const prompt = `You are a synthesis expert. Your task is to combine multiple research results into a cohesive, comprehensive report.

ORIGINAL QUERY:
"${query}"

INPUT RESULTS (from distributed devices):
${formattedResults}

SYNTHESIS TASKS:
1. Identify overlapping themes and unique insights across results
2. Remove redundancies while preserving key information
3. Create logical structure with clear sections
4. Add transitional text between sections
5. Give priority to results from: ${priorityDevices.join(', ') || 'all devices equally'}

OUTPUT REQUIREMENTS:
- Total length: ~${maxSummaryWords} words
- Use Markdown formatting with proper headings (H1, H2, H3)
- Include a summary table if comparing multiple items
- Add clear section transitions
- Cite which device provided specific insights where relevant
- End with key takeaways and recommendations

Format your response as the final synthesized report.`;

  return prompt;
}

/**
 * Build a query decomposition prompt for parallel processing
 */
export function buildDecompositionPrompt(
  originalQuery: string,
  options?: {
    numSubtasks?: number;
    includeContext?: boolean;
  }
): string {
  const { numSubtasks = 3 } = options || {};

  return `You are a query decomposition expert. Break down the following research query into focused, parallel-executable subtasks.

ORIGINAL QUERY:
"${originalQuery}"

DECOMPOSITION TASKS:
1. Identify ${numSubtasks} distinct aspects of this query
2. Each subtask should be:
   - Self-contained and focused
   - Executable independently by a different device
   - Specific enough for targeted research
3. Ensure coverage of all key dimensions

OUTPUT FORMAT (JSON):
{
  "decomposition": [
    {
      "id": "subtask_1",
      "query": "Specific focused query for this aspect",
      "reasoning": "Why this subtask is needed"
    }
  ]
}

Example output format (DO NOT include this in your response, just use it as a template):
{
  "decomposition": [
    {
      "id": "subtask_1",
      "query": "Compare React and Vue component architecture patterns",
      "reasoning": "Component architecture is a fundamental differentiator"
    }
  ]
}

Provide the decomposition now in JSON format only (no additional text):`;
}

// Export utility functions
export const promptBuilder = {
  buildResearchPrompt,
  buildSynthesisPrompt,
  buildDecompositionPrompt,
};
