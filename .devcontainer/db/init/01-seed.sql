-- Sample schema/data for exercising the Ashurbanipal DB browser during
-- manual frontend development: covers uuid, timestamptz, jsonb, boolean,
-- and a foreign key, across two tables with a few dozen rows each.

create extension if not exists pgcrypto;

create table users (
    id uuid primary key default gen_random_uuid(),
    email text not null unique,
    is_active boolean not null default true,
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now()
);

create table orders (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id),
    status text not null default 'pending',
    total_cents integer not null,
    line_items jsonb not null default '[]',
    created_at timestamptz not null default now()
);

insert into users (email, metadata, created_at) values
    ('alice@example.com',   '{"role": "admin", "prefs": {"theme": "dark"}}', now() - interval '30 days'),
    ('bob@example.com',     '{"role": "user"}', now() - interval '25 days'),
    ('carol@example.com',   '{"role": "user", "prefs": {"theme": "light"}}', now() - interval '20 days'),
    ('dave@example.com',    '{"role": "user", "beta_features": ["new_dashboard"]}', now() - interval '10 days'),
    ('eve@example.com',     '{"role": "support"}', now() - interval '2 days');

update users set is_active = false where email = 'dave@example.com';

insert into orders (user_id, status, total_cents, line_items, created_at)
select
    u.id,
    (array['pending', 'completed', 'completed', 'cancelled', 'completed'])[1 + ((row_number() over ()) % 5)],
    500 + (100 * (row_number() over ())::int),
    jsonb_build_array(
        jsonb_build_object('sku', 'WIDGET-' || (row_number() over ())::text, 'qty', 1 + ((row_number() over ()) % 3))
    ),
    now() - ((row_number() over ()) || ' hours')::interval
from users u, generate_series(1, 3);

-- pg_class.reltuples is only populated by ANALYZE/autovacuum; without this,
-- a freshly seeded dev db shows -1 via /table-counts until autovacuum runs.
analyze users;
analyze orders;
