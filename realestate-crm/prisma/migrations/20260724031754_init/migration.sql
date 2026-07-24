-- CreateEnum
CREATE TYPE "ContactStatus" AS ENUM ('active', 'bought', 'cold', 'do_not_contact');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('opt_out', 'deleted');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('draft', 'sent', 'discarded');

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "crm_id" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "raw_fields" JSONB NOT NULL DEFAULT '{}',
    "source_notes" TEXT,
    "status" "ContactStatus" NOT NULL DEFAULT 'active',
    "status_changed_at" TIMESTAMP(3),
    "hand_edited" BOOLEAN NOT NULL DEFAULT false,
    "unsubscribe_token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buyer_profiles" (
    "id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "price_min" INTEGER,
    "price_max" INTEGER,
    "beds_min" INTEGER,
    "baths_min" DOUBLE PRECISION,
    "location" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "must_haves" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nice_to_haves" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lifestyle_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dealbreakers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION,
    "edited_by_user" BOOLEAN NOT NULL DEFAULT false,
    "parsed_from_hash" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buyer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "raw_text" TEXT NOT NULL,
    "address" TEXT,
    "price" INTEGER,
    "beds" INTEGER,
    "baths" DOUBLE PRECISION,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_drafts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "gmail_draft_id" TEXT,
    "status" "DraftStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppressions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email_hash" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contacts_unsubscribe_token_key" ON "contacts"("unsubscribe_token");

-- CreateIndex
CREATE INDEX "contacts_tenant_id_status_idx" ON "contacts"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_tenant_id_email_key" ON "contacts"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "buyer_profiles_contact_id_key" ON "buyer_profiles"("contact_id");

-- CreateIndex
CREATE INDEX "listings_tenant_id_idx" ON "listings"("tenant_id");

-- CreateIndex
CREATE INDEX "matches_tenant_id_idx" ON "matches"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "matches_listing_id_contact_id_key" ON "matches"("listing_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_drafts_match_id_key" ON "email_drafts"("match_id");

-- CreateIndex
CREATE INDEX "email_drafts_tenant_id_idx" ON "email_drafts"("tenant_id");

-- CreateIndex
CREATE INDEX "suppressions_tenant_id_idx" ON "suppressions"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "suppressions_tenant_id_email_hash_key" ON "suppressions"("tenant_id", "email_hash");

-- AddForeignKey
ALTER TABLE "buyer_profiles" ADD CONSTRAINT "buyer_profiles_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

