import type { ChannelConnection, ChannelConnectionStatus } from '@melonoffice/domain';

export const CONNECTION_STATUSES = [
  'created',
  'connecting',
  'connected',
  'paused',
  'error',
  'disconnected',
  'revoked',
] as const satisfies readonly ChannelConnectionStatus[];

export const isConnectionStatus = (value: unknown): value is ChannelConnectionStatus =>
  typeof value === 'string' && (CONNECTION_STATUSES as readonly string[]).includes(value);

/**
 * Every change of status a connection may make (ADR-0044). Anything else is refused. `revoked`
 * is final. Checking a connection (`connecting`) is how it gets to `connected`, from anywhere
 * but `revoked`: a paused, failed or disconnected connection is checked again before it is used.
 */
export const CONNECTION_TRANSITIONS: Readonly<
  Record<ChannelConnectionStatus, readonly ChannelConnectionStatus[]>
> = Object.freeze({
  created: ['connecting', 'disconnected', 'revoked'],
  connecting: ['connected', 'error', 'connecting', 'disconnected', 'revoked'],
  connected: ['connecting', 'paused', 'error', 'disconnected', 'revoked'],
  paused: ['connecting', 'disconnected', 'revoked'],
  error: ['connecting', 'disconnected', 'revoked'],
  disconnected: ['connecting', 'revoked'],
  revoked: [],
});

export const canTransition = (
  from: ChannelConnectionStatus,
  to: ChannelConnectionStatus,
): boolean => CONNECTION_TRANSITIONS[from].includes(to);

/** The one answer to "may this connection be used to send now?". */
export const isOperational = (connection: Pick<ChannelConnection, 'status'>): boolean =>
  connection.status === 'connected';

/**
 * Whether its provider's deliveries are stored. A paused connection still stores what its
 * contacts write (nothing is lost), and one in `error` too, since a delivery is authenticated by
 * its signature, not by the access token that failed. Before it was ever checked, after it was
 * turned off, and once deleted, nothing is accepted.
 */
export const acceptsInbound = (connection: Pick<ChannelConnection, 'status'>): boolean =>
  connection.status === 'connected' ||
  connection.status === 'paused' ||
  connection.status === 'error';

/** Whether the provider's subscription check is answered: while it is being set up or used. */
export const acceptsHandshake = (connection: Pick<ChannelConnection, 'status'>): boolean =>
  connection.status !== 'disconnected' && connection.status !== 'revoked';

/** Whether it takes one of the plan's connection slots (`integrations.connectionsMax`). */
export const occupiesSlot = (connection: Pick<ChannelConnection, 'status'>): boolean =>
  connection.status !== 'disconnected' && connection.status !== 'revoked';
