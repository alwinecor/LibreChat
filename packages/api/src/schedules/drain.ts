import type { SerializableJobData } from '../stream/interfaces/IJobStore';
import type { SchedulesService } from './service';
import { retainedOutcome } from './types';

interface ProviderDrainHost {
  markProviderExecutionDrained?: (
    streamId: string,
    createdAt: number,
    providerId: string,
  ) => Promise<boolean>;
  getJobStore: () =>
    | { getJob: (streamId: string) => Promise<SerializableJobData | null> }
    | undefined;
}

/** Release retained schedule evidence once both provider and message writes are done.
 * A late provider from an older turn must never settle its replacement. */
export async function drainScheduledProvider(
  host: ProviderDrainHost,
  record: SchedulesService['recordScheduleOutcome'],
  streamId: string,
  createdAt: number,
  providerId: string,
): Promise<void> {
  if (!(await host.markProviderExecutionDrained?.(streamId, createdAt, providerId))) return;
  const job = await host.getJobStore()?.getJob(streamId);
  if (
    !job ||
    job.createdAt !== createdAt ||
    job.providerExecutionId !== providerId ||
    !job.scheduleId ||
    !job.scheduledFor ||
    !job.preserveForScheduleReconcile ||
    job.providerDrained !== true ||
    job.terminalPersistencePending ||
    job.terminalHostActionPending ||
    !['complete', 'error', 'aborted'].includes(job.status)
  )
    return;
  const outcome =
    job.status === 'aborted'
      ? { status: 'interrupted' as const }
      : retainedOutcome(job, job.status === 'complete' ? 'success' : 'error');
  await record({
    scheduleId: job.scheduleId,
    scheduledFor: job.scheduledFor,
    streamId,
    jobCreatedAt: createdAt,
    conversationId: job.conversationId,
    ...outcome,
  });
}
