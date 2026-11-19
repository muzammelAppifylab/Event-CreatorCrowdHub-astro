-- The invites resend preview and the single and bulk resend look for a pending 'invite' outbox row
-- for an invite_id; guest_email_outbox.invite_id had no index. Partial: only pending rows that
-- belong to an invite.
BEGIN;

CREATE INDEX "guest_email_outbox_pending_invite_idx" ON "guest_email_outbox"("invite_id") WHERE (((status)::text = 'pending'::text) AND (invite_id IS NOT NULL));

COMMIT;
