function createActivityLogsRepo(db) {
  return {
    insert(log) {
      return db
        .prepare(`
          INSERT INTO activity_logs (
            lead_id,
            account_id,
            action_type,
            action_result,
            from_stage,
            to_stage,
            source,
            detail_json,
            created_at
          ) VALUES (
            @lead_id,
            @account_id,
            @action_type,
            @action_result,
            @from_stage,
            @to_stage,
            @source,
            @detail_json,
            @created_at
          )
        `)
        .run(log);
    },
  };
}

module.exports = { createActivityLogsRepo };
