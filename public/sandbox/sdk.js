/*
 * Guandao Plugin SDK · 宿主内预置脚本（v1）
 *
 * 这段代码运行在插件的双重沙箱 iframe 里，不接触宿主 DOM / Cookie / Storage。
 * 所有能力都通过 postMessage RPC 发回宿主，由宿主按权限表逐条校验。
 *
 * 约定：
 *   - 每个方法都返回 Promise；失败时 reject 一个带 code 的 Error；
 *   - 单个请求 payload 上限 24 KB，宿主 8 秒超时（这里 12 秒兜底）；
 *   - 不存在「静默降级」：没有权限就抛 PERMISSION_DENIED。
 */
(function () {
  "use strict";

  var CFG = window.__GUANDAO_PLUGIN__ || {};
  var CHANNEL = "guandao.plugin";
  var MAX_PAYLOAD = 24 * 1024;
  var TIMEOUT = 12000;
  var pending = new Map();
  var handlers = Object.create(null);
  var seq = 0;

  function GuandaoError(code, message) {
    var error = new Error(message || code);
    error.name = "GuandaoError";
    error.code = code || "UNKNOWN";
    return error;
  }

  function emit(event, payload) {
    var list = handlers[event];
    if (!list) return;
    for (var i = 0; i < list.length; i += 1) {
      try {
        list[i](payload);
      } catch (error) {
        if (window.console) console.error("[guandao] listener error:", error);
      }
    }
  }

  function on(event, callback) {
    if (typeof callback !== "function") return function () {};
    var name = String(event || "");
    if (!handlers[name]) handlers[name] = [];
    handlers[name].push(callback);
    return function () {
      handlers[name] = handlers[name].filter(function (fn) {
        return fn !== callback;
      });
    };
  }

  function call(method, payload) {
    return new Promise(function (resolve, reject) {
      var requestId = "r" + (++seq).toString(36) + Math.random().toString(36).slice(2, 8);
      var encoded = "";
      try {
        encoded = payload === undefined ? "" : JSON.stringify(payload);
      } catch (error) {
        reject(GuandaoError("INVALID_PAYLOAD", "参数无法序列化"));
        return;
      }
      if (encoded && encoded.length > MAX_PAYLOAD) {
        reject(GuandaoError("PAYLOAD_TOO_LARGE", "单次请求参数超过 24 KB"));
        return;
      }

      var timer = setTimeout(function () {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        reject(GuandaoError("TIMEOUT", "宿主没有在 12 秒内响应"));
      }, TIMEOUT);

      pending.set(requestId, { resolve: resolve, reject: reject, timer: timer });

      try {
        window.parent.postMessage(
          {
            channel: CHANNEL,
            kind: "RPC",
            requestId: requestId,
            method: method,
            payload: payload,
          },
          "*",
        );
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(GuandaoError("CHANNEL_CLOSED", "插件上下文已失效"));
      }
    });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.channel !== CHANNEL) return;

    if (data.kind === "RESULT") {
      var entry = pending.get(String(data.requestId || ""));
      if (!entry) return;
      pending.delete(data.requestId);
      clearTimeout(entry.timer);
      if (data.ok) entry.resolve(data.result);
      else {
        var err = data.error || {};
        entry.reject(GuandaoError(err.code || "FAILED", err.message || "调用失败"));
      }
      return;
    }

    if (data.kind === "EVENT") {
      emit(String(data.event || ""), data.payload);
    }
  });

  function noop() {}

  var storage = {
    get: function (key) {
      return call("storage.get", { key: String(key) });
    },
    set: function (key, value) {
      return call("storage.set", { key: String(key), value: value });
    },
    delete: function (key) {
      return call("storage.delete", { key: String(key) });
    },
    keys: function () {
      return call("storage.keys");
    },
    clear: function () {
      return call("storage.clear");
    },
  };

  var api = {
    sdkVersion: 1,
    pluginId: CFG.pluginId || "",
    granted: Array.isArray(CFG.granted) ? CFG.granted.slice() : [],

    has: function (permission) {
      return api.granted.indexOf(String(permission)) >= 0;
    },

    context: function () {
      return call("app.context").then(function (value) {
        return value;
      });
    },

    ui: {
      toast: function (text) {
        return call("ui.toast", { text: String(text).slice(0, 200) });
      },
      notify: function (options) {
        var input = options || {};
        return call("ui.notify", {
          title: String(input.title || "插件通知").slice(0, 80),
          body: String(input.body || "").slice(0, 400),
          level: ["info", "success", "warning", "error"].indexOf(input.level) >= 0 ? input.level : "info",
        });
      },
      dialog: function (options) {
        var input = options || {};
        return call("ui.dialog", {
          title: String(input.title || "确认").slice(0, 80),
          message: String(input.message || "").slice(0, 600),
          actions: Array.isArray(input.actions)
            ? input.actions.slice(0, 3).map(function (item) {
                return { label: String(item.label || "确定").slice(0, 24), value: String(item.value || "").slice(0, 24) };
              })
            : [{ label: "确定", value: "ok" }, { label: "取消", value: "cancel" }],
        });
      },
      openApp: function (appId) {
        return call("ui.openApp", { appId: String(appId) });
      },
      setTitle: function (title) {
        return call("ui.setTitle", { title: String(title).slice(0, 60) });
      },
      resize: function (size) {
        var input = size || {};
        return call("ui.resize", { width: Number(input.width) || 0, height: Number(input.height) || 0 });
      },
      close: function () {
        return call("ui.close");
      },
      theme: function () {
        return call("theme.get");
      },
    },

    app: {
      context: function () {
        return call("app.context");
      },
      close: function () {
        return call("ui.close");
      },
      setTitle: function (title) {
        return call("ui.setTitle", { title: String(title).slice(0, 60) });
      },
      resize: function (size) {
        return call("ui.resize", { width: Number(size && size.width) || 0, height: Number(size && size.height) || 0 });
      },
      openApp: function (appId) {
        return call("ui.openApp", { appId: String(appId) });
      },
    },

    widget: {
      setEnabled: function (enabled) {
        return call("widget.setEnabled", { enabled: Boolean(enabled) });
      },
      setTitle: function (title) {
        return call("widget.setTitle", { title: String(title).slice(0, 40) });
      },
    },

    notifications: {
      show: function (options) {
        var input = options || {};
        return call("ui.notify", {
          title: String(input.title || "插件通知").slice(0, 80),
          body: String(input.body || "").slice(0, 400),
          level: ["info", "success", "warning", "error"].indexOf(input.level) >= 0 ? input.level : "info",
        });
      },
      success: function (title, body) {
        return call("ui.notify", { title: String(title).slice(0, 80), body: String(body || "").slice(0, 400), level: "success" });
      },
      warning: function (title, body) {
        return call("ui.notify", { title: String(title).slice(0, 80), body: String(body || "").slice(0, 400), level: "warning" });
      },
      error: function (title, body) {
        return call("ui.notify", { title: String(title).slice(0, 80), body: String(body || "").slice(0, 400), level: "error" });
      },
    },

    storage: storage,

    files: {
      pick: function (options) {
        var input = options || {};
        return call("files.pick", {
          accept: String(input.accept || "").slice(0, 120),
          multiple: Boolean(input.multiple),
        });
      },
      read: function (token) {
        return call("files.read", { token: String(token || "") });
      },
    },

    theme: {
      get: function () {
        return call("theme.get");
      },
      apply: function () {
        return call("theme.apply");
      },
    },

    commands: {
      register: function (list) {
        var items = Array.isArray(list) ? list.slice(0, 8) : [];
        return call("commands.register", {
          commands: items.map(function (item) {
            return {
              command: String(item.command || "").slice(0, 48),
              title: String(item.title || "").slice(0, 40),
              description: String(item.description || "").slice(0, 80),
            };
          }),
        });
      },
      onInvoke: function (callback) {
        return on("command", callback);
      },
    },

    calendar: {
      readSelected: function () {
        return call("calendar.readSelected");
      },
      createEvent: function (event) {
        var input = event || {};
        return call("calendar.createEvent", {
          title: String(input.title || "").slice(0, 80),
          date: String(input.date || "").slice(0, 10),
          time: String(input.time || "09:00").slice(0, 5),
          note: String(input.note || "").slice(0, 400),
        });
      },
    },

    notes: {
      readSelected: function () {
        return call("notes.readSelected");
      },
      create: function (note) {
        var input = note || {};
        return call("notes.create", {
          title: String(input.title || "").slice(0, 80),
          body: String(input.body || "").slice(0, 20000),
          tags: Array.isArray(input.tags) ? input.tags.slice(0, 6).map(function (tag) { return String(tag).slice(0, 16); }) : [],
        });
      },
    },

    network: {
      fetch: function (url, options) {
        var input = options || {};
        return call("network.fetch", {
          url: String(url || "").slice(0, 1000),
          method: String(input.method || "GET").toUpperCase(),
          headers: input.headers && typeof input.headers === "object" ? input.headers : {},
          body: input.body === undefined ? "" : String(input.body).slice(0, 16000),
        });
      },
    },

    device: {
      info: function () {
        return Promise.resolve({
          platform: navigator.platform || "unknown",
          language: navigator.language || "zh-CN",
          online: navigator.onLine !== false,
          width: window.innerWidth,
          height: window.innerHeight,
          pixelRatio: window.devicePixelRatio || 1,
          reducedMotion: Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches),
        });
      },
    },

    lifecycle: {
      ready: function () {
        return Promise.resolve({ ok: true });
      },
      on: on,
      reportError: function (error) {
        return call("lifecycle.error", {
          message: String((error && error.message) || error || "未知错误").slice(0, 300),
        }).catch(noop);
      },
    },
  };

  // 旧命名：guandao.app.lifecycle 也能拿到同一套事件
  api.app.lifecycle = api.lifecycle;
  api.notify = api.notifications.show;

  try {
    Object.defineProperty(window, "guandao", { value: api, writable: false, configurable: false });
  } catch (error) {
    window.guandao = api;
  }

  // 让插件在首个宏任务之后拿到 ready，此时监听器已经注册完毕
  setTimeout(function () {
    emit("ready", { pluginId: api.pluginId, granted: api.granted });
    emit("theme-change", CFG.theme || {});
  }, 0);
})();
