import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  getHealth(): { status: 'ok'; service: 'whatscommerceec-backend' } {
    return { status: 'ok', service: 'whatscommerceec-backend' };
  }
}
