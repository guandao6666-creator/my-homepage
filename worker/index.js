/**
 * Cloudflare Worker 入口。
 *
 * 这里只做一件事：把 /sb/* 反向代理到 Supabase。
 * 起因是国内直连 *.supabase.co 经常挂住，页面会一直卡在「正在加载」。
 * 站点本身走 Cloudflare 能访问，所以让数据库请求也走同一个域名。
 *
 * 其余请求原样交给静态资源（env.ASSETS）。
 */

const SUPABASE_HOST = "mkcnftjhftpiofnhenjf.supabase.co";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/sb" || url.pathname.startsWith("/sb/")) {
      const rest = url.pathname.slice(3) || "/";
      const target = new URL(`https://${SUPABASE_HOST}${rest}`);
      target.search = url.search;

      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("cf-connecting-ip");
      headers.delete("cf-ipcountry");
      headers.delete("cf-ray");
      headers.delete("cf-visitor");
      headers.set("origin", `https://${SUPABASE_HOST}`);
      headers.set("referer", `https://${SUPABASE_HOST}/`);

      const hasBody = !["GET", "HEAD"].includes(request.method);

      let upstream;
      try {
        upstream = await fetch(target.toString(), {
          method: request.method,
          headers,
          body: hasBody ? request.body : undefined,
          redirect: "follow",
        });
      } catch (err) {
        return new Response(`proxy error: ${err.message}`, { status: 502 });
      }

      const out = new Headers(upstream.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      out.delete("transfer-encoding");
      out.set("access-control-allow-origin", "*");

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: out,
      });
    }

    return env.ASSETS.fetch(request);
  },
};
