import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { fromAgent, toAgent, task, payload, collaborationId } = await req.json();

    if (!fromAgent || !toAgent || !task) {
      return Response.json({ error: 'fromAgent, toAgent, and task are required' }, { status: 400 });
    }

    // Log the inter-agent message
    const message = await base44.entities.AgentMessage.create({
      from_agent: fromAgent,
      to_agent: toAgent,
      collaboration_id: collaborationId || null,
      message_type: "task_request",
      subject: task,
      content: `Task request from ${fromAgent} to ${toAgent}: ${task}`,
      payload: payload || {},
      priority: "normal",
      status: "sent"
    });

    // Get shared knowledge relevant to this task
    const relevantKnowledge = await base44.asServiceRole.entities.SharedKnowledge.filter({
      is_validated: true
    });

    // Build context from shared knowledge
    const knowledgeContext = relevantKnowledge
      .slice(0, 10)
      .map(k => `[${k.knowledge_type}] ${k.title}: ${k.content}`)
      .join('\n');

    // Execute the task based on target agent
    let result = {};

    if (toAgent === "architect" || toAgent === "auditor") {
      if (task.includes("audit")) {
        const agentId = payload?.agentId;
        if (agentId) {
          const auditResponse = await base44.functions.invoke('auditAgentConfiguration', { agentId });
          result = auditResponse.data;
        }
      } else if (task.includes("simulate")) {
        const agentId = payload?.agentId;
        if (agentId) {
          const simResponse = await base44.functions.invoke('simulateAgentInteraction', { agentId });
          result = simResponse.data;
        }
      } else if (task.includes("learn") || task.includes("analyze")) {
        const learnResponse = await base44.functions.invoke('architectLearn', { action: 'analyze' });
        result = learnResponse.data;
      } else if (task.includes("suggest") || task.includes("improve")) {
        const agentId = payload?.agentId;
        if (agentId) {
          const suggestResponse = await base44.functions.invoke('architectLearn', { action: 'suggest', agentId });
          result = suggestResponse.data;
        }
      }
    } else {
      // Generic LLM-based task execution
      const taskResult = await base44.integrations.Core.InvokeLLM({
        prompt: `You are agent "${toAgent}". Execute this task from "${fromAgent}":

TASK: ${task}

PAYLOAD: ${JSON.stringify(payload || {})}

SHARED KNOWLEDGE:
${knowledgeContext}

Execute the task and return a structured response.`,
        response_json_schema: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            result: { type: "object" },
            message: { type: "string" }
          }
        }
      });
      result = taskResult;
    }

    // Update message status
    await base44.entities.AgentMessage.update(message.id, {
      status: "processed"
    });

    // Send response message
    await base44.entities.AgentMessage.create({
      from_agent: toAgent,
      to_agent: fromAgent,
      collaboration_id: collaborationId || null,
      message_type: "task_response",
      subject: `Response: ${task}`,
      content: `Task completed by ${toAgent}`,
      payload: result,
      status: "sent"
    });

    return Response.json({
      success: true,
      message_id: message.id,
      from: fromAgent,
      to: toAgent,
      task,
      result
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});