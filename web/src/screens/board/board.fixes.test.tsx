import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { installFakeApi, LOT_ROWS, renderBoard } from './testApi';
import BoardHome from './BoardHome';
import BoardInbox from './BoardInbox';
import BoardLots from './BoardLots';
import BoardChecks from './BoardChecks';
import BoardPost from './BoardPost';
import { setAppNow } from '../../lib/clock';
import type { BoardTask, Message } from '../../data/types';

afterEach(() => { cleanup(); setAppNow(null); });

const task = (o: Partial<BoardTask>): BoardTask => ({
  id: 't1', kind: 'draft_approval', lot_id: 'l23', title: 'Split dues', summary: 'Draft offers two payments.',
  status: 'open', created_at: '2027-02-01T00:00:00Z', due_at: null, ref_id: 'm1', resolved_by: null, resolved_at: null,
  draft_body: 'You may pay in two equal parts.', ...o,
});
const dash = (tasks: BoardTask[]) => async () => ({
  lots_total: 150, lots_paid: 96, owners_signed_in: 61, open_tasks: tasks,
  messages_this_week: { received: 2, answered: 1, waiting: 9, oldest_waiting_business_days: 6 },
});

describe('BoardHome replies', () => {
  it('shows the full text and asks before sending; says nothing is delivered in the demo', async () => {
    const resolveTask = vi.fn().mockResolvedValue(task({ status: 'done' }));
    installFakeApi({ getBoardDashboard: dash([task({})]), listLots: async () => LOT_ROWS, listTemplates: async () => [], resolveTask });
    renderBoard(<BoardHome />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and send' }));
    expect(screen.getByText('You may pay in two equal parts.')).toBeTruthy();
    expect(screen.getByText(/nothing is delivered to anyone/i)).toBeTruthy();
    expect(resolveTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(resolveTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve and send' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, send this reply' }));
    await waitFor(() => expect(resolveTask).toHaveBeenCalledWith('t1', 'approve'));
  });

  it('template tasks show the template text found by name', async () => {
    installFakeApi({
      getBoardDashboard: dash([task({ kind: 'template_reply', draft_body: null, summary: 'Suggested template: Meeting times.' })]),
      listLots: async () => LOT_ROWS,
      listTemplates: async () => [{ id: 'a', name: 'Meeting times', body: 'Next meeting is Tuesday.', version: 1, approved_on: '2027-01-01' }],
    });
    renderBoard(<BoardHome />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send template reply' }));
    expect(await screen.findByText('Next meeting is Tuesday.')).toBeTruthy();
  });

  it('Edit draft keeps the request open and says to reply from the board inbox', async () => {
    const resolveTask = vi.fn();
    installFakeApi({ getBoardDashboard: dash([task({})]), listLots: async () => LOT_ROWS, listTemplates: async () => [], resolveTask });
    renderBoard(<BoardHome />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));
    expect(screen.getByText(/Reply from the board email inbox/)).toBeTruthy();
    expect(screen.getByText(/stays on your list/)).toBeTruthy();
    expect(resolveTask).not.toHaveBeenCalled();
  });

  it('never offers to send text it cannot show', async () => {
    installFakeApi({ getBoardDashboard: dash([task({ draft_body: null })]), listLots: async () => LOT_ROWS, listTemplates: async () => [] });
    renderBoard(<BoardHome />);
    expect(await screen.findByText(/reply text is not shown/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve and send' })).toBeNull();
  });

  it('shows an overdue records request as late, and waiting counts every open message', async () => {
    setAppNow('2027-01-27T15:00:00Z');
    installFakeApi({ getBoardDashboard: dash([task({ kind: 'records_request', due_at: '2027-01-22T15:00:00Z' })]), listLots: async () => LOT_ROWS, listTemplates: async () => [] });
    renderBoard(<BoardHome />);
    expect(await screen.findByText('3 business days late')).toBeTruthy();
    expect(screen.queryByText(/0 business days left/)).toBeNull();
    expect(screen.getByText(/Still waiting, from any week: 9/)).toBeTruthy();
  });

  it('overview tiles go to the right form', async () => {
    installFakeApi({ getBoardDashboard: dash([]), listLots: async () => LOT_ROWS, listTemplates: async () => [] });
    renderBoard(<BoardHome />);
    expect((await screen.findByRole('link', { name: 'Upload document' })).getAttribute('href')).toBe('/board/post#h-doc');
    expect(screen.getByRole('link', { name: 'Post announcement' }).getAttribute('href')).toBe('/board/post#h-ann');
  });
});

describe('BoardInbox', () => {
  const m = (o: Partial<Message>): Message => ({
    id: 'm1', lot_id: 'l23', owner_id: null, topic: 'question', subject: 'Open one', body: 'b', status: 'acknowledged',
    created_at: '2027-02-01T00:00:00Z', answered_at: null, due_at: null, gmail_thread_id: null, assigned_to: null, channel: 'portal', ...o,
  });
  it('defaults to open messages and can show all', async () => {
    installFakeApi({ listInbox: async () => [m({}), m({ id: 'm2', subject: 'Done one', status: 'answered' })], listLots: async () => LOT_ROWS, listTemplates: async () => [] });
    renderBoard(<BoardInbox />);
    expect(await screen.findByText('Open one')).toBeTruthy();
    expect(screen.queryByText('Done one')).toBeNull();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: '' } });
    expect(await screen.findByText('Done one')).toBeTruthy();
  });
  it('shows an overdue records request as late', async () => {
    setAppNow('2027-02-20T15:00:00Z');
    installFakeApi({ listInbox: async () => [m({ topic: 'records', due_at: '2027-02-15T15:00:00Z' })], listLots: async () => LOT_ROWS, listTemplates: async () => [] });
    renderBoard(<BoardInbox />);
    expect(await screen.findByText(/4 business days late/)).toBeTruthy();
  });
});

