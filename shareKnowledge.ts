import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { action, knowledge, agentId } = await req.json();

    // Action: contribute - Add new knowledge to the shared pool
    if (action === 'contribute') {
      if (!knowledge) {
        return Response.json({ error: 'knowledge object required' }, { status: 400 });
      }

      const newKnowledge = await base44.asServiceRole.entities.SharedKnowledge.create({
        knowledge_type: knowledge.type || 'insight',
        title: knowledge.title,
        content: knowledge.content,
        contributed_by: knowledge.contributor || 'unknown',
        applicable_to: knowledge.applicable_to || ['all'],
        tags: knowledge.tags || [],
        confidence_score: knowledge.confidence || 50,
        is_validated: false
      });

      return Response.json({
        success: true,
        action: 'contribute',
        knowledge_id: newKnowledge.id
      });
    }

    // Action: query - Get relevant knowledge for a specific context
    if (action === 'query') {
      const { query, tags, limit } = await req.json();
      
      let allKnowledge = await base44.asServiceRole.entities.SharedKnowledge.filter({
        is_validated: true
      });

      // Filter by tags if provided
      if (tags && tags.length > 0) {
        allKnowledge = allKnowledge.filter(k => 
          k.tags?.some(t => tags.includes(t))
        );
      }

      // If query provided, use LLM to rank relevance
      if (query) {
        const ranked = await base44.integrations.Core.InvokeLLM({
          prompt: `Rank these knowledge items by relevance to the query.

QUERY: ${query}

KNOWLEDGE ITEMS:
${allKnowledge.slice(0, 20).map((k, i) => `${i + 1}. [${k.knowledge_type}] ${k.title}: ${k.content}`).join('\n')}

Return the indices of the top 5 most relevant items.`,
          response_json_schema: {
            type: "object",
            properties: {
              relevant_indices: { type: "array", items: { type: "number" } }
            }
          }
        });

        const relevantItems = ranked.relevant_indices
          .map(i => allKnowledge[i - 1])
          .filter(Boolean);

        return Response.json({
          success: true,
          action: 'query',
          results: relevantItems.slice(0, limit || 5)
        });
      }

      // Return top by confidence
      return Response.json({
        success: true,
        action: 'query',
        results: allKnowledge
          .sort((a, b) => b.confidence_score - a.confidence_score)
          .slice(0, limit || 10)
      });
    }

    // Action: validate - Mark knowledge as validated
    if (action === 'validate') {
      const { knowledgeId, validated, feedback } = await req.json();
      
      if (!knowledgeId) {
        return Response.json({ error: 'knowledgeId required' }, { status: 400 });
      }

      await base44.asServiceRole.entities.SharedKnowledge.update(knowledgeId, {
        is_validated: validated !== false,
        confidence_score: validated !== false ? 80 : 30
      });

      return Response.json({
        success: true,
        action: 'validate',
        knowledge_id: knowledgeId,
        validated: validated !== false
      });
    }

    // Action: apply - Record that knowledge was used and its outcome
    if (action === 'apply') {
      const { knowledgeId, success } = await req.json();
      
      if (!knowledgeId) {
        return Response.json({ error: 'knowledgeId required' }, { status: 400 });
      }

      const existing = await base44.asServiceRole.entities.SharedKnowledge.filter({ id: knowledgeId });
      if (existing.length === 0) {
        return Response.json({ error: 'Knowledge not found' }, { status: 404 });
      }

      const k = existing[0];
      const newTimesUsed = (k.times_used || 0) + 1;
      const oldSuccessRate = k.success_rate || 0;
      const newSuccessRate = ((oldSuccessRate * (newTimesUsed - 1)) + (success ? 100 : 0)) / newTimesUsed;

      await base44.asServiceRole.entities.SharedKnowledge.update(knowledgeId, {
        times_used: newTimesUsed,
        success_rate: Math.round(newSuccessRate)
      });

      return Response.json({
        success: true,
        action: 'apply',
        knowledge_id: knowledgeId,
        new_success_rate: newSuccessRate
      });
    }

    // Action: sync - Synchronize learnings to shared knowledge
    if (action === 'sync') {
      const learnings = await base44.asServiceRole.entities.ArchitectLearning.filter({
        outcome: 'positive'
      });

      const existingKnowledge = await base44.asServiceRole.entities.SharedKnowledge.list();
      const existingTitles = new Set(existingKnowledge.map(k => k.title));

      let synced = 0;
      for (const learning of learnings) {
        if (!existingTitles.has(learning.insight.substring(0, 50))) {
          await base44.asServiceRole.entities.SharedKnowledge.create({
            knowledge_type: learning.learning_type === 'best_practice' ? 'rule' : 'insight',
            title: learning.insight.substring(0, 50),
            content: learning.insight,
            contributed_by: 'architect',
            applicable_to: learning.related_agent_ids?.length > 0 ? learning.related_agent_ids : ['all'],
            tags: [learning.learning_type],
            confidence_score: learning.confidence || 50,
            is_validated: learning.times_applied > 2
          });
          synced++;
        }
      }

      return Response.json({
        success: true,
        action: 'sync',
        learnings_processed: learnings.length,
        new_knowledge_created: synced
      });
    }

    return Response.json({ error: 'Invalid action. Use: contribute, query, validate, apply, sync' }, { status: 400 });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});