# Backend — WhatsCommerce EC

Consultar `../AGENTS.md` y `../docs/DERCAS.md` (especificación vigente) en el workspace de contexto. El Word de `../Contexto/WhatsCommerce-EC-Documentacion-Dercas.docx` se conserva como antecedente. Si faltan las fuentes actuales, solicitarlas al orquestador antes de implementar negocio.

- NestJS modular, TypeScript estricto; separar dominio/casos de uso/adaptadores cuando existan casos reales.
- No inventar modelos, permisos, aislamiento multiempresa ni estados de negocio.
- Health es liveness pública, no readiness ni verificación de PostgreSQL/Redis.
- No conectar Prisma ni BullMQ al boot de esta base; no crear migraciones o jobs ficticios.
- No registrar secretos. Ejecutar build, typecheck, lint, test, test:e2e y comprobaciones Prisma.
- No commits/publicación sin autorización expresa; no editar otros repositorios.
