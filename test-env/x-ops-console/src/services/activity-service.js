function createActivityService(activityLogsRepo) {
  return {
    record(log) {
      activityLogsRepo.insert(log);
    },
  };
}

module.exports = { createActivityService };
