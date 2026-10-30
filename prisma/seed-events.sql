-- Demo events for local development: psql "$DATABASE_URL" -f prisma/seed-events.sql
INSERT INTO "events" ("slug","title","description","start_at","end_at","timezone","format","venue_name","venue_address","status","visibility","poll_join_code")
VALUES
 ('pricing-workshop','Pricing Workshop','Work out what to charge, live.' || E'\n\n' || 'Bring one offer you want to price.', now() + interval '14 days', now() + interval '14 days 2 hours','Europe/London','hybrid','Studio One','1 High Street, London','published','public','PW0001'),
 ('monthly-mastermind','The Monthly Mastermind','Peers, laptops and a tight agenda.', now() + interval '30 days', now() + interval '30 days 90 minutes','America/New_York','online',NULL,NULL,'published','public','MM0001')
ON CONFLICT DO NOTHING;
