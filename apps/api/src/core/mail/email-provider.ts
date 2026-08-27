/**
 * Email transport contract.
 *
 * Business code never imports a provider directly - it calls NotificationService,
 * which calls whatever provider `resolveEmailProvider()` returned. Swapping SMTP
 * for a hosted API later is a new file and one line in the resolver, with no
 * changes anywhere in the modules.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body. Always provided - some clients never render HTML. */
  text: string;
  /** Optional richer body. */
  html?: string;
}

export interface EmailResult {
  /** False when the provider accepted the call but did not deliver. */
  delivered: boolean;
  /** Provider-specific id, useful for tracing. Never contains message content. */
  messageId?: string;
  /** Which provider handled it, for logs. */
  provider: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailResult>;
  /** Called once at boot. Should throw if the provider cannot work. */
  verify?(): Promise<void>;
}
