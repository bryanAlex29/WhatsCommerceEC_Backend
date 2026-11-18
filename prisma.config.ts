import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  // validate/generate no necesitan credenciales ni conexiones. Las operaciones
  // futuras contra DB deberán exigir DATABASE_URL explícitamente.
  datasource: { url: process.env.DATABASE_URL },
});
