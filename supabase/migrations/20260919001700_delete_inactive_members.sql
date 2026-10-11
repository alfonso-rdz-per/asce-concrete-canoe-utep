-- Delete only inactive members, including their attendance and remembered devices.
-- Audit events and rate-limit attempts remain permanent.
alter table public.checkins
  drop constraint checkins_member_id_fkey,
  add constraint checkins_member_id_fkey foreign key (member_id)
    references public.members (id) on delete cascade;
alter table public.attendance_overrides
  drop constraint attendance_overrides_member_id_fkey,
  add constraint attendance_overrides_member_id_fkey foreign key (member_id)
    references public.members (id) on delete cascade;

create or replace function private.attendance_overrides_block_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_level = 'STATEMENT' then
    raise exception 'asce:attendance_overrides_are_permanent';
  end if;
  -- A direct deletion stays prohibited; parent deletion allows the cascade.
  if exists (select 1 from public.sessions s where s.id = old.session_id)
     and exists (select 1 from public.members m where m.id = old.member_id) then
    raise exception 'asce:attendance_overrides_are_permanent';
  end if;
  return old;
end;
$$;

create function private.members_guard_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.active then
    raise exception 'asce:member_must_be_inactive';
  end if;
  insert into public.audit_log (actor_id, action, entity_type, entity_id, detail)
  values (auth.uid(), 'member.delete', 'member', old.id::text,
    jsonb_build_object(
      'deleted_checkins', (select count(*) from public.checkins c where c.member_id = old.id),
      'deleted_corrections', (select count(*) from public.attendance_overrides o where o.member_id = old.id),
      'deleted_devices', (select count(*) from public.member_devices d where d.member_id = old.id)
    ));
  return old;
end;
$$;
create trigger members_guard_delete before delete on public.members
  for each row execute function private.members_guard_delete();
revoke all on function private.members_guard_delete() from public, anon, authenticated;
revoke all on function private.attendance_overrides_block_delete() from public, anon, authenticated;

grant delete on public.members to authenticated;
create policy members_admin_delete on public.members
  for delete to authenticated using ((select private.is_admin()));
