import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { agentId, scenarios } = await req.json();
    
    if (!agentId) {
      return Response.json({ error: 'agentId is required' }, { status: 400 });
    }

    // Default test scenarios if none provided
    const testScenarios = scenarios || [
      {
        name: "greeting",
        userMessage: "Hello, can you help me?",
        expectedBehavior: "Responds warmly and asks how to help"
      },
      {
        name: "capabilities",
        userMessage: "What can you do?",
        expectedBehavior: "Clearly explains its capabilities"
      },
      {
        name: "edge_case",
        userMessage: "asdfghjkl random gibberish",
        expectedBehavior: "Handles unclear input gracefully"
      }
    ];

    // Fetch the agent
    const agents = await base44.entities.Agent.filter({ id: agentId });
    if (agents.length === 0) {
      return Response.json({ error: 'Agent not found' }, { status: 404 });
    }
    
    const agent = agents[0];
    const results = [];

    // Build the agent's system prompt
    let systemPrompt = `You are ${agent.name}, an AI assistant. ${agent.description || ''}\n`;
    if (agent.personality) {
      systemPrompt += `Your personality: ${agent.personality}\n`;
    }
    if (agent.custom_instructions) {
      systemPrompt += `Instructions: ${agent.custom_instructions}\n`;
    }

    // Run each scenario
    for (const scenario of testScenarios) {
      const startTime = Date.now();
      
      // Get agent response
      const response = await base44.integrations.Core.InvokeLLM({
        prompt: `${systemPrompt}\n\nUser: ${scenario.userMessage}\n\nAssistant:`
      });
      
      const responseTime = Date.now() - startTime;

      // Evaluate the response
      const evaluation = await base44.integrations.Core.InvokeLLM({
        prompt: `Evaluate this AI agent's response.

SCENARIO: ${scenario.name}
USER MESSAGE: ${scenario.userMessage}
EXPECTED BEHAVIOR: ${scenario.expectedBehavior}
AGENT RESPONSE: ${response}

Evaluate:
1. Did the response meet the expected behavior?
2. Was it appropriate and helpful?
3. Quality score 0-100

Be strict but fair.`,
        response_json_schema: {
          type: "object",
          properties: {
            passed: { type: "boolean" },
            quality_score: { type: "number" },
            feedback: { type: "string" }
          }
        }
      });

      // Save result
      const result = await base44.entities.AgentSimulationResult.create({
        agent_id: agentId,
        agent_name: agent.name,
        scenario_name: scenario.name,
        user_message: scenario.userMessage,
        agent_response: response,
        expected_pattern: scenario.expectedBehavior,
        passed: evaluation.passed,
        feedback: evaluation.feedback,
        response_time_ms: responseTime,
        quality_score: evaluation.quality_score
      });

      results.push({
        scenario: scenario.name,
        passed: evaluation.passed,
        quality_score: evaluation.quality_score,
        feedback: evaluation.feedback,
        response_time_ms: responseTime
      });
    }

    // Calculate overall pass rate
    const passRate = results.filter(r => r.passed).length / results.length * 100;
    const avgQuality = results.reduce((sum, r) => sum + r.quality_score, 0) / results.length;

    // Proactively check if pass rate is below threshold
    if (passRate < 80) {
      await base44.functions.invoke('proactiveMonitor', {
        action: 'check',
        agentId,
        passRate: passRate
      });
    }

    return Response.json({
      success: true,
      agent_name: agent.name,
      summary: {
        total_scenarios: results.length,
        passed: results.filter(r => r.passed).length,
        failed: results.filter(r => !r.passed).length,
        pass_rate: passRate,
        average_quality: avgQuality
      },
      results: results
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});