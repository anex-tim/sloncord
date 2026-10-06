/* global self */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch {
    data = { title: "Sloncord", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Sloncord";
  const options = {
    body: data.body || "",
    data: data.data || {},
    renotify: true,
    silent: false,
    vibrate: [40, 70, 40],
    tag: data.data?.kind === "dm" ? `dm:${data.data?.channelId || ""}` : `ch:${data.data?.channelId || ""}`
  };

  if (data.data?.kind === "call") {
    options.tag = `call:${data.data?.callId || data.data?.channelId || ""}`;
    options.renotify = true;
    options.actions = [
      { action: "accept", title: "Принять" },
      { action: "decline", title: "Отклонить" }
    ];
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification?.data || {};
  const action = event.action || "";
  let url = data.url || "/";
  if (data.kind === "call") {
    const ch = data.channelId || "";
    const callId = data.callId || "";
    const fromUserId = data.fromUserId || "";
    const fromNickname = data.fromNickname || "";
    if (action === "accept") url = `/?open=dm:${encodeURIComponent(ch)}&call=accept&callId=${encodeURIComponent(callId)}&fromUserId=${encodeURIComponent(fromUserId)}&fromNickname=${encodeURIComponent(fromNickname)}`;
    else if (action === "decline") url = `/?open=dm:${encodeURIComponent(ch)}&call=decline&callId=${encodeURIComponent(callId)}&fromUserId=${encodeURIComponent(fromUserId)}&fromNickname=${encodeURIComponent(fromNickname)}`;
    else url = `/?open=dm:${encodeURIComponent(ch)}&call=incoming&callId=${encodeURIComponent(callId)}&fromUserId=${encodeURIComponent(fromUserId)}&fromNickname=${encodeURIComponent(fromNickname)}`;
  }
  event.waitUntil((async () => {
    try {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of all) {
        if ("focus" in c) {
          await c.focus();
          if ("navigate" in c && url) {
            try { await c.navigate(url); } catch { /* ignore */ }
          }
          return;
        }
      }
    } catch {
      // ignore
    }
    await self.clients.openWindow(url);
  })());
});