describe('BoardLots', () => {
  it('labels every cell so the stacked phone layout keeps Balance and State', async () => {
    installFakeApi({ listLots: async () => LOT_ROWS });
    renderBoard(<BoardLots />);
    const bal = (await screen.findByText('$175.00')).closest('td')!;
    expect(bal.getAttribute('data-label')).toBe('Balance');
    expect(screen.getByText('Unpaid').closest('td')!.getAttribute('data-label')).toBe('State');
  });
});

describe('BoardChecks', () => {
  it('pre-fills today in Eastern time, not UTC', async () => {
    setAppNow('2027-01-14T02:30:00Z');   // 9:30 pm on Jan 13 in Virginia
    installFakeApi({ listLots: async () => LOT_ROWS });
    renderBoard(<BoardChecks />);
    expect((screen.getByLabelText('Date received') as HTMLInputElement).value).toBe('2027-01-13');
  });
});

describe('BoardPost document form', () => {
  it('requires a file and clears the file input after adding', async () => {
    const addDocument = vi.fn().mockResolvedValue({});
    installFakeApi({ addDocument });
    renderBoard(<BoardPost />);
    const form = screen.getByRole('button', { name: 'Add document' }).closest('form')!;
    const title = form.querySelector('input:not([type])') as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'Minutes' } });
    expect((form.querySelector('input[type=file]') as HTMLInputElement).required).toBe(true);
    fireEvent.submit(form);                      // bypasses browser validation: the handler must still refuse
    expect(await screen.findByText('Choose a file to upload.')).toBeTruthy();
    expect(addDocument).not.toHaveBeenCalled();
    const before = form.querySelector('input[type=file]')!;
    fireEvent.change(before, { target: { files: [new File(['x'], 'm.pdf')] } });
    fireEvent.submit(form);
    await waitFor(() => expect(addDocument).toHaveBeenCalled());
    await screen.findByText('Document added.');
    expect(form.querySelector('input[type=file]')).not.toBe(before);   // remounted: the old filename is gone
  });
});
