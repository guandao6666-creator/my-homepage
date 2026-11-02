-- ============================================================
--  树洞 / 议会 → 绑定账号
--  在 SQL Editor 中执行一次。
--
--  议会：投票人不再是浏览器 UUID，而是 auth.uid()。
--  树洞：发言需要登录，数据库记 author_id，
--        但页面上仍显示随机昵称，保护发言者。
-- ============================================================

-- 1) 加字段 ----------------------------------------------------
alter table public.holes add column if not exists author_id text;
alter table public.hole_replies add column if not exists author_id text;

create index if not exists holes_author_idx on public.holes (author_id);

-- 2) 议会：只认登录身份投票 ------------------------------------
drop policy if exists "votes insertable by anon" on public.votes;
drop policy if exists "votes insertable" on public.votes;
create policy "votes insertable"
  on public.votes for insert
  with check (
    auth.uid()::text = voter
    and option_index >= 0
  );

-- 投票记录本身不再公开可读（避免看到别人投了啥），
-- 但聚合票数仍需要读，所以保持 readable，只是不再暴露 voter。
-- （前端只 select option_index，不查 voter）

-- 3) 树洞：发帖和回应都要登录 --------------------------------
drop policy if exists "holes insertable" on public.holes;
create policy "holes insertable"
  on public.holes for insert
  with check (
    auth.uid()::text = author_id
    and char_length(content) between 1 and 500
    and char_length(nick) between 1 and 24
  );

drop policy if exists "replies insertable" on public.hole_replies;
create policy "replies insertable"
  on public.hole_replies for insert
  with check (
    auth.uid()::text = author_id
    and char_length(content) between 1 and 300
    and char_length(nick) between 1 and 24
  );

-- ============================================================
--  说明
--  读仍然公开（谁都能看树洞和票数），
--  写全部要求登录，且 identity 必须与 token 一致。
-- ============================================================
