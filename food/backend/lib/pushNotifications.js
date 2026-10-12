const { GoogleAuth } = require("google-auth-library");

const INVALID_TOKEN_STATUSES = new Set(["INVALID_ARGUMENT", "NOT_FOUND", "UNREGISTERED"]);

function newOrderMessage({ locale }, { orderNumber, ticketNumber, itemCount }) {
  const title = locale === "ru" ? "SILK ROAD — НОВЫЙ ЗАКАЗ" : "SILK ROAD — NEW ORDER";
  const body = locale === "ru"
    ? "Поступил новый заказ. Нажмите, чтобы открыть кухню."
    : "A new order has been received. Tap to open Kitchen.";
  return {
    notification: { title, body },
    data: {
      eventType: "order.created",
      orderNumber: String(orderNumber),
      ticketNumber: String(ticketNumber),
      itemCount: String(itemCount),
      title,
      body
    },
    android: {
      priority: "HIGH",
      notification: {
        channelId: "foodops_order_alerts_v2",
        sound: "default",
        notificationPriority: "PRIORITY_HIGH",
        proxy: "ALLOW",
        visibility: "PRIVATE",
        defaultVibrateTimings: true
      }
    }
  };
}

function newOrderAlarmMessage({ locale }, { orderNumber, ticketNumber, itemCount }) {
  const title = locale === "ru" ? "SILK ROAD — НОВЫЙ ЗАКАЗ" : "SILK ROAD — NEW ORDER";
  const body = locale === "ru"
    ? "Поступил новый заказ. Нажмите, чтобы открыть кухню."
    : "A new order has been received. Tap to open Kitchen.";
  return {
    data: {
      eventType: "order.created",
      orderNumber: String(orderNumber),
      ticketNumber: String(ticketNumber),
      itemCount: String(itemCount),
      title,
      body
    },
    android: { priority: "HIGH" }
  };
}

function createPushNotifications(database, config) {
  const credentials = config.firebaseServiceAccount;
  const configured = Boolean(credentials);
  const projectId = credentials?.project_id || "";
  const auth = configured ? new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/firebase.messaging"]
  }) : null;

  async function enabledTokens() {
    const result = await database.query(`SELECT fcm_token, locale FROM admin_push_subscriptions
      WHERE enabled = TRUE AND platform = 'ANDROID'
        AND (kitchen_device_hash IS NULL OR EXISTS (
          SELECT 1 FROM kitchen_devices d JOIN admin_users u ON u.id=d.admin_user_id
          WHERE d.token_hash=kitchen_device_hash AND d.is_active=TRUE AND u.is_active=TRUE
        )) ORDER BY id`);
    return result.rows.map((row) => ({ token: row.fcm_token, locale: row.locale === "ru" ? "ru" : "en" }));
  }

  async function disableInvalid(tokens) {
    if (!tokens.length) return;
    await database.query(`UPDATE admin_push_subscriptions
      SET enabled = FALSE, updated_at = NOW()
      WHERE fcm_token = ANY($1::text[])`, [tokens]);
  }

  async function send(messageForSubscription) {
    if (!auth) return { configured: false, delivered: 0 };
    const subscriptions = await enabledTokens();
    if (!subscriptions.length) return { configured: true, delivered: 0 };
    const client = await auth.getClient();
    const access = await client.getAccessToken();
    const invalid = [];
    let delivered = 0;
    for (let offset = 0; offset < subscriptions.length; offset += 20) {
      const batch = subscriptions.slice(offset, offset + 20);
      const results = await Promise.all(batch.map(async (subscription) => {
        const message = typeof messageForSubscription === "function"
          ? messageForSubscription(subscription)
          : messageForSubscription;
        const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
          method: "POST",
          headers: { Authorization: `Bearer ${access.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ message: { ...message, token: subscription.token } })
        });
        if (response.ok) return true;
        const body = await response.json().catch(() => ({}));
        const fcmCode = body.error?.details?.find((entry) => entry.errorCode)?.errorCode;
        if (INVALID_TOKEN_STATUSES.has(fcmCode || body.error?.status)) invalid.push(subscription.token);
        return false;
      }));
      delivered += results.filter(Boolean).length;
    }
    await disableInvalid(invalid);
    return { configured: true, delivered };
  }

  async function sendNewOrder({ orderNumber, ticketNumber, itemCount }) {
    const order = { orderNumber, ticketNumber, itemCount };
    const result = await send((subscription) => newOrderMessage(subscription, order));
    if (result.configured) await send((subscription) => newOrderAlarmMessage(subscription, order));
    return result;
  }

  function sendStatusChanged({ orderNumber, status }) {
    return send({
      data: {
        eventType: "order.status_changed",
        orderNumber: String(orderNumber),
        status: String(status)
      },
      android: { priority: "HIGH" }
    });
  }

  return Object.freeze({ configured, sendNewOrder, sendStatusChanged });
}

module.exports = { createPushNotifications, INVALID_TOKEN_STATUSES, newOrderMessage, newOrderAlarmMessage };
