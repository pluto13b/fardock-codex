export const protocolErrorCodes = [
  'invalid-json',
  'frame-too-large',
  'schema-invalid',
  'unsupported-version',
  'unknown-message-type',
  'payload-too-large',
  'expired',
  'future-sent-at',
  'ttl-exceeded',
  'route-mismatch',
  'generation-mismatch',
  'replay',
  'sequence-gap',
  'ack-regression',
  'ack-ahead',
  'not-authenticated',
  'device-revoked',
  'host-unavailable',
  'rate-limited',
  'backpressure',
  'pair-session-unavailable',
  'pair-confirmation-required',
  'action-conflict',
  'capability-denied',
  'stale-authority',
  'internal',
] as const

export type ProtocolErrorCode = (typeof protocolErrorCodes)[number]

const safeMessages: Record<ProtocolErrorCode, string> = {
  'invalid-json': 'The frame is not valid protocol JSON.',
  'frame-too-large': 'The frame exceeds the protocol size limit.',
  'schema-invalid': 'The frame does not match the protocol schema.',
  'unsupported-version': 'The protocol version is not supported.',
  'unknown-message-type': 'The message type is not supported.',
  'payload-too-large': 'The encrypted payload exceeds the protocol size limit.',
  expired: 'The frame has expired.',
  'future-sent-at': 'The frame timestamp is too far in the future.',
  'ttl-exceeded': 'The frame lifetime exceeds the protocol limit.',
  'route-mismatch': 'The authenticated route does not match this connection.',
  'generation-mismatch': 'The connection generation does not match.',
  replay: 'The frame sequence was already consumed.',
  'sequence-gap': 'The frame sequence is not contiguous.',
  'ack-regression': 'The acknowledgement moved backwards.',
  'ack-ahead': 'The acknowledgement exceeds sent state.',
  'not-authenticated': 'The connection is not authenticated.',
  'device-revoked': 'The device authorization is no longer valid.',
  'host-unavailable': 'The host is unavailable.',
  'rate-limited': 'The connection is rate limited.',
  backpressure: 'The receiver cannot accept more frames.',
  'pair-session-unavailable': 'The pairing session is unavailable.',
  'pair-confirmation-required': 'Local pairing confirmation is required.',
  'action-conflict': 'The action identifier conflicts with an earlier action.',
  'capability-denied': 'The requested capability is not available.',
  'stale-authority': 'The request authority is stale or ambiguous.',
  internal: 'The protocol operation failed.',
}

export class ProtocolViolation extends Error {
  readonly code: ProtocolErrorCode

  constructor(code: ProtocolErrorCode) {
    super(safeMessages[code])
    this.name = 'ProtocolViolation'
    this.code = code
  }
}

export interface ProtocolErrorPayload {
  code: ProtocolErrorCode
  message: string
}

export function protocolErrorPayload(code: ProtocolErrorCode): ProtocolErrorPayload {
  return { code, message: safeMessages[code] }
}
