const { logFailure } = require("../utils/safeLog");
const { moduleEnv } = require("../config/env");

const OFFICE_NAME = moduleEnv().RENTAL_OFFICE_NAME || "Trucker Heaven Rentals";
const OFFICE_PHONE = moduleEnv().RENTAL_OFFICE_PHONE || "+16154705075";
const OFFICE_ADDRESS = moduleEnv().RENTAL_OFFICE_ADDRESS || "8037 Eastgate Blvd, Mt. Juliet, TN 37122";

function createSmsService(options = {}) {
  const settings = {
    enabled: options.enabled ?? String(moduleEnv().SMS_ENABLED || "false").toLowerCase() === "true",
    accountSid: options.accountSid ?? moduleEnv().TWILIO_ACCOUNT_SID ?? "",
    authToken: options.authToken ?? moduleEnv().TWILIO_AUTH_TOKEN ?? "",
    messagingServiceSid: options.messagingServiceSid ?? moduleEnv().TWILIO_MESSAGING_SERVICE_SID ?? "",
    fromNumber: options.fromNumber ?? moduleEnv().TWILIO_FROM_NUMBER ?? "",
    timeoutMs: options.timeoutMs ?? 5000,
    fetchImpl: options.fetchImpl ?? globalThis.fetch
  };

  function isConfigured() {
    return settings.enabled && Boolean(settings.accountSid && settings.authToken && (settings.messagingServiceSid || settings.fromNumber));
  }

  async function sendSms(to, body) {
    if (!to || !body) return { status: "skipped", code: "INVALID_DESTINATION", message: "SMS delivery skipped." };
    if (!isConfigured()) {
      console.info("[sms] delivery skipped because the service is not configured.");
      return { status: "skipped", code: "PROVIDER_NOT_CONFIGURED", message: "SMS delivery is not configured." };
    }

    const payload = new URLSearchParams();
    payload.set("To", to);
    payload.set("Body", body);
    if (settings.messagingServiceSid) payload.set("MessagingServiceSid", settings.messagingServiceSid);
    else payload.set("From", settings.fromNumber);

    const controller = new AbortController();
    let rejectTimeout;
    const timeoutFailure = new Promise((_resolve, reject) => { rejectTimeout = reject; });
    const timeout = setTimeout(() => {
      controller.abort();
      const error = new Error("SMS provider timeout");
      error.code = "SMS_TIMEOUT";
      rejectTimeout(error);
    }, settings.timeoutMs);
    const request = Promise.resolve().then(() => settings.fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${settings.accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${settings.accountSid}:${settings.authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: payload.toString(),
        signal: controller.signal
      }
    ));
    request.catch(() => undefined);
    try {
      const response = await Promise.race([request, timeoutFailure]);
      if (response.ok) {
        const payload = await response.json().catch(() => ({}));
        return { status: "sent", providerMessageId: typeof payload.sid === "string" ? payload.sid.slice(0, 160) : null, message: "SMS accepted." };
      }
      return { status: "failed", code: response.status >= 500 ? "PROVIDER_TEMPORARY_FAILURE" : "PROVIDER_REJECTED", retryable: response.status >= 500, message: "SMS delivery request failed." };
    } catch (error) {
      logFailure("sms.delivery", error);
      // Once the request has been handed to fetch, a timeout or transport error may
      // mean the provider accepted it before the response was lost. The outbox worker
      // must not blindly resend this ambiguous outcome.
      return { status: "failed", code: "DELIVERY_OUTCOME_UNKNOWN", ambiguous: true, message: controller.signal.aborted ? "SMS delivery timed out." : "SMS delivery outcome is unknown." };
    } finally {
      clearTimeout(timeout);
    }
  }

  function formatDateTime(value) {
    if (!value) return "";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "";
    return parsed.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  }

  function reservationVehicleLabel(reservation) {
    return [reservation.year ?? reservation.Year, reservation.make ?? reservation.Make, reservation.model ?? reservation.Model]
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  function sendOfficeReservationAlert(reservation) {
    const body = `New rental request: ${reservationVehicleLabel(reservation)}, `
      + `${formatDateTime(reservation.pickupat ?? reservation.PickupAt)} to ${formatDateTime(reservation.returnat ?? reservation.ReturnAt)}, `
      + `${reservation.customername ?? reservation.CustomerName}, ${reservation.customerphone ?? reservation.CustomerPhone ?? reservation.customeremail ?? reservation.CustomerEmail}. `
      + "Check admin dashboard.";
    return sendSms(OFFICE_PHONE, body);
  }

  function sendCustomerRequestReceived(reservation) {
    const body = `${OFFICE_NAME} received your reservation request for ${reservationVehicleLabel(reservation)}. `
      + "Our office will confirm availability shortly.";
    return sendSms(reservation.customerphone ?? reservation.CustomerPhone, body);
  }

  function sendCustomerApproved(reservation) {
    const body = `Confirmed: your ${OFFICE_NAME} reservation for ${reservationVehicleLabel(reservation)} is approved. `
      + `Pickup: ${formatDateTime(reservation.pickupat ?? reservation.PickupAt)} at ${OFFICE_ADDRESS}.`;
    return sendSms(reservation.customerphone ?? reservation.CustomerPhone, body);
  }

  function sendCustomerDeclined(reservation) {
    const body = `Sorry, ${reservationVehicleLabel(reservation)} is not available for the requested time. `
      + `Please call ${OFFICE_PHONE} to choose another option.`;
    return sendSms(reservation.customerphone ?? reservation.CustomerPhone, body);
  }

  return { sendSms, sendOfficeReservationAlert, sendCustomerRequestReceived, sendCustomerApproved, sendCustomerDeclined };
}

let activeService = createSmsService();

function configureSmsService(options) {
  activeService = createSmsService(options);
  return activeService;
}

module.exports = {
  OFFICE_NAME,
  OFFICE_PHONE,
  OFFICE_ADDRESS,
  createSmsService,
  configureSmsService,
  sendSms: (...args) => activeService.sendSms(...args),
  sendOfficeReservationAlert: (...args) => activeService.sendOfficeReservationAlert(...args),
  sendCustomerRequestReceived: (...args) => activeService.sendCustomerRequestReceived(...args),
  sendCustomerApproved: (...args) => activeService.sendCustomerApproved(...args),
  sendCustomerDeclined: (...args) => activeService.sendCustomerDeclined(...args)
};
