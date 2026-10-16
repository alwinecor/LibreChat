import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createScheduleMethods } from './schedule';
import { createModels } from '../models';
import { createMethods } from './index';

let mongo: MongoMemoryServer;
let methods: ReturnType<typeof createScheduleMethods>;
const userId = new mongoose.Types.ObjectId().toString();
const scope = { scheduleId: 'persistent', userId, configRevision: 0 };

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  methods = createScheduleMethods(mongoose);
}, 60_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await Promise.all(
    ['Schedule', 'ScheduleRun', 'Conversation', 'Message'].map((name) =>
      mongoose.models[name].deleteMany({}),
    ),
  );
  await methods.createSchedule({
    id: scope.scheduleId,
    user: new mongoose.Types.ObjectId(userId),
    name: 'Report',
    prompt: 'Continue',
    agent_id: 'agent_report',
    target: 'new',
    cadence: { frequency: 'daily', hour: 9, minute: 0 },
    timezone: 'Europe/Berlin',
    enabled: true,
    configRevision: 0,
  });
  // The fixture can establish the new target before the schema supports it.
  await mongoose.models.Schedule.collection.updateOne(
    { id: scope.scheduleId },
    { $set: { target: 'same' } },
  );
});

it('allocates one durable binding under racing first occurrences', async () => {
  const results = await Promise.all(
    ['one', 'two'].map((id) => methods.reserveScheduleConversation(scope, id)),
  );
  expect(results[0]?.conversationId).toBe(results[1]?.conversationId);
  expect(results[0]?.materialized).toBe(false);
  expect(await methods.reserveScheduleConversation(scope, 'after-restart')).toEqual(results[0]);
});

it('rejects stale revisions and other owners or tenants', async () => {
  expect(
    await methods.reserveScheduleConversation({ ...scope, configRevision: 4 }, 'bad'),
  ).toBeNull();
  expect(
    await methods.reserveScheduleConversation(
      { ...scope, userId: new mongoose.Types.ObjectId().toString() },
      'bad',
    ),
  ).toBeNull();
  expect(
    await methods.reserveScheduleConversation({ ...scope, tenantId: 'another' }, 'bad'),
  ).toBeNull();
});

it('fences identity edits atomically after a concurrent binding reservation', async () => {
  await methods.reserveScheduleConversation(scope, 'one');
  expect(
    await methods.updateScheduleById(scope.scheduleId, userId, { agent_id: 'changed' }),
  ).toBeNull();
  expect(await methods.updateScheduleById(scope.scheduleId, userId, { target: 'new' })).toBeNull();
  expect(
    await methods.updateScheduleById(scope.scheduleId, userId, { chatProjectId: 'changed' }),
  ).toBeNull();
  expect(
    await methods.updateScheduleById(scope.scheduleId, userId, { prompt: 'Updated prompt' }),
  ).toMatchObject({ prompt: 'Updated prompt', binding: { conversationId: 'one' } });
});

it('distinguishes an unused reservation from a deleted conversation', async () => {
  await methods.reserveScheduleConversation(scope, 'one');
  expect(await methods.resolveScheduleConversationBranch(scope)).toEqual({
    status: 'unmaterialized',
  });
  await mongoose.models.Conversation.create({
    user: userId,
    conversationId: 'one',
    endpoint: 'agents',
    agent_id: 'agent_report',
  });
  expect(await methods.markScheduleConversationMaterialized(scope, 'one')).toBe(true);
  await mongoose.models.Conversation.deleteMany({});
  expect(await methods.resolveScheduleConversationBranch(scope)).toEqual({ status: 'missing' });
});

it('retires even an unmaterialized binding before its conversation is deleted', async () => {
  await methods.reserveScheduleConversation(scope, 'one');
  await mongoose.models.Conversation.create({
    user: userId,
    conversationId: 'one',
    endpoint: 'agents',
    agent_id: 'agent_report',
  });
  await createMethods(mongoose).deleteConvos(userId, { conversationId: 'one' });
  expect(await methods.getScheduleById(scope.scheduleId)).toMatchObject({
    enabled: false,
    disabledReason: 'conversation_deleted',
    binding: { materialized: true },
  });
  expect(await methods.resolveScheduleConversationBranch(scope)).toEqual({ status: 'missing' });
});

