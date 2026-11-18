import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('devuelve el contrato de liveness', () => {
    expect(new HealthController().getHealth()).toEqual({
      status: 'ok', service: 'whatscommerceec-backend',
    });
  });
});
