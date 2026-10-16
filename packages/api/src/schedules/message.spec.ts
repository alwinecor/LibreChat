import { scheduledMessageFields, stampScheduledMessage } from './message';

const req = {
  _isAgentTrigger: true,
  body: {
    agentTrigger: {
      version: 1,
      event: {
        type: 'schedule.occurrence',
        occurredAt: 1000,
        source: { type: 'schedule', id: 'task' },
      },
      metadata: { manual: true, scheduleName: 'Daily report' },
    },
  },
};

it('projects trusted task identity without duplicating instruction text', () => {
  expect(scheduledMessageFields(req)).toEqual({
    scheduleRun: {
      scheduleId: 'task',
      name: 'Daily report',
      scheduledFor: new Date(1000).toISOString(),
      manual: true,
    },
  });
});

it('does not accept ordinary chat requests copying task metadata', () => {
  expect(scheduledMessageFields({ ...req, _isAgentTrigger: false })).toEqual({});
});

it('preserves an absent preliminary message instead of manufacturing a partial record', () => {
  expect(stampScheduledMessage(req, null)).toBeNull();
  expect(stampScheduledMessage(req, { text: 'Original instruction' })).toMatchObject({
    text: 'Original instruction',
    scheduleRun: { scheduleId: 'task' },
  });
});
