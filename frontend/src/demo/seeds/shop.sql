-- The `shop` demo source: a small store. Synthetic and deterministic (no
-- random()), so a rebuild reproduces the synthetic page byte for byte.
-- example.com/.org/.net are reserved for documentation (RFC 2606).

create schema reporting;

create table users (
  id uuid primary key,
  email text not null,
  display_name text not null,
  is_admin boolean not null,
  signup_source jsonb,
  created_at timestamptz not null
);
comment on table users is 'Registered accounts.';
comment on column users.signup_source is 'Attribution captured at signup.';
insert into users
select md5('users:' || i)::uuid,
       lower(f || '.' || l || i) || '@' || (array['example.com', 'mail.example.org', 'example.net'])[1 + i % 3],
       f || ' ' || l,
       i % 17 = 0,
       jsonb_build_object(
         'campaign', (array['organic', 'referral', 'ads', 'newsletter'])[1 + (i * 7) % 4],
         'utm_ref', case when i % 2 = 0 then (array['hn', 'reddit', 'twitter'])[1 + i % 3] end),
       timestamptz '2023-01-01 00:00:00+00' + make_interval(days => (i * 13) % 900)
from generate_series(0, 63) i,
     lateral (select (array['Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Drew',
                            'Quinn', 'Priya', 'Wei', 'Fatima', 'Noah', 'Ivy'])[1 + (i * 7) % 15] f,
                     (array['Chen', 'Patel', 'Garcia', 'Nguyen', 'Smith', 'Okafor', 'Rossi', 'Kim', 'Novak',
                            'Silva'])[1 + (i * 3) % 10] l) n;

create table products (
  id uuid primary key,
  name text not null,
  tags jsonb not null,
  price_cents integer not null,
  metadata jsonb
);
comment on table products is 'Catalog items.';
comment on column products.metadata is 'Vendor-supplied attributes, shape varies by category.';
insert into products
select md5('products:' || i)::uuid,
       initcap(c) || ' ' || (array['Widget', 'Gadget', 'Kit', 'Set', 'Case', 'Lamp', 'Mug', 'Sensor'])[1 + (i * 3) % 8] || ' ' || i,
       jsonb_build_array(c, case when i % 5 < 2 then 'sale' else 'new' end),
       200 + (i * 2027) % 9800,
       jsonb_build_object('category', c, 'weight_kg', ((i * 37) % 2000) / 100.0, 'in_stock', i % 7 <> 0)
from generate_series(0, 47) i,
     lateral (select (array['electronics', 'home', 'outdoors', 'books', 'toys'])[1 + i % 5] c) n;

create table orders (
  id uuid primary key,
  user_id uuid not null references users(id),
  status text not null,
  total_cents integer not null,
  notes text,
  created_at timestamptz not null
);
comment on column orders.status is 'Order lifecycle state.';
insert into orders
select md5('orders:' || i)::uuid,
       md5('users:' || (i * 11) % 64)::uuid,
       (array['pending', 'paid', 'shipped', 'delivered', 'cancelled'])[1 + (i * 3) % 5],
       500 + (i * 4801) % 48000,
       case when i % 10 < 3 then null
            else (array['gift wrap requested', 'leave at door', 'call on arrival'])[1 + i % 3] end,
       timestamptz '2023-01-01 00:00:00+00' + make_interval(days => (i * 29) % 900)
from generate_series(0, 95) i;

create table order_items (
  id uuid primary key,
  order_id uuid not null references orders(id),
  product_id uuid not null references products(id),
  quantity integer not null,
  unit_price_cents integer not null
);
insert into order_items
select md5('order_items:' || i)::uuid,
       md5('orders:' || (i * 7) % 96)::uuid,
       md5('products:' || (i * 5) % 48)::uuid,
       1 + i % 4,
       199 + (i * 1201) % 12000
from generate_series(0, 239) i;

-- 1:1 detail table: user_id is both this table's PK and a FK to users(id).
create table user_profiles (
  user_id uuid primary key references users(id),
  bio text,
  avatar_url text
);
insert into user_profiles
select md5('users:' || i)::uuid,
       case when i % 5 = 0 then null
            else (array['Coffee-powered engineer.', 'Cat parent.', 'Runs on weekends.', 'Still learning SQL.',
                        'Here for the data.'])[1 + (i * 3) % 5] end,
       case when i % 2 = 0 then null else 'https://example.com/avatars/' || i || '.png' end
from generate_series(0, 39) i;

create table reporting.daily_summary (
  summary_date date primary key,
  total_orders integer not null,
  total_revenue_cents integer not null,
  notes jsonb
);
insert into reporting.daily_summary
select date '2026-07-01' + i,
       20 + (i * 97) % 300,
       30000 + (i * 7907) % 900000,
       case when i % 10 < 7 then null
            else jsonb_build_object('flagged', true,
                   'reason', (array['payment provider outage', 'holiday spike', 'data backfill'])[1 + i % 3]) end
from generate_series(0, 29) i;

create table reporting.signup_funnel (
  id uuid primary key,
  stage text not null,
  count integer not null,
  captured_at timestamptz not null
);
insert into reporting.signup_funnel
select md5('signup_funnel:' || i)::uuid,
       (array['visited', 'signed_up', 'verified_email', 'completed_profile', 'first_order'])[1 + i % 5],
       100 + (i * 619) % 5000,
       timestamptz '2026-01-01 00:00:00+00' + make_interval(days => (i * 9) % 300)
from generate_series(0, 19) i;

-- order_items stays unanalyzed so its count shows the "no cheap estimate"
-- fallback (spec/protocol.md §5.3).
analyze users, products, orders, user_profiles, reporting.daily_summary, reporting.signup_funnel;
