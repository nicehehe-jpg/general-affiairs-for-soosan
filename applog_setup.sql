-- ============================================================
--  총무 시스템 · 오류 로그 전용 테이블 (applog Phase 2)
--  Supabase 대시보드 → SQL Editor 에 붙여넣고 [Run] 한 번 실행.
--  · anon(비로그인)은 접근 불가, 로그인(authenticated) 사용자만 insert/select/delete
--  · 실행 후 applog.js 가 이 테이블에 오류를 기록하고, 대시보드 로그 관리가 여기서 조회함.
-- ============================================================

create table if not exists public.logs (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  ts          timestamptz,
  app         text,
  level       text default 'error',
  message     text,
  stack       text,
  url         text,
  src         text
);

create index if not exists logs_created_idx on public.logs (created_at desc);
create index if not exists logs_app_idx     on public.logs (app);

alter table public.logs enable row level security;

drop policy if exists logs_insert_auth on public.logs;
drop policy if exists logs_select_auth on public.logs;
drop policy if exists logs_delete_auth on public.logs;

create policy logs_insert_auth on public.logs for insert to authenticated with check (true);
create policy logs_select_auth on public.logs for select to authenticated using (true);
create policy logs_delete_auth on public.logs for delete to authenticated using (true);

grant usage on schema public to authenticated;
grant select, insert, delete on table public.logs to authenticated;

-- (선택) 오래된 로그 정리: 90일 초과분 삭제 — 필요 시 주기적으로 실행
-- delete from public.logs where created_at < now() - interval '90 days';
