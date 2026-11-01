/**
 * Supabase 反向代理。
 *
 * 起因：国内直连 *.supabase.co 经常超时或被重置，议会/访客墙会一直卡在「正在加载」。
 * 站点本身走 Cloudflare 是可以访问的，所以让数据库请求也走同一个域名：
 *   https://guandao.xin/sb/rest/v1/polls  →  https://<project>.supabase.co/rest/v1/polls
 *
 * 好处是同源，连 CORS 预检都省了。
 */

const SUPABASE_HOST = "mkcnftjhftpiofnhenjf.supabase.co";

export const onRequest = async ({ request, params }) => {
  const segments = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const incoming = new URL(request.url);

  const target = new URL(`https://${SUPABASE_HOST}/${segments.join("/")}`);
  target.search = incoming.search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");
  // 让 Supabase 看到真实的来源，否则 CORS 和重定向可能出问题
  headers.set("origin", `https://${SUPABASE_HOST}`);
  headers.set("referer", `https://${SUPABASE_HOST}/`);

  const hasBody = !["GET", "HEAD", "OPTIONS"].includes(request.method);

  const upstream = await fetch(target.toString(), {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: "follow",
  });

  const out = new Headers(upstream.headers);
  // 去掉会让浏览器二次跳走的头，也避免暴露上游域名
  out.delete("content-encoding");
  out.delete("content-length");
  out.delete("transfer-encoding");
  out.delete("connection");
  out.set("access-control-allow-origin", "*");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
};
