import type { AttendanceDeviceProtocol } from '@prisma/client';
import type { AttendanceDeviceAdapter } from './adapter.js';
import { ZkTecoAdapter } from './zkteco.adapter.js';

/**
 * Which adapter speaks for which protocol.
 *
 * The one place the rest of the system learns that ZKTeco exists. Supporting
 * another manufacturer means writing an adapter and adding a line here.
 */

const zkTeco = new ZkTecoAdapter();

const ADAPTERS: Partial<Record<AttendanceDeviceProtocol, AttendanceDeviceAdapter>> = {
  ZKTECO_TCP: zkTeco,
};

export function adapterFor(protocol: AttendanceDeviceProtocol): AttendanceDeviceAdapter {
  const adapter = ADAPTERS[protocol];
  if (!adapter) {
    // ADMS is a push protocol: the device posts to us, so there is nothing to
    // pull. Saying so plainly beats a null dereference three frames deeper.
    throw new Error(
      protocol === 'ZKTECO_ADMS'
        ? 'ADMS devices push their own records; they are not polled. Configure the device to post to this server instead.'
        : `No adapter is registered for ${protocol}.`,
    );
  }
  return adapter;
}

export function isPollable(protocol: AttendanceDeviceProtocol): boolean {
  return ADAPTERS[protocol] !== undefined;
}

/** The protocols the scheduler may contact, for querying devices directly. */
export const POLLABLE_PROTOCOLS = Object.keys(ADAPTERS) as AttendanceDeviceProtocol[];
