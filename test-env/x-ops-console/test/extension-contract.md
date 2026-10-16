# Extension Contract Checklist

- [ ] `MatrixConfig.getOpsConsoleServer()` returns the configured backend URL.
- [ ] `MatrixConfig.getOpsConsoleUrl('activityCheck')` returns the full activity-check URL.
- [ ] `background.js` can proxy `ops_activity_check`.
- [ ] `background.js` can proxy `ops_dm_check`.
- [ ] `background.js` can proxy `ops_activity_report`.
