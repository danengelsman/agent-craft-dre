import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { agentId } = await req.json();
    
    if (!agentId) {
      return Response.json({ error: 'agentId is required' }, { status: 400 });
    }

    // Fetch the agent
    const agents = await base44.entities.Agent.filter({ id: agentId });
    if (agents.length === 0) {
      return Response.json({ error: 'Agent not found' }, { status: 404 });
    }
    
    const agent = agents[0];

    // Fetch past learnings for context
    const learnings = await base44.asServiceRole.entities.ArchitectLearning.filter({
      learning_type: 'best_practice'
    });
    
    const learningsContext = learnings.length > 0 
      ? `\n\nPast learnings to consider:\n${learnings.map(l => `- ${l.insight}`).join('\n')}`
      : '';

    // Use LLM to audit the agent configuration
    const auditResult = await base44.integrations.Core.InvokeLLM({
      prompt: `You are an expert AI agent architect. Audit this agent configuration for quality, clarity, and effectiveness.

AGENT CONFIGURATION:
- Name: ${agent.name}
- Description: ${agent.description || 'Not provided'}
- Personality: ${agent.personality || 'Not provided'}
- Custom Instructions: ${agent.custom_instructions || 'Not provided'}
- Abilities: ${JSON.stringify(agent.abilities || [])}
- Personality Preset: ${agent.personality_preset || 'Not set'}
- Tone Level: ${agent.tone_level || 'Default'}
- Verbosity Level: ${agent.verbosity_level || 'Default'}
${learningsContext}

Evaluate based on:
1. NAME CLARITY (0-20): Is it clear and memorable?
2. DESCRIPTION QUALITY (0-25): Is it specific about what the agent does?
3. PERSONALITY COHERENCE (0-20): Is the personality well-defined and consistent?
4. ABILITY ALIGNMENT (0-20): Do the abilities match the agent's purpose?
5. INSTRUCTION CLARITY (0-15): Are any custom instructions clear and useful?

For each issue found, categorize as:
- "critical": Blocks effectiveness
- "warning": Should be improved
- "suggestion": Nice to have

Return your analysis.`,
      response_json_schema: {
        type: "object",
        properties: {
          score: { type: "number" },
          status: { type: "string", enum: ["passed", "failed", "needs_review"] },
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                category: { type: "string" },
                severity: { type: "string", enum: ["critical", "warning", "suggestion"] },
                message: { type: "string" }
              }
            }
          },
          suggestions: {
            type: "array",
            items: { type: "string" }
          },
          summary: { type: "string" }
        }
      }
    });

    // Determine status based on score
    let status = "passed";
    if (auditResult.score < 50) {
      status = "failed";
    } else if (auditResult.score < 75) {
      status = "needs_review";
    }

    // Save the audit report
    const report = await base44.entities.AgentAuditReport.create({
      agent_id: agentId,
      agent_name: agent.name,
      status: status,
      score: auditResult.score,
      findings: auditResult.findings || [],
      suggestions: auditResult.suggestions || [],
      audit_type: "configuration"
    });

    // Proactively check if score is below threshold
    if (auditResult.score < 70) {
      await base44.functions.invoke('proactiveMonitor', {
        action: 'check',
        agentId,
        auditScore: auditResult.score
      });
    }

    return Response.json({
      success: true,
      report: {
        id: report.id,
        agent_name: agent.name,
        status: status,
        score: auditResult.score,
        findings: auditResult.findings,
        suggestions: auditResult.suggestions,
        summary: auditResult.summary
      }
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});