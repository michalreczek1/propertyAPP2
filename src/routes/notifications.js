'use strict';

const router = require('express').Router();
const {
  getNotificationSettings,
  saveNotificationSettings,
  runNotificationScan,
  listLogs,
  processDueRetries,
  sendTestSms,
} = require('../services/notifications');

router.get('/settings', (req, res) => {
  res.json(getNotificationSettings(req));
});

router.put('/settings', (req, res) => {
  try {
    res.json(saveNotificationSettings(req, req.body || {}));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || 'invalid_notification_settings' });
  }
});

router.get('/logs', (req, res) => {
  res.json(listLogs(req, req.query.limit));
});

router.post('/run', async (req, res, next) => {
  try {
    const body = req.body || {};
    const type = body.type || 'all';
    if (!['all', 'due_reminder', 'overdue'].includes(type)) {
      return res.status(400).json({ error: 'invalid_notification_type' });
    }
    const result = await runNotificationScan({
      req,
      type,
      dryRun: body.dry_run === true,
      today: body.today,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/retry', async (req, res, next) => {
  try {
    res.json(await processDueRetries(req));
  } catch (err) {
    next(err);
  }
});

router.post('/test', async (req, res) => {
  try {
    const body = req.body || {};
    res.json(await sendTestSms(req, body.phone, body.message));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'sms_test_failed' });
  }
});

module.exports = router;
