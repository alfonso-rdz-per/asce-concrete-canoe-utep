-- Preserve existing sessions' historical population. New sessions use version 2.
alter table public.sessions
  add column attendance_rule_version smallint not null default 1
  check (attendance_rule_version in (1, 2));
alter table public.sessions alter column attendance_rule_version set default 2;
grant select (attendance_rule_version) on public.sessions to authenticated;

create or replace view public.session_attendance with (security_invoker = true) as
select
  t.session_id, t.member_id, t.status, t.source,
  (t.is_expected and t.session_audience <> 'optional') as counts_toward_rate,
  t.session_title, t.session_held_at, t.session_status, t.session_audience,
  t.for_member, t.is_expected
from (
  select r.*,
    (r.session_status = 'closed' and r.for_member and
      (r.status = 'present' or
        (r.held_on >= r.joined_on and
          (r.deactivated_on is null or r.held_on <= r.deactivated_on)))) as is_expected
  from (
    select
      s.id as session_id, m.id as member_id,
      case when o.status is not null then o.status
           when c.id is not null then 'present'::public.attendance_status
           else 'absent'::public.attendance_status end as status,
      case when o.status is not null then 'manual'
           when c.id is not null then 'check_in' else 'none' end as source,
      s.title as session_title,
      coalesce(s.opened_at, s.scheduled_at) as session_held_at,
      s.status as session_status, s.audience as session_audience,
      (s.audience in ('both', 'optional') or
        case when s.attendance_rule_version = 1
          then ((s.audience = 'design_team') = m.is_design_team)
          else (s.audience <> 'design_team' or m.is_design_team)
        end) as for_member,
      (coalesce(s.opened_at, s.scheduled_at) at time zone 'America/Denver')::date as held_on,
      m.joined_on, m.deactivated_on
    from public.sessions s
    cross join public.members m
    left join public.checkins c on c.session_id = s.id and c.member_id = m.id
    left join public.attendance_overrides o on o.session_id = s.id and o.member_id = m.id
    where s.status <> 'draft'
  ) r
) t;

-- Optional has a meeting roster without contributing to member_attendance.
-- Extra Design attendees never inflate the expected group's attendance rate.
create or replace view public.session_attendance_summary with (security_invoker = true) as
select
  t.session_id, t.present_count, t.expected_count,
  case when t.expected_count = 0 then null
       else floor((t.present_count::float8 / t.expected_count::float8) * 100 + 0.5)::int end as rate,
  t.extra_count
from (
  select sa.session_id,
    (count(*) filter (where sa.is_expected and sa.status = 'present'))::int as present_count,
    (count(*) filter (where sa.is_expected))::int as expected_count,
    (count(*) filter (where sa.session_status = 'closed' and not sa.for_member and sa.status = 'present'))::int as extra_count
  from public.session_attendance sa
  group by sa.session_id
) t;

grant select on public.session_attendance to authenticated;
grant select on public.session_attendance_summary to authenticated;
