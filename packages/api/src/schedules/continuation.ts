import { FileSources } from 'librechat-data-provider';
import type { AgentTriggerExecutionHostDeps } from '../agents/triggers/host';
import type { ScheduleEngineDeps } from './types';
import { AgentTriggerExecutionError } from '../agents/triggers/host';
import { resolveScheduleProjectId } from './types';

export interface ScheduleContinuationDeps
  extends Pick<
    ScheduleEngineDeps,
    | 'methods'
    | 'getLimits'
    | 'getUserContext'
    | 'getJobStatus'
    | 'agentAccess'
    | 'isOutOfBalance'
    | 'resolveFiles'
    | 'preflightMCP'
    | 'withGlobalCapacitySlot'
  > {
  isScheduleLive: (
    id: string,
    revision?: number,
    options?: {
      automatic?: boolean;
      policy?: boolean;
      scheduledFor?: string | Date;
    },
  ) => Promise<boolean>;
}

function reject(code: string, deferred = false): never {
  throw new AgentTriggerExecutionError('Scheduled conversation admission is unavailable.', {
    mode: 'continue',
    certainty: 'definite',
    retryable: deferred,
    deferWithoutAttempt: deferred,
    code,
  });
}

/** Resolves only schedule-owned occurrences; envelopes cannot choose another conversation. */
export function createScheduleContinuationResolver(
  deps: ScheduleContinuationDeps,
): NonNullable<AgentTriggerExecutionHostDeps['prepareContinue']> {
  return async (envelope, context) => {
    if (
      envelope.event.source.type !== 'schedule' ||
      envelope.event.type !== 'schedule.occurrence'
    ) {
      return reject('INVALID_SCHEDULE_CONTINUATION');
    }
    const schedule = await deps.methods.getScheduleById(
      envelope.event.source.id,
      envelope.principal.userId,
    );
    if (
      !schedule ||
      schedule.target !== 'same' ||
      (schedule.tenantId ?? null) !== (envelope.principal.tenantId ?? null) ||
      schedule.agent_id !== envelope.target.agentId ||
      schedule.binding?.conversationId !== envelope.target.conversationId
    ) {
      return reject('INVALID_SCHEDULE_CONTINUATION');
    }
    const scope = {
      scheduleId: schedule.id,
      userId: envelope.principal.userId,
      tenantId: envelope.principal.tenantId,
      configRevision: schedule.configRevision ?? 0,
    };
    const scheduledFor = new Date(envelope.event.occurredAt);
    const state = await deps.methods.getScheduleContinuation(
      scope,
      scheduledFor,
      context.idempotencyKey,
    );
    if (!state || state.conversationId !== envelope.target.conversationId) {
      return reject('STALE_SCHEDULE_CONTINUATION');
    }
    const owner = await deps.getUserContext(scope.userId);
    if (!owner || (owner.tenantId ?? null) !== (scope.tenantId ?? null)) {
      return reject('INVALID_SCHEDULE_OWNER');
    }
    const [limits, globalLimits, live, access, balance] = await Promise.all([
      deps.getLimits(owner),
      deps.getLimits(),
      deps.isScheduleLive(schedule.id, scope.configRevision, {
        automatic: state.manual !== true,
        policy: true,
        scheduledFor,
      }),
      deps.agentAccess(schedule.agent_id, owner),
      deps.isOutOfBalance(owner),
    ]);
    if (
      !limits.enabled ||
      limits.continueConversation !== true ||
      !live ||
      access !== 'ok' ||
      balance
    ) {
      return reject('SCHEDULE_CONTINUATION_DISABLED');
    }
    if (
      (resolveScheduleProjectId(limits, schedule.chatProjectId) ?? null) !==
      (schedule.chatProjectId ?? null)
    ) {
      await deps.methods.disableSchedule(
        schedule.id,
        'conversation_project_conflict',
        schedule.claimToken,
      );
      return reject('SCHEDULE_CONVERSATION_PROJECT_CONFLICT');
    }
    const job = await deps.getJobStatus(envelope.target.conversationId);
    const ownJob =
      job?.scheduleId === schedule.id &&
      job.scheduledFor != null &&
      new Date(job.scheduledFor).getTime() === scheduledFor.getTime();
    if (
      !ownJob &&
      job != null &&
      (job.status === 'running' ||
        job.status === 'requires_action' ||
        job.terminalPersistencePending ||
        job.terminalHostActionPending ||
        job.providerDrained === false)
    ) {
      return reject('PARENT_NOT_READY', true);
    }
    let parentMessageId = state.parentMessageId;
    if (parentMessageId == null) {
      const branch = await deps.methods.resolveScheduleConversationBranch(scope);
      if (branch.status !== 'ready') {
        const reasons = {
          missing: 'conversation_deleted',
          project_conflict: 'conversation_project_conflict',
          unmaterialized: 'conversation_conflict',
          conflict: 'conversation_conflict',
        } as const;
        const reason = reasons[branch.status];
        await deps.methods.disableSchedule(schedule.id, reason, schedule.claimToken);
        return reject(`SCHEDULE_${reason.toUpperCase()}`);
      }
      parentMessageId = branch.parentMessageId;
    }
    await deps.preflightMCP(schedule.agent_id, owner, {
      concurrency: Math.min(limits.mcpPreflightConcurrency, globalLimits.mcpPreflightConcurrency),
      deadlineMs:
        Date.now() + Math.min(limits.mcpPreflightTimeoutMs, globalLimits.mcpPreflightTimeoutMs),
      signal: context.signal,
      scheduleId: schedule.id,
      stage: 'invoke',
    });
    const files = (await deps.resolveFiles(schedule.file_ids ?? [], owner)).map((file) => ({
      ...file,
      source: Object.values(FileSources).find((source) => source === file.source),
    }));
    if (state.waiting) {
      const parent = parentMessageId;
      const allocation = await deps.withGlobalCapacitySlot(
        Math.min(limits.fireConcurrency, globalLimits.fireConcurrency),
        async (slot) => {
          const claim = await deps.methods.claimScheduleContinuation(
            scope,
            scheduledFor,
            context.idempotencyKey,
            parent,
            slot,
            job?.createdAt,
          );
          return claim === 'slot-taken' ? 'slot-taken' : { claimed: claim };
        },
      );
      if (allocation === 'capacity') return reject('SCHEDULE_CAPACITY', true);
      if (allocation.claimed !== 'claimed') return reject('STALE_SCHEDULE_CONTINUATION');
    }
    return {
      status: 'ready',
      input: schedule.prompt,
      parentMessageId,
      files,
      expectedPredecessorCreatedAt: state.waiting ? job?.createdAt : state.predecessorCreatedAt,
      scheduleMetadata: {
        manual: state.manual === true,
        configRevision: scope.configRevision,
        scheduleName: schedule.name,
      },
      releaseOnDefiniteFailure: async () => {
        if (!state.dispatchStarted) {
          await deps.methods.releaseScheduleContinuation(
            scope,
            scheduledFor,
            context.idempotencyKey,
          );
        }
      },
      beginDispatch: async () => {
        if (
          !(await deps.methods.beginScheduleContinuationDispatch(
            scope,
            scheduledFor,
            context.idempotencyKey,
          ))
        ) {
          reject('STALE_SCHEDULE_CONTINUATION');
        }
      },
      settleOnAdmission: async (result) => {
        if (result.generationCreatedAt != null) {
          await deps.methods.markScheduleContinuationAdmitted(
            scope,
            scheduledFor,
            context.idempotencyKey,
            result.generationCreatedAt,
          );
        }
      },
    };
  };
}