it('follows manual replies on the same branch and refuses an ambiguous fork', async () => {
  await methods.reserveScheduleConversation(scope, 'one');
  await mongoose.models.Conversation.create({
    user: userId,
    conversationId: 'one',
    endpoint: 'agents',
    agent_id: 'agent_report',
  });
  await mongoose.models.Message.create(
    [
      {
        messageId: 'question',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        isCreatedByUser: true,
      },
      { messageId: 'answer', parentMessageId: 'question', isCreatedByUser: false },
      { messageId: 'manual', parentMessageId: 'answer', isCreatedByUser: true },
      { messageId: 'manual-answer', parentMessageId: 'manual', isCreatedByUser: false },
    ].map((message) => ({ ...message, user: userId, conversationId: 'one' })),
  );
  expect(await methods.resolveScheduleConversationBranch(scope)).toMatchObject({
    status: 'ready',
    conversationId: 'one',
    parentMessageId: 'manual-answer',
  });
  for (const field of ['error', 'unfinished']) {
    await mongoose.models.Message.updateOne({ messageId: 'manual-answer' }, { [field]: true });
    expect(await methods.resolveScheduleConversationBranch(scope)).toEqual({ status: 'conflict' });
    await mongoose.models.Message.updateOne({ messageId: 'manual-answer' }, { [field]: false });
  }
  await mongoose.models.Message.create({
    user: userId,
    conversationId: 'one',
    messageId: 'fork',
    parentMessageId: 'answer',
    isCreatedByUser: true,
  });
  expect(await methods.resolveScheduleConversationBranch(scope)).toEqual({ status: 'conflict' });
});

it('refuses moving a persistent conversation into another project', async () => {
  await methods.reserveScheduleConversation(scope, 'one');
  await mongoose.models.Conversation.create({
    user: userId,
    conversationId: 'one',
    endpoint: 'agents',
    agent_id: 'agent_report',
    chatProjectId: 'different-project',
  });
  expect(await methods.resolveScheduleConversationBranch(scope)).toEqual({
    status: 'project_conflict',
  });
});

it('keeps waiting occurrences out of capacity and fences release after admission', async () => {
  await methods.ensureScheduleIndexes();
  await methods.reserveStartedRun({
    scheduleId: scope.scheduleId,
    user: new mongoose.Types.ObjectId(userId),
    scheduledFor: new Date(1000),
    configRevision: 0,
    conversationId: 'one',
    deliveryKey: 'delivery',
    waiting: true,
  });
  expect(await methods.getCapacityOccupancy()).toEqual({ takenSlots: [], unslotted: 0 });
  expect(await methods.countActiveRuns()).toBe(0);
  expect(
    await methods.reserveStartedRun({
      scheduleId: scope.scheduleId,
      user: new mongoose.Types.ObjectId(userId),
      scheduledFor: new Date(1000),
      waiting: true,
    }),
  ).toMatchObject({ conflict: 'duplicate' });
  expect(
    await methods.reserveStartedRun({
      scheduleId: scope.scheduleId,
      user: new mongoose.Types.ObjectId(userId),
      scheduledFor: new Date(2000),
      waiting: true,
    }),
  ).toMatchObject({ conflict: 'overlap' });
  expect(
    await methods.claimScheduleContinuation(scope, new Date(1000), 'delivery', 'answer', 0),
  ).toBe('claimed');
  expect(await methods.getCapacityOccupancy()).toEqual({ takenSlots: [0], unslotted: 0 });
  await methods.markScheduleContinuationAdmitted(scope, new Date(1000), 'delivery', 123);
  expect(await methods.releaseScheduleContinuation(scope, new Date(1000), 'delivery')).toBe(false);
  expect(await methods.getScheduleContinuation(scope, new Date(1000), 'delivery')).toMatchObject({
    generationCreatedAt: 123,
    parentMessageId: 'answer',
  });
});

it('propagates storage failures instead of reporting a missing binding', async () => {
  const failure = jest
    .spyOn(mongoose.models.Schedule, 'updateOne')
    .mockRejectedValueOnce(new Error('unavailable'));
  await expect(methods.reserveScheduleConversation(scope, 'one')).rejects.toThrow('unavailable');
  failure.mockRestore();
});
