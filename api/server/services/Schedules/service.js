module.exports = function createService({ enqueueAgentTrigger, getAgentTriggerDelivery }) {
  const mongoose = require('mongoose');
  const { createSchedulesService } = require('@librechat/api');
  const { getAppConfig } = require('~/server/services/Config/app');
  const { resolveAgentFireAccess } = require('./access');
  const methods = require('~/models');
  const isUserDeleting = async (userId) => !(await methods.isAgentTriggerPrincipalActive(userId));

  return createSchedulesService({
    preflightMCP: require('./mcp'),
    methods,
    getAppConfig,
    findUserById: (userId) =>
      mongoose.models.User.findById(userId).select('_id tenantId role').lean(),
    findBalance: (userId, options) =>
      methods.findBalanceByUser(userId, { includeReservedCredits: true, ...options }),
    upsertBalance: (userId, { set, setOnInsert }) =>
      methods.upsertBalanceFields(userId, set ?? {}, setOnInsert ?? {}),
    // Compare-and-set: only initialize an existing record while its credit is still null.
    // No upsert — a CAS miss must re-read the winner, not insert a fresh balance. `null`
    // in the filter also matches a legacy record whose `tokenCredits` field is absent.
    initializeNullBalance: (userId, { tokenCredits, sync }) =>
      mongoose.models.Balance.findOneAndUpdate(
        { user: userId, tokenCredits: null },
        { $set: { tokenCredits, ...(sync && Object.keys(sync).length > 0 ? sync : {}) } },
        { new: true, sort: { _id: 1 } },
      ).lean(),
    enqueueAgentTrigger,
    // Reconciliation reads the durable delivery to tell a still-live admission (a
    // deferred Retry-After) or a dead-letter apart from a genuinely orphaned run.
    getTriggerDelivery: getAgentTriggerDelivery,
    resolveAgentFireAccess,
    // Chat projects are user-owned, so this scoped read is both the existence and the
    // authorization check the fire-time destination precheck needs.
    getChatProject: (userId, projectId) => methods.getChatProject(userId, projectId),
    // Reuse the merged trigger/deletion admission fence. A schedule fire and every
    // generic trigger now fail closed on the same durable principal state.
    isUserDeleting,
  });
};
