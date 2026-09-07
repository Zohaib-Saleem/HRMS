import type { AttendanceDeviceProtocol } from '@prisma/client';
import type { AttendanceDeviceAdapter } from '@hrms/zkteco';
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
    // Both inbound protocols land here, and saying which one plainly beats a
    // null dereference three frames deeper. Neither is a missing feature: this
    // server has no route to either device, which is the entire reason those
    // protocols exist.
    const reason: Partial<Record<AttendanceDeviceProtocol, string>> = {
      ZKTECO_ADMS:
        'ADMS devices push their own records; they are not polled. Configure the device to post to this server instead.',
      ZKTECO_LAN_CONNECTOR:
        'This device is reached by a connector on its own LAN; this server never opens a connection to it. Run the connector there and let it post the records.',
    };
    throw new Error(reason[protocol] ?? `No adapter is registered for ${protocol}.`);
  }
  return adapter;
}

export function isPollable(protocol: AttendanceDeviceProtocol): boolean {
  return ADAPTERS[protocol] !== undefined;
}

/** The protocols the scheduler may contact, for querying devices directly. */
export const POLLABLE_PROTOCOLS = Object.keys(ADAPTERS) as AttendanceDeviceProtocol[];
