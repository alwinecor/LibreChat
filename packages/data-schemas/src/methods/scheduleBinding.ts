import { Constants } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import type {
  IScheduleDocument,
  IScheduleRunDocument,
  ScheduleConversationBinding,
} from '~/types/schedule';
import type { IConversation } from '~/types/convo';
import type { IMessage } from '~/types/message';

export interface ScheduleBindingScope {
  scheduleId: string;
  userId: string;
  tenantId?: string;
  configRevision: number;
}

export type ScheduleBranch =
  | { status: 'ready'; conversationId: string; parentMessageId: string; bindingRevision: number }
  | { status: 'unmaterialized' | 'missing' | 'conflict' | 'project_conflict' };

export interface ScheduleContinuationState {
  manual?: boolean;
  dispatchStarted?: boolean;
  predecessorCreatedAt?: number;
  conversationId?: string;
  parentMessageId?: string;
  generationCreatedAt?: number;
  waiting: boolean;
}

export interface ScheduleBindingMethods {
  retireScheduleConversations(userId: string, conversationIds: string[]): Promise<void>;
  reserveScheduleConversation(
    scope: ScheduleBindingScope,
    candidateConversationId: string,
  ): Promise<ScheduleConversationBinding | null>;
  markScheduleConversationMaterialized(
    scope: ScheduleBindingScope,
    conversationId: string,
  ): Promise<boolean>;
  resolveScheduleConversationBranch(scope: ScheduleBindingScope): Promise<ScheduleBranch>;
  getScheduleContinuation(
    scope: ScheduleBindingScope,
    scheduledFor: Date,
    deliveryKey: string,
  ): Promise<ScheduleContinuationState | null>;
  claimScheduleContinuation(
    scope: ScheduleBindingScope,
    scheduledFor: Date,
    deliveryKey: string,
    parentMessageId: string,
    capacitySlot: number,
    predecessorCreatedAt?: number,
  ): Promise<'claimed' | 'stale' | 'slot-taken'>;
  beginScheduleContinuationDispatch(
    scope: ScheduleBindingScope,
    scheduledFor: Date,
    deliveryKey: string,
  ): Promise<boolean>;
  releaseScheduleContinuation(
    scope: ScheduleBindingScope,
    scheduledFor: Date,
    deliveryKey: string,
  ): Promise<boolean>;
  markScheduleContinuationAdmitted(
    scope: ScheduleBindingScope,
    scheduledFor: Date,
    deliveryKey: string,
    generationCreatedAt: number,
  ): Promise<void>;
}

