import { useId, useState } from 'react';
import { Clock } from 'lucide-react';
import { Button } from '@librechat/client';
import { useTranslation } from 'react-i18next';
import type { TMessage } from 'librechat-data-provider';
import { useOptionalMessagesOperations } from '~/Providers/MessagesViewContext';
import { PrivateText } from '~/components/Chat/Messages/PrivateText';
import useClockFormat from '~/hooks/useClockFormat';
import { getMessageTimestamp } from '~/utils';
import { useLocalize } from '~/hooks';

export default function ScheduleBadge({ message }: { message: TMessage }) {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  const hour12 = useClockFormat();
  const id = useId();
  const [open, setOpen] = useState(false);
  const { getMessages } = useOptionalMessagesOperations();
  const run = message.scheduleRun;
  if (run == null || message.isCreatedByUser) return null;
  const timestamp = open ? getMessageTimestamp(run.scheduledFor, i18n.language, hour12) : null;
  // Read the historical instruction only when expanded; never fetch today's task configuration.
  const parent = open
    ? getMessages()?.find((item) => item.messageId === message.parentMessageId)
    : undefined;
  return (
    <div className="text-text-secondary mb-2 text-sm">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <Clock size={14} aria-hidden="true" />
        {localize(run.manual ? 'com_ui_schedule_run_manual' : 'com_ui_schedule_run_automatic')}
      </Button>
      {open && (
        <dl id={id} className="border-border-medium mt-1 space-y-1 border-l pl-3">
          <dt>{localize('com_ui_schedule_run_name')}</dt>
          <dd>{run.name ?? run.scheduleId}</dd>
          {timestamp && (
            <>
              <dt>{localize('com_ui_schedule_run_time')}</dt>
              <dd>
                <time dateTime={timestamp.iso}>{timestamp.absolute}</time>
              </dd>
            </>
          )}
          <dt>{localize('com_ui_schedule_run_instruction')}</dt>
          <dd className="text-text-primary break-words whitespace-pre-wrap">
            {parent?.privacyRevision ? (
              <PrivateText message={parent} />
            ) : (
              parent?.text || localize('com_ui_schedule_run_unavailable')
            )}
          </dd>
        </dl>
      )}
    </div>
  );
}
