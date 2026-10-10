-- World ID was removed (spec 2026-10-10). Drop what 009_world_id.sql added.
drop index if exists accounts_world_nullifier;
alter table accounts drop column if exists world_nullifier;
alter table accounts drop column if exists world_credential;
alter table accounts drop column if exists world_verified_at;
