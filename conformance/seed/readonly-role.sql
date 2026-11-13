-- A login role with SELECT only that doesn't own the tables. Applied after
-- seed.sql; the `postgres-readonly` conformance job connects as it.
do $$
begin
    if not exists (select from pg_roles where rolname = 'ashurbanipal_ro') then
        create role ashurbanipal_ro login password 'ashurbanipal_ro';
    end if;
end
$$;

grant usage on schema public, other_schema, warehouse to ashurbanipal_ro;
grant select on all tables in schema public, other_schema, warehouse to ashurbanipal_ro;

-- A readable table with foreign keys to three tables the client can't open:
-- one the role can't read, one in a schema it has no USAGE on, and a
-- partitioned parent (never listed). table_data.rs checks each column reports
-- no `fk` key or `references`.
drop schema if exists readonly_probe cascade;
drop schema if exists readonly_probe_nousage cascade;
create schema readonly_probe;
create schema readonly_probe_nousage;
create table readonly_probe.hidden (id integer primary key);
create table readonly_probe_nousage.parent (id integer primary key);
create table readonly_probe.parted (id integer primary key) partition by range (id);
create table readonly_probe.parted_all partition of readonly_probe.parted default;
create table readonly_probe.visible (
    id integer primary key,
    hidden_id integer references readonly_probe.hidden (id),
    nousage_id integer references readonly_probe_nousage.parent (id),
    parted_id integer references readonly_probe.parted (id)
);
grant usage on schema readonly_probe to ashurbanipal_ro;
grant select on readonly_probe.visible, readonly_probe.parted to ashurbanipal_ro;
grant select on readonly_probe_nousage.parent to ashurbanipal_ro;
