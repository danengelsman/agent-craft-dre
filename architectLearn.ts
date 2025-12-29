import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { action } = await req.json();

    // Action: analyze - Analyze all recent audits and simulations to extract learnings
    if (action === 'analyze') {
      // Get recent audit reports
      const audits = await base44.entities.AgentAuditReport.list('-created_date', 20);
      
      // Get recent simulation results
      const simulations = await base44.entities.AgentSimulationResult.list('-created_date', 50);
      
      // Get existing learnings
      const existingLearnings = await base44.asServiceRole.entities.ArchitectLearning.list('-created_date', 50);

      // Use LLM to extract new learnings
      const analysis = await base44.integrations.Core.InvokeLLM({
        prompt: `You are the Architect AI. Analyze recent agent performance data to extract learnings.

RECENT AUDIT REPORTS (${audits.length} total):
${audits.slice(0, 10).map(a => `- ${a.agent_name}: Score ${a.score}, Status: ${a.status}, Findings: ${a.findings?.length || 0}`).join('\n')}

RECENT SIMULATION RESULTS (${simulations.length} total):
${simulations.slice(0, 15).map(s => `- ${s.agent_name} [${s.scenario_name}]: ${s.passed ? 'PASSED' : 'FAILED'} (Quality: ${s.quality_score})`).join('\n')}

EXISTING LEARNINGS TO BUILD ON:
${existingLearnings.slice(0, 10).map(l => `- [${l.learning_type}] ${l.insight} (Confidence: ${l.confidence})`).join('\n')}

Extract NEW insights that aren't already captured. Focus on:
1. Patterns in what makes agents succeed or fail
2. Common mistakes to avoid
3. Best practices that lead to high scores
4. Improvements that could be applied broadly

Return 1-3 new learnings, or empty array if no new insights.`,
        response_json_schema: {
          type: "object",
          properties: {
            learnings: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  learning_type: { type: "string", enum: ["pattern", "mistake", "improvement", "best_practice"] },
                  context: { type: "string" },
                  insight: { type: "string" },
                  confidence: { type: "number" }
                }
              }
            },
            summary: { type: "string" }
          }
        }
      });

      // Save new learnings
      const savedLearnings = [];
      for (const learning of analysis.learnings || []) {
        const saved = await base44.asServiceRole.entities.ArchitectLearning.create({
          learning_type: learning.learning_type,
          context: learning.context,
          insight: learning.insight,
          confidence: learning.confidence,
          outcome: 'neutral',
          times_applied: 0
        });
        savedLearnings.push(saved);
      }

      return Response.json({
        success: true,
        new_learnings: savedLearnings.length,
        learnings: savedLearnings,
        summary: analysis.summary
      });
    }

    // Action: suggest - Get improvement suggestions for a specific agent
    if (action === 'suggest') {
      const { agentId } = await req.json();
      
      if (!agentId) {
        return Response.json({ error: 'agentId required for suggest action' }, { status: 400 });
      }

      const agents = await base44.entities.Agent.filter({ id: agentId });
      if (agents.length === 0) {
        return Response.json({ error: 'Agent not found' }, { status: 404 });
      }
      
      const agent = agents[0];

      // Get learnings
      const learnings = await base44.asServiceRole.entities.ArchitectLearning.list('-confidence', 20);
      
      // Get agent's audit history
      const audits = await base44.entities.AgentAuditReport.filter({ agent_id: agentId });

      const suggestions = await base44.integrations.Core.InvokeLLM({
        prompt: `You are the Architect AI. Generate specific improvement suggestions for this agent.

AGENT:
- Name: ${agent.name}
- Description: ${agent.description}
- Personality: ${agent.personality || 'Not set'}
- Abilities: ${JSON.stringify(agent.abilities || [])}

AUDIT HISTORY:
${audits.map(a => `- Score: ${a.score}, Status: ${a.status}`).join('\n') || 'No previous audits'}

LEARNINGS TO APPLY:
${learnings.map(l => `- [${l.learning_type}] ${l.insight}`).join('\n')}

Generate specific, actionable improvements for this agent.`,
        response_json_schema: {
          type: "object",
          properties: {
            suggestions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  field: { type: "string" },
                  current_value: { type: "string" },
                  suggested_value: { type: "string" },
                  reason: { type: "string" },
                  priority: { type: "string", enum: ["high", "medium", "low"] }
                }
              }
            },
            overall_assessment: { type: "string" }
          }
        }
      });

      return Response.json({
        success: true,
        agent_name: agent.name,
        suggestions: suggestions.suggestions,
        assessment: suggestions.overall_assessment
      });
    }

    return Response.json({ error: 'Invalid action. Use: analyze, suggest' }, { status: 400 });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});