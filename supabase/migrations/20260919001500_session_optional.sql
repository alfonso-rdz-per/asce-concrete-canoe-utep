-- Commit before the next migration: a new enum value cannot be used in the
-- transaction that adds it.
alter type public.session_audience add value if not exists 'optional';
