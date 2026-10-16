// Keep controller imports lazy; the trigger host owns the composed services.
const getService = () => require('~/server/services/Agents/triggers').getScheduleService();

const invoke =
  (method) =>
  (...args) =>
    getService()[method](...args);

/** Host adapter for the generic generation runtime's approval-expiry seam. The
 * callback is intentionally idempotent: a replica relay or schedule reconciliation
 * may re-drive the same retained terminal evidence after a transient failure. */
async function recordExpiredScheduleApproval(streamId, job) {
  if (!job?.scheduleId || !job?.scheduledFor) {
    return;
  }
  const recorded = await getService().recordScheduleOutcome({
    scheduleId: job.scheduleId,
    scheduledFor: job.scheduledFor,
    streamId,
    jobCreatedAt: job.createdAt,
    status: 'interrupted',
    conversationId: job.conversationId ?? streamId,
    error: 'Approval expired before a decision was made',
  });
  if (!recorded) {
    throw new Error(`Failed to settle expired scheduled approval ${job.scheduleId}`);
  }
}

module.exports = {
  prepareScheduleContinuation: invoke('prepareScheduleContinuation'),
  getLimits: invoke('getLimits'),
  fireScheduleNow: invoke('fireScheduleNow'),
  recordScheduleOutcome: invoke('recordScheduleOutcome'),
  registerMCPSettlement: invoke('registerMCPSettlement'),
  recordMCPToolAuthFailure: (input) =>
    require('@librechat/api').recordScheduledMCPToolAuthFailure(
      input,
      () => getService().recordMCPToolAuthFailure,
      () => getService().getMCPReceiptRetryPolicy(input),
    ),
  beginScheduledStop: invoke('beginScheduledStop'),
  acknowledgeScheduledStopPersistence: invoke('acknowledgeScheduledStopPersistence'),
  claimScheduleResume: invoke('claimScheduleResume'),
  releaseScheduleResumeClaim: invoke('releaseScheduleResumeClaim'),
  finalizeScheduleResumeClaim: invoke('finalizeScheduleResumeClaim'),
  releaseScheduleResumeFence: invoke('releaseScheduleResumeFence'),
  isScheduleLive: invoke('isScheduleLive'),
  deleteScheduleForOwner: invoke('deleteScheduleForOwner'),
  quiesceUserSchedules: invoke('quiesceUserSchedules'),
  restoreUserSchedulesFromDeletion: invoke('restoreUserSchedulesFromDeletion'),
  initializeScheduleEngine: invoke('initializeScheduleEngine'),
  initializeScheduleErasureSweep: invoke('initializeScheduleErasureSweep'),
  recordExpiredScheduleApproval,
  isUserDeleting: async (userId) => {
    const methods = require('~/models');
    return !(await methods.isAgentTriggerPrincipalActive(userId));
  },
  // Identity-fenced delete for a retained job whose run has since been settled
  // inline; reconciliation only reaches jobs whose run is still active.
  clearScheduledJob: (...args) => getService().engineDeps.clearReconciledJob(...args),
};
