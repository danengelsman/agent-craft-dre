import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

const AUDIT_THRESHOLD = 70;
const SIMULATION_THRESHOLD = 80;

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { action, agentId, auditScore, passRate } = await req.json();

    // Action: check - Check a specific agent after audit/simulation
    if (action === 'check') {
      const results = { triggered: false, proposals: [] };

      // Check audit score
      if (auditScore !== undefined && auditScore < AUDIT_THRESHOLD) {
        const proposal = await createImprovementProposal(base44, {
          agentId,
          triggerReason: 'low_audit_score',
          triggerValue: auditScore,
          threshold: AUDIT_THRESHOLD
        });
        results.triggered = true;
        results.proposals.push(proposal);
      }

      // Check simulation pass rate
      if (passRate !== undefined && passRate < SIMULATION_THRESHOLD) {
        const proposal = await createImprovementProposal(base44, {
          agentId,
          triggerReason: 'low_pass_rate',
          triggerValue: passRate,
          threshold: SIMULATION_THRESHOLD
        });
        results.triggered = true;
        results.proposals.push(proposal);
      }

      return Response.json({ success: true, ...results });
    }

    // Action: scan - Scan all agents for issues
    if (action === 'scan') {
      const agents = await base44.entities.Agent.list();
      const results = { scanned: 0, proposals_created: 0, agents_flagged: [] };

      for (const agent of agents) {
        results.scanned++;

        // Get latest audit for this agent
        const audits = await base44.entities.AgentAuditReport.filter({ agent_id: agent.id });
        const latestAudit = audits.sort((a, b) => new Date(b.created_date) - new Date(a.created_date))[0];

        // Get latest simulations for this agent
        const simulations = await base44.entities.AgentSimulationResult.filter({ agent_id: agent.id });
        const recentSims = simulations.slice(0, 10);
        const passRate = recentSims.length > 0 
          ? (recentSims.filter(s => s.passed).length / recentSims.length) * 100 
          : null;

        // Check for existing pending proposals
        const existingProposals = await base44.entities.ImprovementProposal.filter({
          agent_id: agent.id,
          status: 'pending_review'
        });

        if (existingProposals.length > 0) {
          continue; // Skip if already has pending proposal
        }

        let needsProposal = false;
        let triggerReason = null;
        let triggerValue = null;
        let threshold = null;

        if (latestAudit && latestAudit.score < AUDIT_THRESHOLD) {
          needsProposal = true;
          triggerReason = 'low_audit_score';
          triggerValue = latestAudit.score;
          threshold = AUDIT_THRESHOLD;
        } else if (passRate !== null && passRate < SIMULATION_THRESHOLD) {
          needsProposal = true;
          triggerReason = 'low_pass_rate';
          triggerValue = passRate;
          threshold = SIMULATION_THRESHOLD;
        }

        if (needsProposal) {
          await createImprovementProposal(base44, {
            agentId: agent.id,
            triggerReason,
            triggerValue,
            threshold
          });
          results.proposals_created++;
          results.agents_flagged.push(agent.name);
        }
      }

      return Response.json({ success: true, ...results });
    }

    // Action: apply - Apply an approved proposal
    if (action === 'apply') {
      const { proposalId } = await req.json();
      
      if (!proposalId) {
        return Response.json({ error: 'proposalId required' }, { status: 400 });
      }

      const proposals = await base44.entities.ImprovementProposal.filter({ id: proposalId });
      if (proposals.length === 0) {
        return Response.json({ error: 'Proposal not found' }, { status: 404 });
      }

      const proposal = proposals[0];
      if (proposal.status !== 'approved') {
        return Response.json({ error: 'Proposal must be approved before applying' }, { status: 400 });
      }

      // Get the agent
      const agents = await base44.entities.Agent.filter({ id: proposal.agent_id });
      if (agents.length === 0) {
        return Response.json({ error: 'Agent not found' }, { status: 404 });
      }

      const agent = agents[0];
      const updates = {};

      // Apply each suggestion
      for (const suggestion of proposal.suggestions || []) {
        if (suggestion.field && suggestion.suggested_value) {
          updates[suggestion.field] = suggestion.suggested_value;
        }
      }

      if (Object.keys(updates).length > 0) {
        await base44.entities.Agent.update(agent.id, updates);
      }

      // Mark proposal as applied
      await base44.entities.ImprovementProposal.update(proposalId, {
        status: 'applied'
      });

      // Log the change
      await base44.entities.AgentMessage.create({
        from_agent: 'architect',
        to_agent: 'system',
        message_type: 'status_update',
        subject: `Applied improvements to ${agent.name}`,
        content: `Applied ${Object.keys(updates).length} changes based on proposal ${proposalId}`,
        payload: { updates, proposalId }
      });

      return Response.json({ 
        success: true, 
        applied_changes: Object.keys(updates).length,
        updates 
      });
    }

    return Response.json({ error: 'Invalid action. Use: check, scan, apply' }, { status: 400 });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});

