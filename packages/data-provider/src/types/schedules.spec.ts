import { z } from 'zod';
import {
  createSchedulePayloadSchema,
  updateSchedulePayloadSchema,
  getScheduleMCPDisabledReason,
  isScheduleMCPAuthorizationFailure,
  readScheduleMCPOutcomes,
  scheduleMCPOutcomeSchema,
} from './schedules';

describe('persistent schedule requests', () => {
  const payload = {
    name: 'Daily report',
    prompt: 'Continue the report',
    agent_id: 'agent_report',
    cadence: { frequency: 'daily', hour: 9, minute: 0 },
    timezone: 'Europe/Berlin',
    clientRequestId: 'create-report',
  };

  it('preserves new-conversation defaults and accepts explicitly requested persistence', () => {
    expect(createSchedulePayloadSchema.parse(payload).target).toBe('new');
    expect(createSchedulePayloadSchema.parse({ ...payload, target: 'same' }).target).toBe('same');
    expect(createSchedulePayloadSchema.safeParse({ ...payload, target: 'other' }).success).toBe(
      false,
    );
  });

  it.each(['binding', 'conversationId', 'parentMessageId'])(
    'rejects client-owned %s on create and update',
    (key) => {
      expect(createSchedulePayloadSchema.safeParse({ ...payload, [key]: 'forged' }).success).toBe(
        false,
      );
      expect(updateSchedulePayloadSchema.safeParse({ [key]: 'forged' }).success).toBe(false);
    },
  );
});

it('preserves the previous wire status while providing an optional unattended-auth diagnosis', () => {
  const outcome = {
    server: 'Graph',
    status: 'mcp_configuration_missing' as const,
    detail: 'unattended_auth_required' as const,
  };
  // Represents the schema used by an open tab from before this feature.
  const previousClientSchema = z.object({
    server: z.string(),
    agentId: z.string().optional(),
    status: z.enum([
      'ready',
      'mcp_reauth_required',
      'mcp_configuration_missing',
      'mcp_permission_denied',
      'mcp_unavailable',
    ]),
  });
  expect(previousClientSchema.array().parse([outcome])).toEqual([
    { server: 'Graph', status: 'mcp_configuration_missing' },
  ]);
  expect(scheduleMCPOutcomeSchema.parse(outcome)).toEqual(outcome);
  expect(getScheduleMCPDisabledReason([outcome])).toBe('mcp_configuration_missing');
  expect(
    readScheduleMCPOutcomes(`mcp_configuration_missing: ${JSON.stringify([outcome])}`),
  ).toEqual([outcome]);
});

it('recognizes durable structured denials without treating readiness snapshots as receipts', () => {
  const failure = {
    server: 'warehouse',
    status: 'mcp_reauth_required' as const,
    reason: 'credential_rejected' as const,
    automaticReplay: false as const,
  };
  expect(isScheduleMCPAuthorizationFailure(failure)).toBe(true);
  expect(isScheduleMCPAuthorizationFailure({ ...failure, status: 'ready' })).toBe(false);
  expect(
    isScheduleMCPAuthorizationFailure({ server: 'warehouse', status: 'mcp_reauth_required' }),
  ).toBe(false);
  expect(
    isScheduleMCPAuthorizationFailure({
      server: 'warehouse',
      status: 'mcp_configuration_missing',
      detail: 'unattended_auth_required',
    }),
  ).toBe(true);
});
