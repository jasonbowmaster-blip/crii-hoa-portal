import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { installFakeApi, LOT_ROWS, renderBoard } from './testApi';
import BoardHome from './BoardHome';
import BoardInbox from './BoardInbox';
import BoardLots from './BoardLots';
import BoardChecks from './BoardChecks';
import BoardBillRun from './BoardBillRun';
import BoardPost from './BoardPost';
import type { BoardTask, Message } from '../../data/types';

afterEach(cleanup);

const task = (o: Partial<BoardTask>): BoardTask => ({
  id: 't1', kind: 'check_confirm', lot_id: 'l23', title: 'Check #1042', summary: 'Needs a second person.',
  status: 'open', created_at: '2027-02-01T00:00:00Z', due_at: null, ref_id: null, resolved_by: null, resolved_at: null, ...o,
});

describe('BoardHome', () => {
  it('renders stats and tasks, and resolves a task', async () => {
    const resolveTask = vi.fn().mockResolvedValue(task({ status: 'done' }));
    installFakeApi({
      getBoardDashboard: async () => ({
        lots_total: 150, lots_paid: 96, owners_signed_in: 61, open_tasks: [task({})],
        messages_this_week: { received: 18, answered: 14, waiting: 4, oldest_waiting_business_days: 1 },
      }),
      listLots: async () => LOT_ROWS, resolveTask,
    });
    renderBoard(<BoardHome />);
    expect(await screen.findByText('96 of 150')).toBeTruthy();
    expect(screen.getByText('61 of 150')).toBeTruthy();
    expect(screen.getByText(/Every reply is sent by a person\./)).toBeTruthy();
    expect(await screen.findByText(/Check · Lot 23/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deposit' }));
    await waitFor(() => expect(resolveTask).toHaveBeenCalledWith('t1', 'approve'));
    expect(await screen.findByText('Deposit confirmed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm deposit' })).toBeNull();
  });
});

describe('BoardInbox', () => {
  const msg: Message = {
    id: 'm1', lot_id: 'l23', owner_id: null, topic: 'records', subject: 'Bank statements', body: 'Please send.',
    status: 'new', created_at: '2027-02-01T00:00:00Z', answered_at: null, due_at: '2027-02-15T00:00:00Z',
    gmail_thread_id: null, assigned_to: null, channel: 'portal',
  };
  it('lists only approved templates and replies', async () => {
    const replyWithTemplate = vi.fn().mockResolvedValue({ ...msg, status: 'answered' });
    installFakeApi({
      listInbox: async () => [msg], listLots: async () => LOT_ROWS,
      listTemplates: async () => [
        { id: 'a', name: 'Meeting times', body: 'Thank you for asking.', version: 1, approved_on: '2027-01-01' },
        { id: 'b', name: 'Unapproved draft', body: '', version: 1, approved_on: null },
      ],
      replyWithTemplate,
    });
    renderBoard(<BoardInbox />);
    const select = await screen.findByLabelText('Reply with template');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Meeting times' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'Unapproved draft' })).toBeNull();
    expect(screen.getByText(/business days? left/)).toBeTruthy();
    fireEvent.change(select, { target: { value: 'a' } });
    // choosing a template only previews it: nothing is sent until the board member confirms
    expect(replyWithTemplate).not.toHaveBeenCalled();
    expect(screen.getByText('Thank you for asking.')).toBeTruthy();
    expect(screen.getByText(/nothing is delivered to anyone/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, send this reply' }));
    await waitFor(() => expect(replyWithTemplate).toHaveBeenCalledWith('m1', 'a'));
    expect(await screen.findByText(/Reply sent by you/)).toBeTruthy();
  });
});

describe('BoardLots', () => {
  it('shows lots with owner email and balance', async () => {
    installFakeApi({ listLots: async () => LOT_ROWS });
    renderBoard(<BoardLots />);
    expect(await screen.findByText('23 Sample Lane')).toBeTruthy();
    expect(screen.getByText(/sample@example\.test/)).toBeTruthy();
    expect(screen.getByText('$175.00')).toBeTruthy();
  });
});

describe('BoardChecks', () => {
  function fill() {
    fireEvent.change(screen.getByLabelText('Lot'), { target: { value: 'l23' } });
    fireEvent.change(screen.getByLabelText('Check number'), { target: { value: '1042' } });
    fireEvent.change(screen.getByLabelText('Amount in dollars'), { target: { value: '175.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log check' }));
  }
  it('converts dollars to cents', async () => {
    const logCheck = vi.fn().mockResolvedValue({ check_number: '1042' });
    installFakeApi({ listLots: async () => LOT_ROWS, logCheck });
    renderBoard(<BoardChecks />);
    await screen.findByRole('option', { name: /Lot 23/ });
    fill();
    await waitFor(() => expect(logCheck).toHaveBeenCalled());
    expect(logCheck.mock.calls[0][0]).toMatchObject({ lot_id: 'l23', check_number: '1042', amount_cents: 17550 });
  });
  it('shows API errors', async () => {
    installFakeApi({ listLots: async () => LOT_ROWS, logCheck: async () => { throw new Error('Refused: same person.'); } });
    renderBoard(<BoardChecks />);
    await screen.findByRole('option', { name: /Lot 23/ });
    fill();
    expect((await screen.findByRole('alert')).textContent).toContain('Refused: same person.');
  });
});

describe('BoardBillRun', () => {
  it('previews totals and keeps Send disabled', async () => {
    const previewBillRun = vi.fn().mockResolvedValue({
      year: 2027, due_on: '2027-05-15', amount_cents: 17500,
      lots: [{ lot_id: 'l23', lot_number: 23, owner_name: 'Sample Owner', carried_cents: 0, total_cents: 17500, delivery: 'email' }],
      totals: { lots: 150, email: 100, paper: 50, billed_cents: 2625000 },
    });
    installFakeApi({ previewBillRun });
    renderBoard(<BoardBillRun />);
    expect((screen.getByRole('button', { name: 'Send bills' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Preview bill run' }));
    expect(await screen.findByText(/Total billed \$26,250\.00/)).toBeTruthy();
    expect(previewBillRun).toHaveBeenCalledWith({ year: 2027, amount_cents: 17500, due_on: '2027-05-15' });
    expect(screen.getByText(/150 lots · 100 by email · 50 on paper/)).toBeTruthy();
    expect(screen.getByText('Sample Owner')).toBeTruthy();
    expect(screen.getByText(/Sending is turned off in this prototype/)).toBeTruthy();
  });
});

describe('BoardPost', () => {
  it('posts an announcement and confirms', async () => {
    const postAnnouncement = vi.fn().mockResolvedValue({});
    installFakeApi({ postAnnouncement });
    renderBoard(<BoardPost />);
    fireEvent.change(screen.getByLabelText('Title', { selector: '#h-ann ~ label input' }), { target: { value: 'Pool opens' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Memorial Day.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post announcement' }));
    await waitFor(() => expect(postAnnouncement).toHaveBeenCalledWith({ title: 'Pool opens', body: 'Memorial Day.', audience: 'owners' }));
    expect(await screen.findByText('Announcement posted.')).toBeTruthy();
  });
});
