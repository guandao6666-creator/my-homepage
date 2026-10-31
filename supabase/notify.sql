-- ============================================================
--  新留言即时通知
--  在 Supabase 控制台 → SQL Editor 中执行一次即可，无需部署任何服务。
--
--  原理：pg_net 扩展让 Postgres 自己发 HTTP 请求。
--  有人留言 → 触发器 → 异步 POST 到推送服务 → 手机收到。
--  异步的好处是推送失败不会影响留言本身。
--
--  支持的通道（填哪个用哪个，可同时开）：
--    1. PushPlus  → 微信接收，国内可用，免费额度够个人博客
--       https://www.pushplus.plus  注册后在「一对一推送」里拿 token
--    2. Telegram  → 即时、免费，但国内需要代理
--       找 @BotFather 建 bot 拿 token；给 bot 发条消息后访问
--       https://api.telegram.org/bot<token>/getUpdates 取 chat.id
--    3. Resend    → 邮件接收，https://resend.com 拿 API Key
-- ============================================================

-- 1) 启用 pg_net -------------------------------------------------
-- 扩展会自带 net schema，不要指定 with schema，否则对象位置会错
create extension if not exists pg_net;

-- 2) 配置表 ------------------------------------------------------
-- 只允许 service_role 访问：不建任何 RLS policy，
-- anon / authenticated 一律读不到 token。
create table if not exists public.notify_config (
  id             int primary key default 1 check (id = 1),
  enabled        boolean not null default true,
  site_url       text not null default 'https://guandao.xin',
  pushplus_token text,
  telegram_token text,
  telegram_chat  text,
  resend_key     text,
  mail_to        text,
  mail_from      text default 'onboarding@resend.dev',
  updated_at     timestamptz not null default now()
);

alter table public.notify_config enable row level security;

-- 单行配置：先插入空白行，之后用 update 填 token
insert into public.notify_config (id) values (1)
on conflict (id) do nothing;

-- 3) 推送函数 ----------------------------------------------------
create or replace function public.notify_new_comment()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, net
as $$
declare
  cfg     public.notify_config;
  title   text;
  message text;
  link    text;
begin
  -- 通知只是附加动作：整段兜底，任何异常都不能连累留言写入
  begin
    select * into cfg from public.notify_config where id = 1 and enabled = true;
    if not found then
      return new;
    end if;

    link := rtrim(cfg.site_url, '/') || '/blog/' || new.post_slug || '/';
    title := case
      when new.parent_id is null then '新留言 · ' || new.author
      else '新回复 · ' || new.author
    end;
    message := new.body || E'\n\n' || link;

    -- PushPlus：微信接收
    if cfg.pushplus_token is not null and length(cfg.pushplus_token) > 0 then
      perform net.http_post(
        url := 'https://www.pushplus.plus/send',
        body := jsonb_build_object(
          'token', cfg.pushplus_token,
          'title', title,
          'content', message,
          'template', 'txt'
        ),
        headers := '{"Content-Type": "application/json"}'::jsonb
      );
    end if;

    -- Telegram：即时消息
    if cfg.telegram_token is not null and cfg.telegram_chat is not null then
      perform net.http_post(
        url := 'https://api.telegram.org/bot' || cfg.telegram_token || '/sendMessage',
        body := jsonb_build_object(
          'chat_id', cfg.telegram_chat,
          'text', title || E'\n\n' || message,
          'disable_web_page_preview', true
        ),
        headers := '{"Content-Type": "application/json"}'::jsonb
      );
    end if;

    -- Resend：邮件
    if cfg.resend_key is not null and cfg.mail_to is not null then
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        body := jsonb_build_object(
          'from', cfg.mail_from,
          'to', cfg.mail_to,
          'subject', title,
          'text', message
        ),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || cfg.resend_key
        )
      );
    end if;
  exception when others then
    null;
  end;

  return new;
end;
$$;

-- 4) 挂上触发器 --------------------------------------------------
drop trigger if exists comments_notify on public.comments;
create trigger comments_notify
  after insert on public.comments
  for each row
  when (new.visible)
  execute function public.notify_new_comment();


-- ============================================================
--  填 token（把下面的值换成自己的，然后取消注释执行）
-- ============================================================
-- update public.notify_config set pushplus_token = '你的 pushplus token' where id = 1;
-- update public.notify_config set telegram_token = '123456:ABC...', telegram_chat = '123456789' where id = 1;
-- update public.notify_config set resend_key = 're_xxx', mail_to = 'you@example.com' where id = 1;

-- 关掉通知：update public.notify_config set enabled = false where id = 1;

-- 自测：插一条只有自己看得到的留言，确认能收到推送
-- insert into public.comments (post_slug, author, body, visible)
-- values ('first-blog', '测试', '这是一条通知自测', true);

-- 排查：看最近的推送请求和返回（注意响应表的时间列叫 created）
-- select status_code, error_msg, created
-- from net._http_response order by created desc limit 5;
