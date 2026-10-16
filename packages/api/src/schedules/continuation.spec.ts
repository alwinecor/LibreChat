import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import type { JobState, ScheduleLimits } from './types';
import {
  createAgentTriggerEnvelope,
  getAgentTriggerIdempotencyKey,
} from '../agents/triggers/envelope';
import { createScheduleContinuationResolver } from './continuation';
import { DEFAULT_SCHEDULE_LIMITS } from './types';
import { withCapacitySlot } from './capacity';

let mongo: MongoMemoryServer;
const database = new mongoose.Mongoose();
let methods: ReturnType<typeof createMethods>;
const user = new database.Types.ObjectId();
const scope = { scheduleId: 'persistent', userId: user.toString(), configRevision: 0 };
const envelope = createAgentTriggerEnvelope({
  mode: 'continue',
  requestId: 'request',
  deliveryId: 'occurrence',
  receivedAt: 1000,
  principal: { id: user.toString() },
  target: { agentId: 'agent', conversationId: 'conversation', parentMessageId: 'placeholder' },
  event: {
    id: 'occurrence',
    type: 'schedule.occurrence',
    occurredAt: 1000,
    source: { id: scope.scheduleId, type: 'schedule' },
  },
  input: 'Continue',
});
const context = { idempotencyKey: getAgentTriggerIdempotencyKey(envelope) };
let job: JobState | null;
let live: boolean;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await database.connect(mongo.getUri());
  createModels(database);
  methods = createMethods(database);
  await methods.ensureScheduleIndexes();
}, 60_000);
afterAll(async () => {
  await database.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await Promise.all(
    ['Schedule', 'ScheduleRun', 'Conversation', 'Message'].map((name) =>
      database.models[name].deleteMany({}),
    ),
  );
  job = null;
  live = true;
  await methods.createSchedule({
    id: scope.scheduleId,
    user,
    name: 'Report',
    prompt: 'Continue',
    agent_id: 'agent',
    target: 'same',
    enabled: true,
    configRevision: 0,
    timezone: 'UTC',
    cadence: { frequency: 'daily', hour: 9, minute: 0 },
  });
  await methods.reserveScheduleConversation(scope, 'conversation');
  await database.models.Conversation.create({
    user,
    conversationId: 'conversation',
    agent_id: 'agent',
    endpoint: 'agents',
  });
  await database.models.Message.create(
    [
      {
        messageId: 'question',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        isCreatedByUser: true,
      },
      { messageId: 'answer', parentMessageId: 'question', isCreatedByUser: false },
    ].map((message) => ({ ...message, user: user.toString(), conversationId: 'conversation' })),
  );
  await methods.markScheduleConversationMaterialized(scope, 'conversation');
  await methods.reserveStartedRun({
    scheduleId: scope.scheduleId,
    user,
    scheduledFor: new Date(1000),
    configRevision: 0,
    conversationId: 'conversation',
    deliveryKey: context.idempotencyKey,
    waiting: true,
  });
});

function resolver(overrides: Partial<ScheduleLimits> = {}) {
  return createScheduleContinuationResolver({
    methods,
    getLimits: async () => ({
      ...DEFAULT_SCHEDULE_LIMITS,
      enabled: true,
      continueConversation: true,
      ...overrides,
    }),
    getUserContext: async () => ({ id: user.toString() }),
    getJobStatus: async () => job,
    isScheduleLive: async () => live,
    agentAccess: async () => 'ok',
    isOutOfBalance: async () => false,
    resolveFiles: async () => [],
    preflightMCP: async (_agent, _owner, options) => {
      expect(options?.deadlineMs).toBeGreaterThan(Date.now());
      return [];
    },
    withGlobalCapacitySlot: (cap, claim) =>
      withCapacitySlot(cap, methods.getCapacityOccupancy, claim),
  });
}

it('waits without capacity and selects the user reply added before admission', async () => {
  if (envelope.mode !== 'continue') throw new Error('fixture');
  job = { status: 'running', createdAt: 10 };
  await expect(resolver()(envelope, context)).rejects.toMatchObject({
    code: 'PARENT_NOT_READY',
    deferWithoutAttempt: true,
  });
  expect(await methods.countActiveRuns()).toBe(0);
  await database.models.Message.create(
    [
      { messageId: 'manual', parentMessageId: 'answer', isCreatedByUser: true },
      { messageId: 'manual-answer', parentMessageId: 'manual', isCreatedByUser: false },
    ].map((message) => ({ ...message, user: user.toString(), conversationId: 'conversation' })),
  );
  job = { status: 'complete', createdAt: 10 };
  const prepared = await resolver()(envelope, context);
  expect(prepared).toMatchObject({
    status: 'ready',
    parentMessageId: 'manual-answer',
    expectedPredecessorCreatedAt: 10,
  });
  expect(await methods.countActiveRuns()).toBe(1);
  if (prepared?.status !== 'ready') throw new Error('not ready');
  await prepared.settleOnAdmission?.({
    mode: 'continue',
    status: 'started',
    conversationId: 'conversation',
    generationCreatedAt: 20,
  });
  job = {
    status: 'running',
    createdAt: 20,
    scheduleId: scope.scheduleId,
    scheduledFor: new Date(1000).toISOString(),
  };
  expect(await resolver()(envelope, context)).toMatchObject({
    status: 'ready',
    parentMessageId: 'manual-answer',
  });
});

it('refuses spoofing, revoked policy, and deleted conversations before admission', async () => {
  if (envelope.mode !== 'continue') throw new Error('fixture');
  await expect(
    resolver()(
      { ...envelope, principal: { userId: new database.Types.ObjectId().toString() } },
      context,
    ),
  ).rejects.toMatchObject({ retryable: false });
  live = false;
  await expect(resolver()(envelope, context)).rejects.toMatchObject({ retryable: false });
  live = true;
  await expect(resolver({ continueConversation: false })(envelope, context)).rejects.toMatchObject({
    retryable: false,
  });
  await expect(resolver({ projectId: 'new-pin' })(envelope, context)).rejects.toMatchObject({
    code: 'SCHEDULE_CONVERSATION_PROJECT_CONFLICT',
  });
  await database.models.Conversation.deleteMany({});
  await expect(resolver()(envelope, context)).rejects.toMatchObject({
    code: 'SCHEDULE_CONVERSATION_DELETED',
    retryable: false,
  });
  expect(await methods.countActiveRuns()).toBe(0);
});

it('keeps a possibly dispatched parent and slot pinned across a retry failure', async () => {
  if (envelope.mode !== 'continue') throw new Error('fixture');
  const first = await resolver()(envelope, context);
  if (first?.status !== 'ready') throw new Error('not ready');
  await first.beginDispatch?.();
  const retry = await resolver()(envelope, context);
  if (retry?.status !== 'ready') throw new Error('not ready');
  await retry.releaseOnDefiniteFailure?.();
  expect(
    await methods.getScheduleContinuation(scope, new Date(1000), context.idempotencyKey),
  ).toMatchObject({ waiting: false, parentMessageId: 'answer', dispatchStarted: true });
});
