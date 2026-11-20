-- WhatsCommerce EC: DDL revisable 1.4a.
-- Generado desde prisma/schema.prisma mediante migrate diff --from-empty --to-schema.
-- NO aplicado. No se conecta a una base ni debe ejecutarse sin autorización.
-- Requiere 000_roles.sql y un aplicador autorizado capaz de asumir wc_data_owner.
-- El esquema app_private ya pertenece a ese owner.

BEGIN;
SET LOCAL ROLE wc_data_owner;

-- CreateSchema

-- CreateEnum
CREATE TYPE "app_private"."company_status" AS ENUM ('PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "app_private"."company_role" AS ENUM ('COMPANY_ADMIN', 'SELLER');

-- CreateEnum
CREATE TYPE "app_private"."outbox_state" AS ENUM ('PENDING', 'PROCESSING', 'RETRY_PENDING', 'SMTP_ACCEPTED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "app_private"."company" (
    "id" UUID NOT NULL,
    "trade_name" VARCHAR(150) NOT NULL,
    "legal_name" VARCHAR(250) NOT NULL,
    "ruc" VARCHAR(13) NOT NULL,
    "tax_address" VARCHAR(300) NOT NULL,
    "contact_email" VARCHAR(254) NOT NULL,
    "contact_phone" VARCHAR(16) NOT NULL,
    "status" "app_private"."company_status" NOT NULL DEFAULT 'PENDING_ACTIVATION',
    "activated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_private"."app_user" (
    "id" UUID NOT NULL,
    "email_normalized" VARCHAR(254) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_private"."membership" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "role" "app_private"."company_role" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_private"."branch" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "address" VARCHAR(300) NOT NULL,
    "email" VARCHAR(254),
    "phone" VARCHAR(16),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_private"."platform_admin" (
    "user_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_admin_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "app_private"."invitation" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "email_normalized" VARCHAR(254) NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "token_hash" BYTEA NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "accepted_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_private"."app_session" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revocation_reason" TEXT,
    "current_refresh_generation" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "app_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_private"."refresh_token_history" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "replaced_at" TIMESTAMPTZ(3),

    CONSTRAINT "refresh_token_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_private"."invitation_outbox" (
    "id" UUID NOT NULL,
    "invitation_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'INITIAL_ADMIN_INVITATION',
    "encrypted_payload" BYTEA,
    "key_id" TEXT NOT NULL,
    "nonce" BYTEA NOT NULL,
    "auth_tag" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "state" "app_private"."outbox_state" NOT NULL DEFAULT 'PENDING',
    "lease_id" UUID,
    "lease_expires_at" TIMESTAMPTZ(3),
    "smtp_accepted_at" TIMESTAMPTZ(3),
    "sanitized_error_code" TEXT,

    CONSTRAINT "invitation_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_private"."invitation_emission" (
    "id" UUID NOT NULL,
    "invitation_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "company_id" UUID NOT NULL,
    "issued_by_user_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invitation_emission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_ruc_key" ON "app_private"."company"("ruc");

-- CreateIndex
CREATE INDEX "company_created_at_id_idx" ON "app_private"."company"("created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_normalized_key" ON "app_private"."app_user"("email_normalized");

-- CreateIndex
CREATE INDEX "membership_company_id_created_at_id_idx" ON "app_private"."membership"("company_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_user_id_company_id_key" ON "app_private"."membership"("user_id", "company_id");

-- CreateIndex
CREATE INDEX "branch_company_id_created_at_id_idx" ON "app_private"."branch"("company_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "branch_company_id_id_key" ON "app_private"."branch"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_company_id_key" ON "app_private"."invitation"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_token_hash_key" ON "app_private"."invitation"("token_hash");

-- CreateIndex
CREATE INDEX "invitation_accepted_by_user_id_idx" ON "app_private"."invitation"("accepted_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_id_company_id_key" ON "app_private"."invitation"("id", "company_id");

-- CreateIndex
CREATE INDEX "app_session_user_id_created_at_id_idx" ON "app_private"."app_session"("user_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_history_token_hash_key" ON "app_private"."refresh_token_history"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_history_session_id_generation_key" ON "app_private"."refresh_token_history"("session_id", "generation");

-- CreateIndex
CREATE INDEX "invitation_outbox_state_available_at_id_idx" ON "app_private"."invitation_outbox"("state", "available_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_outbox_invitation_id_generation_type_key" ON "app_private"."invitation_outbox"("invitation_id", "generation", "type");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_outbox_key_id_nonce_key" ON "app_private"."invitation_outbox"("key_id", "nonce");

-- CreateIndex
CREATE INDEX "invitation_emission_company_id_issued_at_id_idx" ON "app_private"."invitation_emission"("company_id", "issued_at", "id");

-- CreateIndex
CREATE INDEX "invitation_emission_issued_by_user_id_issued_at_id_idx" ON "app_private"."invitation_emission"("issued_by_user_id", "issued_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_emission_invitation_id_generation_key" ON "app_private"."invitation_emission"("invitation_id", "generation");

-- AddForeignKey
ALTER TABLE "app_private"."membership" ADD CONSTRAINT "membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_private"."app_user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "app_private"."membership" ADD CONSTRAINT "membership_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "app_private"."company"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "app_private"."branch" ADD CONSTRAINT "branch_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "app_private"."company"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "app_private"."platform_admin" ADD CONSTRAINT "platform_admin_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_private"."app_user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "app_private"."invitation" ADD CONSTRAINT "invitation_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "app_private"."company"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "app_private"."invitation" ADD CONSTRAINT "invitation_accepted_by_user_id_fkey" FOREIGN KEY ("accepted_by_user_id") REFERENCES "app_private"."app_user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "app_private"."app_session" ADD CONSTRAINT "app_session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_private"."app_user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "app_private"."app_session" ADD CONSTRAINT "app_session_current_refresh_fkey" FOREIGN KEY ("id", "current_refresh_generation") REFERENCES "app_private"."refresh_token_history"("session_id", "generation") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "app_private"."refresh_token_history" ADD CONSTRAINT "refresh_token_history_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "app_private"."app_session"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "app_private"."invitation_outbox" ADD CONSTRAINT "invitation_outbox_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "app_private"."invitation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "app_private"."invitation_emission" ADD CONSTRAINT "invitation_emission_invitation_id_company_id_fkey" FOREIGN KEY ("invitation_id", "company_id") REFERENCES "app_private"."invitation"("id", "company_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "app_private"."invitation_emission" ADD CONSTRAINT "invitation_emission_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "app_private"."company"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "app_private"."invitation_emission" ADD CONSTRAINT "invitation_emission_issued_by_user_id_fkey" FOREIGN KEY ("issued_by_user_id") REFERENCES "app_private"."app_user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMIT;
