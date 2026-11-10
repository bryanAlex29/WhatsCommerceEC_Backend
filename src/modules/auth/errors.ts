export class AuthError extends Error {
  constructor(readonly status: number, readonly code: string, message = 'Solicitud no autorizada',
    readonly fields?: Array<{ field: string; code: string }>) {
    super(message);
  }
}
export function unavailable(): never {
  throw new AuthError(503, 'SERVICE_TEMPORARILY_UNAVAILABLE', 'Servicio temporalmente no disponible');
}
