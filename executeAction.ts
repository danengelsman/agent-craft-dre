import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { actionId, agentId, inputData, collaborationId } = await req.json();

    if (!actionId) {
      return Response.json({ error: 'actionId required' }, { status: 400 });
    }

    // Get the action definition
    const actions = await base44.entities.AgentAction.filter({ id: actionId });
    if (actions.length === 0) {
      return Response.json({ error: 'Action not found' }, { status: 404 });
    }
    const action = actions[0];

    // Get agent info if provided
    let agentName = null;
    if (agentId) {
      const agents = await base44.entities.Agent.filter({ id: agentId });
      if (agents.length > 0) agentName = agents[0].name;
    }

    // Create execution log
    const startTime = Date.now();
    const execution = await base44.entities.ActionExecution.create({
      action_id: actionId,
      action_name: action.name,
      agent_id: agentId || null,
      agent_name: agentName,
      collaboration_id: collaborationId || null,
      status: 'running',
      input_data: inputData || {}
    });

    let result = {};
    let status = 'success';
    let errorMessage = null;

    try {
      // Execute based on action type
      switch (action.action_type) {
        case 'send_email': {
          const { to, subject, body } = inputData;
          await base44.integrations.Core.SendEmail({ to, subject, body });
          result = { sent: true, to };
          break;
        }

        case 'http_request': {
          const config = action.config || {};
          let url = config.url || '';
          let body = config.body_template || '';

          // Replace placeholders with input data
          for (const [key, value] of Object.entries(inputData || {})) {
            url = url.replace(`{{${key}}}`, value);
            body = body.replace(`{{${key}}}`, value);
          }

          const fetchOptions = {
            method: config.method || 'GET',
            headers: { 'Content-Type': 'application/json', ...(config.headers || {}) }
          };

          if (['POST', 'PUT', 'PATCH'].includes(fetchOptions.method) && body) {
            fetchOptions.body = body;
          }

          const response = await fetch(url, fetchOptions);
          const responseData = await response.json().catch(() => response.text());
          result = { status: response.status, data: responseData };
          
          if (!response.ok) {
            status = 'failed';
            errorMessage = `HTTP ${response.status}`;
          }
          break;
        }

        case 'custom_function': {
          const functionName = action.config?.function_name;
          if (functionName) {
            const funcResponse = await base44.functions.invoke(functionName, inputData || {});
            result = funcResponse.data;
          }
          break;
        }

        case 'slack_message': {
          // Placeholder - would need OAuth connector
          result = { message: 'Slack integration requires OAuth setup', inputData };
          break;
        }

        case 'calendar_event': {
          // Placeholder - would need OAuth connector
          result = { message: 'Calendar integration requires OAuth setup', inputData };
          break;
        }

        case 'database_query': {
          const { entity, operation, data, query } = inputData;
          if (entity && operation) {
            switch (operation) {
              case 'list':
                result = await base44.entities[entity]?.list?.() || [];
                break;
              case 'filter':
                result = await base44.entities[entity]?.filter?.(query || {}) || [];
                break;
              case 'create':
                result = await base44.entities[entity]?.create?.(data || {});
                break;
              default:
                result = { error: 'Unknown operation' };
            }
          }
          break;
        }

        default:
          result = { message: `Action type ${action.action_type} not implemented` };
      }

    } catch (execError) {
      status = 'failed';
      errorMessage = execError.message;
      result = { error: execError.message };
    }

    const executionTime = Date.now() - startTime;

    // Update execution log
    await base44.entities.ActionExecution.update(execution.id, {
      status,
      output_data: result,
      error_message: errorMessage,
      execution_time_ms: executionTime,
      cost_cents: action.estimated_cost || 0
    });

    return Response.json({
      success: status === 'success',
      execution_id: execution.id,
      action_name: action.name,
      status,
      result,
      error: errorMessage,
      execution_time_ms: executionTime
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});