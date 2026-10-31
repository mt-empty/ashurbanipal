-- The `tracker` demo source: wearable trackers in a fulfilment warehouse.
-- Synthetic and deterministic. Keep every table at or under 30,000 rows:
-- ANALYZE then reads every row, so its statistics (and the synthetic page's
-- snapshot of them) are the same on every build.
create table zones (
  id smallint primary key,
  code text not null unique,
  kind text not null check (kind in ('pick', 'pack', 'ship', 'dock')),
  floor smallint not null
);
comment on table zones is 'Floor areas a tracker can report from';
insert into zones
select i, (array['P','K','S','D'])[1 + i % 4] || '-' || lpad(i::text, 2, '0'),
       (array['pick','pack','ship','dock'])[1 + i % 4], 1 + i % 3
from generate_series(1, 16) i;

create table workers (
  id integer primary key,
  badge_id text not null unique,
  display_name text not null,
  role text not null check (role in ('trainee', 'associate', 'trainer', 'lead')),
  badge_color text not null,
  shift text not null,
  hired_on date not null
);
comment on table workers is 'People who wear a tracker';
comment on column workers.badge_color is 'Colour printed on the badge; marks the role';
insert into workers
select i, 'B' || lpad(((i * 7919) % 100000)::text, 5, '0'),
       f || ' ' || substr(l, 1, 1) || '.',
       r, (array['white','blue','green','orange'])[array_position(array['trainee','associate','trainer','lead'], r)],
       (array['early','late','night'])[1 + i % 3],
       date '2022-01-01' + (i * 3) % 1400
from generate_series(1, 300) i,
     lateral (select (array['Sam','Alex','Jo','Robin','Kai','Noor','Ira','Max','Lee','Remi','Ana','Tom'])[1 + i % 12] f,
                     (array['Okoro','Lindqvist','Haddad','Moreau','Tanaka','Kowalski','Reyes','Byrne'])[1 + (i * 5) % 8] l,
                     case when i % 10 = 0 then 'lead' when i % 7 = 0 then 'trainer'
                          when i % 5 = 0 then 'trainee' else 'associate' end r) n;

create table devices (
  id uuid primary key,
  worker_id integer references workers(id) on delete set null,
  kind text not null,
  firmware text not null,
  battery_pct smallint,
  last_seen_at timestamptz
);
comment on column devices.worker_id is 'Null while the device sits in the charging rack';
insert into devices
select md5('device' || i)::uuid,
       case when i > 300 then null else i end,
       case when i % 2 = 0 then 'wristband' else 'handheld scanner' end,
       '4.' || (i % 3) || '.' || (i % 11),
       case when i % 17 = 0 then null else (i * 37) % 101 end,
       case when i % 23 = 0 then null else timestamptz '2026-10-29 06:00:00+00' + make_interval(mins => (i * 7) % 900) end
from generate_series(1, 360) i;

create table location_pings (
  id bigint primary key,
  device_id uuid not null references devices(id),
  zone_id smallint not null references zones(id),
  x numeric(6,2) not null,
  y numeric(6,2) not null,
  recorded_at timestamptz not null
);
create index location_pings_device_time_idx on location_pings(device_id, recorded_at);
insert into location_pings
select i, md5('device' || (1 + i % 300))::uuid, 1 + (i * 7) % 16,
       ((i * 7919) % 12000) / 100.0, ((i * 104729) % 8000) / 100.0,
       timestamptz '2026-10-29 06:00:00+00' + make_interval(secs => i * 2)
from generate_series(1, 20000) i;

create table scan_events (
  id bigint primary key,
  worker_id integer not null references workers(id),
  zone_id smallint not null references zones(id),
  item_count integer not null,
  scanned_at timestamptz not null
);
insert into scan_events
select i, 1 + (i * 13) % 300, 1 + (i * 3) % 16, 1 + i % 6,
       timestamptz '2026-10-29 06:00:00+00' + make_interval(secs => i * 5)
from generate_series(1, 8000) i;

create table idle_alerts (
  id integer primary key,
  worker_id integer not null references workers(id),
  started_at timestamptz not null,
  duration_seconds integer not null,
  reason text,
  reviewed boolean not null default false,
  notes jsonb
);
comment on table idle_alerts is 'Time off task, as flagged by the tracker';
create index idle_alerts_unreviewed_idx on idle_alerts(worker_id) where not reviewed;
insert into idle_alerts
select i, 1 + (i * 31) % 300,
       timestamptz '2026-10-29 06:00:00+00' + make_interval(mins => (i * 17) % 900),
       300 + (i * 211) % 3000,
       case when i % 3 = 0 then null else (array['restroom','equipment fault','helping a colleague','break','no stock in bin'])[1 + i % 5] end,
       i % 4 = 0,
       case when i % 9 = 0 then jsonb_build_object('escalated', true, 'by', 'lead') else null end
from generate_series(1, 1500) i;

analyze;
