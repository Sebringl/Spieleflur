self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
      return null;
    })
  );
});

self.addEventListener("push", event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: "Schocken", body: "Du bist am Zug." };
  }

  const title = data.title || "Schocken";
  const body = data.body || "Du bist am Zug.";
  const icon = data.icon || "/icon.svg";

  event.waitUntil(
    self.registration.showNotification(title, { body, icon, badge: icon })
  );
});
