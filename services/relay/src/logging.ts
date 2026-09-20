import type { RelayRole } from '@codex-plus/protocol'

export const relayLogEventNames = [
  'relay.started',
  'relay.stopped',
  'connection.authenticated',
  'connection.closed',
  'route.relayed',
  'route.unavailable',
  'route.rate_limited',
  'route.backpressure',
  'heartbeat.terminated',
] as const

export type RelayLogEventName = (typeof relayLogEventNames)[number]

export interface RelayLogEntry {
  timestamp: number
  event: RelayLogEventName
  connectionCount: number
  role?: RelayRole
  outcome?: 'authenticated' | 'closed' | 'relayed' | 'unavailable' | 'rate-limited' | 'backpressure' | 'terminated'
  frameBytes?: number
  closeCode?: number
}

export type RelayLogger = (entry: RelayLogEntry) => void
