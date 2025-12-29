import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { workflowType, targetAgentId, options } = await req.json();

    // Define workflow templates
    const workflows = {
      audit_pipeline: {
        name: "Full Agent Audit Pipeline",
        steps: [
          { agent: "architect", action: "audit_config", description: "Audit agent configuration" },
          { agent: "architect", action: "simulate", description: "Run interaction simulations" },
          { agent: "architect", action: "analyze", description: "Analyze results and learn" },
          { agent: "architect", action: "suggest", description: "Generate improvements" }
        ]
      },
      improvement_cycle: {
        name: "Agent Improvement Cycle",
        steps: [
          { agent: "architect", action: "audit_config", description: "Initial audit" },
          { agent: "architect", action: "apply_improvements", description: "Apply suggested changes" },
          { agent: "architect", action: "simulate", description: "Test improvements" },
          { agent: "architect", action: "validate", description: "Validate improvements" }
        ]
      },
      knowledge_sync: {
        name: "Knowledge Synchronization",
        steps: [
          { agent: "architect", action: "gather_learnings", description: "Collect all learnings" },
          { agent: "architect", action: "consolidate", description: "Merge and deduplicate" },
          { agent: "architect", action: "distribute", description: "Share with all agents" }
        ]
      }
    };

    const workflow = workflows[workflowType];
    if (!workflow) {
      return Response.json({ error: 'Invalid workflow type' }, { status: 400 });
    }

    // Create collaboration record
    const collaboration = await base44.entities.AgentCollaboration.create({
      workflow_name: workflow.name,
      orchestrator_agent: "architect",
      participating_agents: ["architect"],
      status: "in_progress",
      workflow_type: workflowType,
      steps: workflow.steps.map((step, i) => ({
        step_number: i + 1,
        agent_id: step.agent,
        action: step.action,
        status: "pending",
        input: {},
        output: {}
      })),
      shared_context: { targetAgentId, options },
      started_at: new Date().toISOString()
    });

    // Execute workflow steps
    const results = [];
    let sharedContext = { targetAgentId, options };

    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      
      // Update step status to in_progress
      const updatedSteps = [...collaboration.steps];
      updatedSteps[i].status = "in_progress";
      updatedSteps[i].started_at = new Date().toISOString();
      
      await base44.entities.AgentCollaboration.update(collaboration.id, {
        steps: updatedSteps
      });

      // Send inter-agent message
      await base44.entities.AgentMessage.create({
        from_agent: "orchestrator",
        to_agent: step.agent,
        collaboration_id: collaboration.id,
        message_type: "task_request",
        subject: step.description,
        content: `Execute ${step.action} for agent ${targetAgentId}`,
        payload: { action: step.action, context: sharedContext },
        priority: "high"
      });

      let stepResult = {};

      // Execute the action
      if (step.action === "audit_config" && targetAgentId) {
        const auditResponse = await base44.functions.invoke('auditAgentConfiguration', { agentId: targetAgentId });
        stepResult = auditResponse.data;
        sharedContext.auditResult = stepResult;
      } 
      else if (step.action === "simulate" && targetAgentId) {
        const simResponse = await base44.functions.invoke('simulateAgentInteraction', { agentId: targetAgentId });
        stepResult = simResponse.data;
        sharedContext.simulationResult = stepResult;
      }
      else if (step.action === "analyze") {
        const learnResponse = await base44.functions.invoke('architectLearn', { action: 'analyze' });
        stepResult = learnResponse.data;
        sharedContext.learnings = stepResult;
      }
      else if (step.action === "suggest" && targetAgentId) {
        const suggestResponse = await base44.functions.invoke('architectLearn', { action: 'suggest', agentId: targetAgentId });
        stepResult = suggestResponse.data;
        sharedContext.suggestions = stepResult;
      }
      else if (step.action === "gather_learnings") {
        const learnings = await base44.asServiceRole.entities.ArchitectLearning.list('-confidence', 100);
        const knowledge = await base44.asServiceRole.entities.SharedKnowledge.list('-confidence_score', 100);
        stepResult = { learnings: learnings.length, knowledge: knowledge.length };
        sharedContext.allLearnings = learnings;
        sharedContext.allKnowledge = knowledge;
      }
      else if (step.action === "consolidate") {
        // Use LLM to consolidate learnings
        const consolidation = await base44.integrations.Core.InvokeLLM({
          prompt: `Consolidate these learnings into key insights:\n${JSON.stringify(sharedContext.allLearnings?.slice(0, 20))}`,
          response_json_schema: {
            type: "object",
            properties: {
              consolidated_insights: { type: "array", items: { type: "string" } },
              key_patterns: { type: "array", items: { type: "string" } }
            }
          }
        });
        stepResult = consolidation;
        sharedContext.consolidatedInsights = consolidation;
      }
      else if (step.action === "distribute") {
        // Create shared knowledge entries
        const insights = sharedContext.consolidatedInsights?.consolidated_insights || [];
        for (const insight of insights.slice(0, 5)) {
          await base44.asServiceRole.entities.SharedKnowledge.create({
            knowledge_type: "insight",
            title: insight.substring(0, 50),
            content: insight,
            contributed_by: "architect",
            applicable_to: ["all"],
            confidence_score: 75,
            is_validated: true
          });
        }
        stepResult = { distributed: insights.length };
      }

      // Update step as completed
      updatedSteps[i].status = "completed";
      updatedSteps[i].output = stepResult;
      updatedSteps[i].completed_at = new Date().toISOString();
      
      await base44.entities.AgentCollaboration.update(collaboration.id, {
        steps: updatedSteps,
        shared_context: sharedContext
      });

      // Send completion message
      await base44.entities.AgentMessage.create({
        from_agent: step.agent,
        to_agent: "orchestrator",
        collaboration_id: collaboration.id,
        message_type: "task_response",
        subject: `Completed: ${step.description}`,
        content: `Step ${i + 1} completed successfully`,
        payload: stepResult,
        status: "processed"
      });

      results.push({ step: i + 1, action: step.action, result: stepResult });
    }

    // Mark workflow as completed
    await base44.entities.AgentCollaboration.update(collaboration.id, {
      status: "completed",
      final_output: { results, sharedContext },
      completed_at: new Date().toISOString()
    });

    return Response.json({
      success: true,
      collaboration_id: collaboration.id,
      workflow: workflow.name,
      steps_completed: results.length,
      results
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});