// Service Worker: sofort aktivieren, damit Benachrichtigungen funktionieren.
self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

// Nach Aktivierung sofort Kontrolle über bestehende Tabs übernehmen.
self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

// Klick auf Push-Notification: Aktion an Clients weiterreichen und Tab fokussieren.
self.addEventListener("notificationclick", event => {
  const action = event.action;
  const data = event.notification?.data || {};
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
      if (action && data?.requestId && data?.code) {
        clients.forEach(client => {
          client.postMessage({
            type: "join_request_action",
            action,
            requestId: data.requestId,
            code: data.code
          });
        });
      }
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
      return null;
    })
  );
});

// Empfang einer Push-Notification (z.B. "du bist am Zug").
self.addEventListener("push", event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: "Schocken", body: "Du bist am Zug." };
  }

  const title = data.title || "Schocken";
  const body = data.body || "Du bist am Zug.";
  const icon = data.icon || "/icon.png";

  event.waitUntil(
    self.registration.showNotification(title, { body, icon, badge: icon })
  );
});
