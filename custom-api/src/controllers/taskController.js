const ReviewWorkflow = require('../models/reviewWorkflow');

async function getReviewQueue(req, res) {
  try {
    const queue = await ReviewWorkflow.getReviewQueue(req.user.sub);
    res.json(queue);
  } catch (err) {
    console.error('Error fetching review queue:', err);
    res.status(500).json({ error: 'Failed to fetch review queue' });
  }
}

async function submitTask(req, res) {
  try {
    const { id } = req.params;
    const result = await ReviewWorkflow.submit(id, req.user.sub);
    if (!result) {
      return res.status(404).json({ error: 'Task not found or not in progress' });
    }
    res.json(result);
  } catch (err) {
    console.error('Error submitting task:', err);
    res.status(500).json({ error: 'Failed to submit task' });
  }
}

async function approveTask(req, res) {
  try {
    const { id } = req.params;
    const { note } = req.body || {};
    const result = await ReviewWorkflow.approve(id, req.user.sub, note);
    if (!result) {
      return res.status(404).json({ error: 'Task not found or not submitted for review' });
    }
    res.json(result);
  } catch (err) {
    console.error('Error approving task:', err);
    res.status(500).json({ error: 'Failed to approve task' });
  }
}

async function rejectTask(req, res) {
  try {
    const { id } = req.params;
    const { note } = req.body || {};
    const result = await ReviewWorkflow.reject(id, req.user.sub, note);
    if (!result) {
      return res.status(404).json({ error: 'Task not found or not submitted for review' });
    }
    res.json(result);
  } catch (err) {
    console.error('Error rejecting task:', err);
    res.status(500).json({ error: 'Failed to reject task' });
  }
}

module.exports = { getReviewQueue, submitTask, approveTask, rejectTask };
