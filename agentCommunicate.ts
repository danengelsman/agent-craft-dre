import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { fromAgentId, toAgentId, messageType, subject, content, payload, priority = "normal" } = await req.json();

    if (!fromAgentId || !toAgentId || !messageType || !content) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Get both agents
    const [fromAgent, toAgent] = await Promise.all([
      base44.entities.Agent.filter({ id: fromAgentId }),
      base44.entities.Agent.filter({ id: toAgentId })
    ]);

    if (!fromAgent[0] || !toAgent[0]) {
      return Response.json({ error: 'Agent not found' }, { status: 404 });
    }

    // Create the message
    const message = await base44.entities.AgentMessage.create({
      from_agent: fromAgent[0].name,
      to_agent: toAgent[0].name,
      message_type: messageType,
      subject: subject || `Request from ${fromAgent[0].name}`,
      content,
      payload: payload || {},
      priority,
      status: "sent"
    });

    // Process the message based on type
    let response = null;
    let actionExecuted = null;

    if (messageType === "task_request") {
      // Execute the task on the target agent
      const taskPrompt = `${toAgent[0].description}\n\nYou received a request from ${fromAgent[0].name}: ${content}\n\n${payload.context ? `Context: ${JSON.stringify(payload.context)}\n\n` : ''}Please respond with the requested information or action.`;

      const llmResponse = await base44.integrations.Core.InvokeLLM({
        prompt: taskPrompt,
        add_context_from_internet: toAgent[0].abilities?.includes("web_search")
      });

      response = {
        content: llmResponse,
        timestamp: new Date().toISOString()
      };

      // Update message status
      await base44.entities.AgentMessage.update(message.id, {
        status: "processed"
      });

      // If the target agent has actions assigned, check if it should execute them
      if (toAgent[0].assigned_actions?.length > 0 && payload.executeAction) {
        const actions = await base44.entities.AgentAction.filter({});
        const agentActions = actions.filter(a => toAgent[0].assigned_actions.includes(a.id));

        // Simple keyword matching to find relevant action
        const relevantAction = agentActions.find(a => 
          content.toLowerCase().includes(a.name.toLowerCase()) ||
          a.description.toLowerCase().includes(content.toLowerCase().split(' ')[0])
        );

        if (relevantAction) {
          const execResult = await base44.functions.invoke('executeAction', {
            actionId: relevantAction.id,
            agentId: toAgent[0].id,
            inputData: payload.actionInput || { request: content }
          });

          actionExecuted = {
            action_name: relevantAction.name,
            status: execResult.data.success ? 'success' : 'failed',
            result: execResult.data.result,
            error: execResult.data.error
          };
        }
      }

      // Create response message
      await base44.entities.AgentMessage.create({
        from_agent: toAgent[0].name,
        to_agent: fromAgent[0].name,
        message_type: "task_response",
        subject: `Re: ${subject || 'Request'}`,
        content: llmResponse,
        payload: {
          original_request: content,
          action_executed: actionExecuted
        },
        priority,
        status: "sent"
      });
    } else if (messageType === "knowledge_share") {
      // Store as shared knowledge
      await base44.entities.SharedKnowledge.create({
        knowledge_type: payload.knowledgeType || "insight",
        title: subject,
        content,
        contributed_by: fromAgent[0].name,
        applicable_to: [toAgent[0].name],
        tags: payload.tags || [],
        confidence_score: payload.confidence || 75,
        times_used: 0,
        success_rate: 0,
        is_validated: false
      });

      await base44.entities.AgentMessage.update(message.id, {
        status: "processed"
      });

      response = {
        content: "Knowledge shared successfully",
        timestamp: new Date().toISOString()
      };
    }

    return Response.json({
      success: true,
      message_id: message.id,
      response,
      action_executed: actionExecuted
    });

  } catch (error) {
    console.error('Agent communication error:', error);
    return Response.json({ 
      error: error.message,
      success: false
    }, { status: 500 });
  }
});