import type { RecordScheduleOutcomeInput } from './service';
import { InMemoryJobStore } from '../stream/implementations/InMemoryJobStore';
import { drainScheduledProvider } from './drain';

it('settles the exact scheduled generation after its provider has drained', async () => {
  const store = new InMemoryJobStore({ ttlAfterComplete: 0 });
  try {
    const job = await store.createJob('conversation', 'owner', 'conversation');
    await store.updateJob(
      'conversation',
      {
        status: 'complete',
        scheduleId: 'schedule',
        scheduledFor: new Date(1000).toISOString(),
        providerExecutionId: 'provider',
        providerDrained: false,
        preserveForScheduleReconcile: true,
      },
      job.createdAt,
    );
    const outcomes: RecordScheduleOutcomeInput[] = [];
    const record = async (input: RecordScheduleOutcomeInput) => {
      outcomes.push(input);
      return true;
    };
    await drainScheduledProvider(
      {
        getJobStore: () => store,
        markProviderExecutionDrained: store.markProviderExecutionDrained.bind(store),
      },
      record,
      'conversation',
      job.createdAt,
      'provider',
    );
    expect(outcomes).toEqual([
      expect.objectContaining({
        scheduleId: 'schedule',
        streamId: 'conversation',
        jobCreatedAt: job.createdAt,
        status: 'success',
      }),
    ]);
    await store.deleteJob('conversation', job.createdAt);
    const replacement = await store.createJob('conversation', 'owner', 'conversation');
    await store.updateJob(
      'conversation',
      { providerExecutionId: 'manual-provider', providerDrained: false },
      replacement.createdAt,
    );
    await drainScheduledProvider(
      {
        getJobStore: () => store,
        markProviderExecutionDrained: store.markProviderExecutionDrained.bind(store),
      },
      record,
      'conversation',
      job.createdAt,
      'provider',
    );
    expect(outcomes).toHaveLength(1);
    expect(await store.getJob('conversation')).toMatchObject({
      createdAt: replacement.createdAt,
      status: 'running',
      providerExecutionId: 'manual-provider',
      providerDrained: false,
    });
  } finally {
    await store.destroy();
  }
});