async function createImprovementProposal(base44, { agentId, triggerReason, triggerValue, threshold }) {
  // Get agent details
  const agents = await base44.entities.Agent.filter({ id: agentId });
  if (agents.length === 0) {
    throw new Error('Agent not found');
  }
  const agent = agents[0];

  // Get suggestions from architectLearn
  const suggestResponse = await base44.functions.invoke('architectLearn', { 
    action: 'suggest', 
    agentId 
  });
  const suggestions = suggestResponse.data;

  // Determine priority based on how far below threshold
  let priority = 'medium';
  const gap = threshold - triggerValue;
  if (gap > 30) priority = 'critical';
  else if (gap > 20) priority = 'high';
  else if (gap < 10) priority = 'low';

  // Create the improvement proposal
  const proposal = await base44.entities.ImprovementProposal.create({
    agent_id: agentId,
    agent_name: agent.name,
    trigger_reason: triggerReason,
    trigger_value: triggerValue,
    threshold: threshold,
    status: 'pending_review',
    priority: priority,
    suggestions: suggestions.suggestions || [],
    overall_assessment: suggestions.assessment || `Agent ${agent.name} needs improvement. ${triggerReason === 'low_audit_score' ? 'Audit score' : 'Simulation pass rate'} is ${triggerValue}%, below threshold of ${threshold}%.`
  });

  // Create a draft collaboration workflow
  const collaboration = await base44.entities.AgentCollaboration.create({
    workflow_name: `Improvement: ${agent.name}`,
    orchestrator_agent: 'architect',
    participating_agents: ['architect'],
    status: 'pending',
    workflow_type: 'improvement_cycle',
    steps: [
      { step_number: 1, agent_id: 'architect', action: 'apply_suggestions', status: 'pending', input: { proposalId: proposal.id }, output: {} },
      { step_number: 2, agent_id: 'architect', action: 'audit_config', status: 'pending', input: { agentId }, output: {} },
      { step_number: 3, agent_id: 'architect', action: 'simulate', status: 'pending', input: { agentId }, output: {} },
      { step_number: 4, agent_id: 'architect', action: 'validate', status: 'pending', input: {}, output: {} }
    ],
    shared_context: { proposalId: proposal.id, agentId, triggerReason }
  });

  // Link collaboration to proposal
  await base44.entities.ImprovementProposal.update(proposal.id, {
    collaboration_id: collaboration.id
  });

  // Send notification message
  await base44.entities.AgentMessage.create({
    from_agent: 'architect',
    to_agent: 'admin',
    message_type: 'task_request',
    subject: `[${priority.toUpperCase()}] Improvement needed: ${agent.name}`,
    content: `Agent "${agent.name}" has ${triggerReason === 'low_audit_score' ? 'an audit score' : 'a simulation pass rate'} of ${triggerValue}% (threshold: ${threshold}%). Review proposal #${proposal.id} for suggested improvements.`,
    payload: { proposalId: proposal.id, collaborationId: collaboration.id },
    priority: priority === 'critical' ? 'urgent' : priority === 'high' ? 'high' : 'normal'
  });

  return proposal;
}