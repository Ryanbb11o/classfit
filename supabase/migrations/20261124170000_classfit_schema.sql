-- Classfit: members, visits and the free first visit.
-- Logins live in Supabase Auth (auth.users). Each login gets one row in public.members.
-- All tables are locked to the website server (service role): the browser never reads them directly.

create table if not exists public.members (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid unique references auth.users (id) on delete cascade,  -- null only for the demo guest
  member_no     text not null unique,                                      -- e.g. CF-123456, shown as the QR code
  name          text not null,
  email         text not null,
  phone         text not null default '',
  sub_until     date,                                                      -- last day the subscription is valid
  notes         text not null default '',                                  -- trainer notes, never shown to the member
  trial_until   date,                                                      -- free first visit: last day it can be used
  trial_used_at timestamptz,                                               -- when the free visit was used
  is_guest      boolean not null default false,                            -- shared read-only demo account
  created_at    timestamptz not null default now()
);
create unique index if not exists members_email_lower_key on public.members (lower(email));

create table if not exists public.checkins (
  id        bigint generated always as identity primary key,
  member_id uuid not null references public.members (id) on delete cascade,
  at        timestamptz not null default now(),
  active    boolean not null,                                              -- had a subscription (or free visit) at that moment
  source    text not null default 'desk' check (source in ('desk', 'trainer')),
  staff     text not null default '',                                      -- trainer name, if marked by a trainer
  free      boolean not null default false                                 -- this was the free first visit
);
create index if not exists checkins_member_at_idx on public.checkins (member_id, at desc);

-- Lock the tables: row level security on, no policies, no access for browser roles.
alter table public.members  enable row level security;
alter table public.checkins enable row level security;
revoke all on public.members, public.checkins from anon, authenticated;

-- Staff overview: members with visit count and last visit.
create or replace view public.member_overview with (security_invoker = true) as
  select m.*,
         (select count(*) from public.checkins c where c.member_id = m.id)  as visits,
         (select max(c.at) from public.checkins c where c.member_id = m.id) as last_visit
  from public.members m;
revoke all on public.member_overview from anon, authenticated;

-- A new, unused member number.
create or replace function public.new_member_no() returns text
language plpgsql set search_path = public as $$
declare n text;
begin
  loop
    n := 'CF-' || (floor(random() * 900000) + 100000)::int::text;
    exit when not exists (select 1 from public.members where member_no = n);
  end loop;
  return n;
end $$;

-- Free first visit: valid today, or until tomorrow if signing up at 18:00 or later (Sofia time).
create or replace function public.trial_end_date() returns date
language sql stable set search_path = public as $$
  select case
    when extract(hour from now() at time zone 'Europe/Sofia') >= 18
      then (now() at time zone 'Europe/Sofia')::date + 1
    else (now() at time zone 'Europe/Sofia')::date
  end
$$;

-- Every new login gets a member row with a member number and a free first visit.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.members (user_id, member_no, name, email, phone, trial_until)
  values (
    new.id,
    public.new_member_no(),
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), split_part(new.email, '@', 1)),
    lower(new.email),
    regexp_replace(regexp_replace(coalesce(new.raw_user_meta_data ->> 'phone', ''), '[^0-9+]', '', 'g'), '^(\+|00)359', '0'),
    public.trial_end_date()
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep the member's email in step when they change their login email.
create or replace function public.handle_user_email_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is distinct from old.email then
    update public.members set email = lower(new.email) where user_id = new.id;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.handle_user_email_change();

-- Log a visit. Without a subscription, an unused free visit is spent here, in one step.
create or replace function public.log_visit(p_member uuid, p_source text, p_staff text default '')
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  m public.members;
  today date := (now() at time zone 'Europe/Sofia')::date;
  is_active boolean;
  is_free boolean := false;
begin
  select * into m from public.members where id = p_member for update;
  if not found or m.is_guest then
    raise exception 'not_found';
  end if;
  is_active := m.sub_until is not null and m.sub_until >= today;
  if not is_active and m.trial_until is not null and m.trial_used_at is null and m.trial_until >= today then
    update public.members set trial_used_at = now() where id = m.id;
    is_free := true;
  end if;
  insert into public.checkins (member_id, active, source, staff, free)
  values (m.id, is_active or is_free, p_source, coalesce(p_staff, ''), is_free);
  return is_free;
end $$;

-- Only the website server may run these.
revoke execute on function public.new_member_no(), public.trial_end_date(), public.handle_new_user(),
  public.handle_user_email_change(), public.log_visit(uuid, text, text) from public, anon, authenticated;
grant execute on function public.log_visit(uuid, text, text), public.new_member_no(), public.trial_end_date() to service_role;
