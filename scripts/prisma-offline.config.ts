import { defineConfig } from 'prisma/config';

// Offline validation/generation only: deliberately does not import dotenv or a datasource URL.
export default defineConfig({ schema: '../prisma/schema.prisma' });
