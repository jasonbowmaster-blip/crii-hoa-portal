-- Test helpers. Loaded after the migration and seed.
create schema tests;
grant usage on schema tests to public;

create function tests.as_user(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function tests.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
end $$;

-- plain assertion
create function tests.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'ASSERTION FAILED: %', msg; end if;
  raise notice 'ok - %', msg;
end $$;

create function tests.eq(actual anyelement, expected anyelement, msg text) returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'ASSERTION FAILED: % (expected %, got %)', msg, expected, actual;
  end if;
  raise notice 'ok - %', msg;
end $$;

-- number of rows a query returns under the current role
create function tests.count(q text) returns bigint language plpgsql as $$
declare n bigint;
begin execute 'select count(*) from (' || q || ') t' into n; return n; end $$;

-- statement must raise (optionally matching a pattern)
create function tests.fails(stmt text, pattern text, msg text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    if pattern is not null and sqlerrm !~* pattern then
      raise exception 'ASSERTION FAILED: % (wrong error: %)', msg, sqlerrm;
    end if;
    raise notice 'ok - % [%]', msg, sqlerrm;
    return;
  end;
  raise exception 'ASSERTION FAILED: % (statement succeeded)', msg;
end $$;

-- write must either raise or change zero rows
create function tests.cannot_write(stmt text, msg text) returns void language plpgsql as $$
declare n bigint;
begin
  begin
    execute stmt;
    get diagnostics n = row_count;
  exception when others then
    raise notice 'ok - % [%]', msg, sqlerrm;
    return;
  end;
  if n > 0 then raise exception 'ASSERTION FAILED: % (% rows changed)', msg, n; end if;
  raise notice 'ok - % [0 rows]', msg;
end $$;

create function tests.like_msg(actual text, fragment text, msg text) returns void language plpgsql as $$
begin
  if actual is null or position(fragment in actual) = 0 then
    raise exception 'ASSERTION FAILED: % (got %)', msg, actual;
  end if;
  raise notice 'ok - %', msg;
end $$;

-- The migrations revoke the default PUBLIC execute right on new functions; the test helpers must stay callable.
grant execute on all functions in schema tests to public;
