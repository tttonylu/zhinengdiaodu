function createScriptsRepo(db) {
  function listSets() {
    return db
      .prepare('SELECT * FROM script_sets ORDER BY sort_order, id')
      .all();
  }

  function findSet(setId) {
    return db.prepare('SELECT * FROM script_sets WHERE set_id = ?').get(setId);
  }

  function getTemplates(setId) {
    return db
      .prepare('SELECT template_type, content FROM script_templates WHERE set_id = ?')
      .all(setId);
  }

  function getFullSet(setId) {
    const set = findSet(setId);
    if (!set) return null;
    const templates = getTemplates(setId);
    const templateMap = {};
    for (const t of templates) {
      templateMap[t.template_type] = t.content;
    }
    return { ...set, templates: templateMap };
  }

  function listFullSets() {
    const sets = listSets();
    return sets.map((s) => {
      const templates = getTemplates(s.set_id);
      const templateMap = {};
      for (const t of templates) {
        templateMap[t.template_type] = t.content;
      }
      return { ...s, templates: templateMap };
    });
  }

  function upsertSet(setId, data) {
    const existing = findSet(setId);
    if (existing) {
      db.prepare(
        `UPDATE script_sets SET name = ?, description = ?, enabled = ?, updated_at = datetime('now', '+8 hours') WHERE set_id = ?`
      ).run(data.name || existing.name, data.description ?? existing.description, (data.enabled != null ? (data.enabled ? 1 : 0) : existing.enabled), setId);
    } else {
      db.prepare(
        `INSERT INTO script_sets (set_id, name, description, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))`
      ).run(setId, data.name || setId, data.description || '', (data.enabled != null ? (data.enabled ? 1 : 0) : 1), data.sort_order || 0);
    }
  }

  function upsertTemplate(setId, templateType, content) {
    db.prepare(
      `INSERT INTO script_templates (set_id, template_type, content, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
       ON CONFLICT(set_id, template_type) DO UPDATE SET content = excluded.content, updated_at = datetime('now', '+8 hours')`
    ).run(setId, templateType, content);
  }

  function deleteSet(setId) {
    db.prepare('DELETE FROM script_templates WHERE set_id = ?').run(setId);
    db.prepare('DELETE FROM script_sets WHERE set_id = ?').run(setId);
  }

  function setEnabled(setId, enabled) {
    const val = enabled ? 1 : 0;
    db.prepare("UPDATE script_sets SET enabled = ?, updated_at = datetime('now', '+8 hours') WHERE set_id = ?")
      .run(val, setId);
  }

  function getSetting(key) {
    const row = db.prepare("SELECT value FROM script_settings WHERE key = ?").get(key);
    return row ? row.value : null;
  }

  function setSetting(key, value) {
    db.prepare(
      `INSERT INTO script_settings (key, value, updated_at) VALUES (?, ?, datetime('now', '+8 hours'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')`
    ).run(key, value);
  }

  function getPoolPayload() {
    const sets = listFullSets().filter(s => s.enabled);
    const shuffleMode = getSetting('shuffle_mode') || 'random';
    const templateTypes = ['icebreaker', 'ad_template', 'kick_message', 'reject_message', 'foreigner_reject'];
    return {
      version: '2.0',
      mode: shuffleMode,
      random_pool: sets.map(s => s.set_id),
      scripts: Object.fromEntries(sets.map(s => {
        const script = {
          name: s.name,
          description: s.description || ''
        };
        for (const t of templateTypes) {
          script[t] = (s.templates && s.templates[t]) || '';
        }
        return [s.set_id, script];
      }))
    };
  }

  return {
    listSets,
    findSet,
    getTemplates,
    getFullSet,
    listFullSets,
    upsertSet,
    upsertTemplate,
    deleteSet,
    setEnabled,
    getSetting,
    setSetting,
    getPoolPayload,
  };
}

module.exports = { createScriptsRepo };