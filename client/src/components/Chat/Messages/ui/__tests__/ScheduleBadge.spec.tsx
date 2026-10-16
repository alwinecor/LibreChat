import { fireEvent, render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import ScheduleBadge from '../ScheduleBadge';

const parent = { messageId: 'prompt', text: 'Original instruction', isCreatedByUser: true };
let mockLanguage = 'zh-Hans';
let mockHour12 = false;
jest.mock('react-i18next', () => ({
  ...jest.requireActual('react-i18next'),
  useTranslation: () => ({ i18n: { language: mockLanguage } }),
}));
jest.mock('~/hooks/useClockFormat', () => ({ __esModule: true, default: () => mockHour12 }));
jest.mock('~/Providers/MessagesViewContext', () => ({
  useOptionalMessagesOperations: () => ({ getMessages: () => [parent] }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
const message = {
  messageId: 'reply',
  parentMessageId: 'prompt',
  isCreatedByUser: false,
  scheduleRun: {
    scheduleId: 'task',
    name: 'Daily report',
    manual: false,
    scheduledFor: '2026-10-16T10:00:00Z',
  },
} as TMessage;

beforeEach(() => {
  mockLanguage = 'zh-Hans';
  mockHour12 = false;
});

it('follows the interface language and clock preference when they change', () => {
  const { container, rerender } = render(<ScheduleBadge message={message} />);
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_run_automatic' }));
  const date = new Date(message.scheduleRun!.scheduledFor);
  expect(container.querySelector('time')).toHaveTextContent(
    new Intl.DateTimeFormat('zh-Hans', {
      dateStyle: 'medium',
      timeStyle: 'short',
      hour12: false,
    }).format(date),
  );
  mockLanguage = 'en';
  mockHour12 = true;
  rerender(<ScheduleBadge message={message} />);
  expect(container.querySelector('time')).toHaveTextContent(
    new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', hour12: true }).format(
      date,
    ),
  );
});

it('keeps instructions collapsed until requested and reads the historical parent', () => {
  render(<ScheduleBadge message={message} />);
  expect(screen.queryByText('Original instruction')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_run_automatic' }));
  expect(screen.getByText('Original instruction')).toBeVisible();
  expect(screen.getByText('Daily report')).toBeVisible();
});

it('distinguishes a manual task run', () => {
  render(
    <ScheduleBadge
      message={{ ...message, scheduleRun: { ...message.scheduleRun!, manual: true } }}
    />,
  );
  expect(screen.getByRole('button', { name: 'com_ui_schedule_run_manual' })).toBeVisible();
});

it('shows a safe fallback when the historical instruction is unavailable', () => {
  render(<ScheduleBadge message={{ ...message, parentMessageId: 'missing' }} />);
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_run_automatic' }));
  expect(screen.getByText('com_ui_schedule_run_unavailable')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_schedule_run_automatic' }));
  expect(screen.queryByText('com_ui_schedule_run_unavailable')).not.toBeInTheDocument();
});

it('does not label ordinary messages or render the hidden prompt as a badge', () => {
  const { container, rerender } = render(
    <ScheduleBadge message={{ ...message, scheduleRun: undefined }} />,
  );
  expect(container).toBeEmptyDOMElement();
  rerender(<ScheduleBadge message={{ ...message, isCreatedByUser: true }} />);
  expect(container).toBeEmptyDOMElement();
});
