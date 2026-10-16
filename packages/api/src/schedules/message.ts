import type { TMessage } from 'librechat-data-provider';
import { readScheduleFireContext } from './trigger';

export function stampScheduledMessage<T extends object>(
  req: Parameters<typeof readScheduleFireContext>[0],
  message: T | null,
): (T & Pick<TMessage, 'scheduleRun'>) | null {
  return message == null ? null : { ...message, ...scheduledMessageFields(req) };
}

/** Display provenance comes only from an authenticated trigger, never client message fields. */
export function scheduledMessageFields(
  req: Parameters<typeof readScheduleFireContext>[0],
): Pick<TMessage, 'scheduleRun'> {
  const context = readScheduleFireContext(req);
  if (!context) return {};
  const trigger = req?.body?.agentTrigger;
  const metadata =
    trigger != null && typeof trigger === 'object' && 'metadata' in trigger
      ? trigger.metadata
      : undefined;
  const name =
    metadata != null &&
    typeof metadata === 'object' &&
    'scheduleName' in metadata &&
    typeof metadata.scheduleName === 'string'
      ? metadata.scheduleName
      : undefined;
  return {
    scheduleRun: {
      scheduleId: context.scheduleId,
      scheduledFor: context.scheduledFor,
      manual: context.manual,
      ...(name ? { name } : {}),
    },
  };
}