export function createScheduleBindingMethods(
  mongoose: typeof import('mongoose'),
): ScheduleBindingMethods {
  const schedules = () => mongoose.models.Schedule as Model<IScheduleDocument>;
  const conversations = () => mongoose.models.Conversation as Model<IConversation>;
  const messages = () => mongoose.models.Message as Model<IMessage>;
  const runs = () => mongoose.models.ScheduleRun as Model<IScheduleRunDocument>;
  async function retireScheduleConversations(
    userId: string,
    conversationIds: string[],
  ): Promise<void> {
    if (!mongoose.isObjectIdOrHexString(userId) || conversationIds.length === 0) return;
    await schedules().updateMany(
      { user: userId, target: 'same', 'binding.conversationId': { $in: conversationIds } },
      {
        $set: {
          enabled: false,
          disabledReason: 'conversation_deleted',
          'binding.materialized': true,
        },
        $inc: { configRevision: 1 },
        $unset: { nextRunAt: 1, claimToken: 1 },
      },
    );
  }
  const filter = (scope: ScheduleBindingScope) => ({
    id: scope.scheduleId,
    user: scope.userId,
    tenantId: scope.tenantId ?? null,
    configRevision: scope.configRevision,
    target: 'same',
    deleting: { $ne: true },
    erased: { $ne: true },
    deletionSuspension: { $exists: false },
  });

  /** Reserve once; failed/replayed dispatches keep the same conversation identity. */
  async function reserveScheduleConversation(
    scope: ScheduleBindingScope,
    candidateConversationId: string,
  ): Promise<ScheduleConversationBinding | null> {
    await schedules().updateOne(
      { ...filter(scope), binding: { $exists: false } },
      {
        $set: {
          binding: { conversationId: candidateConversationId, materialized: false, revision: 0 },
        },
      },
      { timestamps: false },
    );
    const schedule = await schedules().findOne(filter(scope)).select('binding').lean();
    return schedule?.binding ?? null;
  }

  /** Materialize only after the owner's conversation exists, never from an HTTP acknowledgement. */
  async function markScheduleConversationMaterialized(
    scope: ScheduleBindingScope,
    conversationId: string,
  ): Promise<boolean> {
    const exists = await conversations().exists({
      conversationId,
      user: scope.userId,
      tenantId: scope.tenantId ?? null,
    });
    if (!exists) return false;
    const result = await schedules().updateOne(
      { ...filter(scope), 'binding.conversationId': conversationId },
      { $set: { 'binding.materialized': true } },
      { timestamps: false },
    );
    return result.matchedCount === 1;
  }

  async function resolveScheduleConversationBranch(
    scope: ScheduleBindingScope,
  ): Promise<ScheduleBranch> {
    const schedule = await schedules().findOne(filter(scope)).lean();
    if (!schedule?.binding) return { status: 'missing' };
    const binding = schedule.binding;
    const conversation = await conversations()
      .findOne({
        conversationId: binding.conversationId,
        user: scope.userId,
        tenantId: scope.tenantId ?? null,
      })
      .select('agent_id chatProjectId')
      .lean();
    if (!conversation) return { status: binding.materialized ? 'missing' : 'unmaterialized' };
    if (conversation.agent_id !== schedule.agent_id) return { status: 'conflict' };
    if ((conversation.chatProjectId ?? null) !== (schedule.chatProjectId ?? null)) {
      return { status: 'project_conflict' };
    }
    // Inspect topology and completion flags without loading text or provider state.
    const transcript = await messages()
      .find({
        conversationId: binding.conversationId,
        user: scope.userId,
        tenantId: scope.tenantId ?? null,
      })
      .select('messageId parentMessageId isCreatedByUser error unfinished')
      .lean();
    const children = new Map<string, typeof transcript>();
    for (const message of transcript) {
      const parent = message.parentMessageId ?? Constants.NO_PARENT;
      const siblings = children.get(parent) ?? [];
      siblings.push(message);
      children.set(parent, siblings);
    }
    let parentMessageId = Constants.NO_PARENT.toString();
    let leaf: (typeof transcript)[number] | undefined;
    const visited = new Set<string>();
    for (;;) {
      const next = children.get(parentMessageId);
      if (!next?.length) break;
      if (next.length !== 1 || visited.has(next[0].messageId)) return { status: 'conflict' };
      leaf = next[0];
      parentMessageId = leaf.messageId;
      visited.add(parentMessageId);
    }
    if (
      !leaf ||
      leaf.isCreatedByUser ||
      leaf.error ||
      leaf.unfinished ||
      visited.size !== transcript.length
    )
      return { status: 'conflict' };
    await markScheduleConversationMaterialized(scope, binding.conversationId);
    return {
      status: 'ready',
      conversationId: binding.conversationId,
      parentMessageId,
      bindingRevision: binding.revision,
    };
  }

  const occurrenceFilter = (
    scope: ScheduleBindingScope,
    scheduledFor: Date,
    deliveryKey: string,
  ) => ({
    scheduleId: scope.scheduleId,
    user: scope.userId,
    tenantId: scope.tenantId ?? null,
    configRevision: scope.configRevision,
    scheduledFor,
    deliveryKey,
    status: 'started',
  });

  async function getScheduleContinuation(
    scope: ScheduleBindingScope,
    scheduledFor: Date,
    deliveryKey: string,
  ): Promise<ScheduleContinuationState | null> {
    const run = await runs()
      .findOne(occurrenceFilter(scope, scheduledFor, deliveryKey))
      .lean();
    if (!run) return null;
    return {
      conversationId: run.conversationId,
      parentMessageId: run.continuationParentMessageId,
      generationCreatedAt: run.generationCreatedAt,
      manual: run.manual,
      dispatchStarted: run.dispatchStarted,
      predecessorCreatedAt: run.predecessorCreatedAt,
      waiting: run.waiting === true,
    };
  }

  async function claimScheduleContinuation(
    scope: ScheduleBindingScope,
    scheduledFor: Date,
    deliveryKey: string,
    parentMessageId: string,
    capacitySlot: number,
    predecessorCreatedAt?: number,
  ): Promise<'claimed' | 'stale' | 'slot-taken'> {
    if (!(await schedules().exists(filter(scope)))) return 'stale';
    try {
      const result = await runs().updateOne(
        { ...occurrenceFilter(scope, scheduledFor, deliveryKey), waiting: true },
        {
          $set: {
            waiting: false,
            continuationParentMessageId: parentMessageId,
            capacitySlot,
            ...(predecessorCreatedAt != null && { predecessorCreatedAt }),
          },
        },
      );
      return result.modifiedCount === 1 ? 'claimed' : 'stale';
    } catch (error) {
      if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000)
        return 'slot-taken';
      throw error;
    }
  }

  async function releaseScheduleContinuation(
    scope: ScheduleBindingScope,
    scheduledFor: Date,
    deliveryKey: string,
  ): Promise<boolean> {
    const result = await runs().updateOne(
      {
        ...occurrenceFilter(scope, scheduledFor, deliveryKey),
        generationCreatedAt: { $exists: false },
      },
      {
        $set: { waiting: true },
        $unset: {
          continuationParentMessageId: 1,
          capacitySlot: 1,
          dispatchStarted: 1,
          predecessorCreatedAt: 1,
        },
      },
    );
    return result.matchedCount === 1;
  }

  async function beginScheduleContinuationDispatch(
    scope: ScheduleBindingScope,
    scheduledFor: Date,
    deliveryKey: string,
  ): Promise<boolean> {
    const result = await runs().updateOne(
      { ...occurrenceFilter(scope, scheduledFor, deliveryKey), waiting: false },
      { $set: { dispatchStarted: true } },
    );
    return result.matchedCount === 1;
  }

  async function markScheduleContinuationAdmitted(
    scope: ScheduleBindingScope,
    scheduledFor: Date,
    deliveryKey: string,
    generationCreatedAt: number,
  ): Promise<void> {
    await runs().updateOne(
      {
        ...occurrenceFilter(scope, scheduledFor, deliveryKey),
        waiting: false,
        $or: [{ generationCreatedAt: { $exists: false } }, { generationCreatedAt }],
      },
      { $set: { generationCreatedAt } },
    );
  }

  return {
    retireScheduleConversations,
    reserveScheduleConversation,
    markScheduleConversationMaterialized,
    resolveScheduleConversationBranch,
    getScheduleContinuation,
    claimScheduleContinuation,
    releaseScheduleContinuation,
    markScheduleContinuationAdmitted,
    beginScheduleContinuationDispatch,
  };
}
