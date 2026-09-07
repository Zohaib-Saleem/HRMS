/**
 * Talking to ZKTeco standalone terminals.
 *
 * Extracted from the API so the on-site connector can speak the same protocol
 * without a second copy of the decoder. Nothing here knows about the HRMS: no
 * database, no employee, no attendance rule, and no timezone. It reads bytes
 * off a terminal and says what they were.
 */
export * from './device.js';
export * from './protocol.js';
export * from './readings.js';
export * from './session.js';
