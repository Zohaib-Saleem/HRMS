import { describe, expect, it } from 'vitest';
import type { PasswordResetSendResult } from '@hrms/shared';
import { resetLinkToast } from './users-page';

/**
 * What the "Send reset link" button says afterwards.
 *
 * The bug these hold down: the screen reported "Reset link sent" on the
 * strength of a 200, and a 200 only ever meant a token had been created. A
 * production server left on the console mail provider created good tokens and
 * delivered nothing, so the toast was green every time and nobody received an
 * email. Three outcomes, three different sentences.
 */
describe('resetLinkToast', () => {
  const result = (over: Partial<PasswordResetSendResult> = {}): PasswordResetSendResult => ({
    sent: true,
    delivery: 'delivered',
    ...over,
  });

  it('claims a send only when a transport actually accepted the message', () => {
    expect(resetLinkToast(result())).toEqual({
      tone: 'success',
      message: 'Password reset link sent.',
    });
  });

  it('says delivery is unconfirmed when the transport delivered nothing', () => {
    const { tone, message } = resetLinkToast(result({ delivery: 'unconfirmed' }));

    expect(tone).toBe('warning');
    expect(message).toContain('could not be confirmed');
    // The one thing it must not do is imply the email went out.
    expect(message).not.toContain('sent.');
  });

  it('reports a failure as an error, not as a send', () => {
    const { tone, message } = resetLinkToast(result({ delivery: 'failed', errorCode: 'EAUTH' }));

    expect(tone).toBe('error');
    expect(message).toContain('could not be sent');
    expect(message).toContain('EAUTH');
  });

  it('reports a failure without a code just as clearly', () => {
    const { message } = resetLinkToast(result({ delivery: 'failed' }));

    expect(message).toContain('could not be sent');
    expect(message).not.toContain('()');
  });

  it('falls back to unconfirmed rather than success for an unrecognised answer', () => {
    // A server that predates this field, or a status added later. Assuming
    // success is precisely the mistake being fixed.
    expect(resetLinkToast(undefined).tone).toBe('warning');
    expect(resetLinkToast(result({ delivery: 'skipped' })).tone).toBe('warning');
  });

  it('never puts a token, a link or a relay address in front of anybody', () => {
    for (const delivery of ['delivered', 'unconfirmed', 'failed', 'skipped'] as const) {
      const { message } = resetLinkToast(result({ delivery, errorCode: 'ECONNECTION' }));
      expect(message).not.toContain('token');
      expect(message).not.toContain('reset-password');
      expect(message).not.toMatch(/smtp|@/i);
    }
  });
});
