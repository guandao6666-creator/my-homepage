-- ============================================================
--  社会网络 → 接入 Supabase Auth
--  在 SQL Editor 中执行一次。
--
--  背景：之前用浏览器本地 UUID 当身份，换设备就换人。
--  现在改成真实账号（邮箱 + 密码），profiles.id 存 auth.uid()。
-- ============================================================

-- 资料：只有本人能写自己的
drop policy if exists "profiles insertable" on public.profiles;
create policy "profiles insertable"
  on public.profiles for insert
  with check (
    auth.uid()::text = id
    and char_length(nickname) between 1 and 16
    and char_length(bio) <= 80
  );

drop policy if exists "profiles updatable" on public.profiles;
create policy "profiles updatable"
  on public.profiles for update
  using (auth.uid()::text = id)
  with check (
    auth.uid()::text = id
    and char_length(nickname) between 1 and 16
    and char_length(bio) <= 80
  );

-- 关注：只能以自己的身份关注别人
drop policy if exists "follows insertable" on public.follows;
create policy "follows insertable"
  on public.follows for insert
  with check (auth.uid()::text = from_id and from_id <> to_id);

drop policy if exists "follows deletable" on public.follows;
create policy "follows deletable"
  on public.follows for delete
  using (auth.uid()::text = from_id);

-- ============================================================
--  说明
--  读权限保持公开（谁都能看名单和资料），
--  写权限全部绑定 auth.uid()，匿名请求会被拒。
-- ============================================================
