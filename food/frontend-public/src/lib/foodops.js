const configuredApiBase = import.meta.env.VITE_FOODOPS_API_URL || '/api/v1';
const apiBase = configuredApiBase.replace(/\/$/, '');
const credentialKey = (orderNumber) => `silk-road-grill-order-credential:${orderNumber}`;
const CURRENT_ORDER_KEY = 'silk-road-grill-current-order';

export function resolveMediaUrl(imagePath) {
  if (!imagePath) return '';
  if (/^https?:\/\//i.test(imagePath)) return imagePath;
  if (!imagePath.startsWith('/')) return imagePath;
  if (/^https?:\/\//i.test(configuredApiBase)) return new URL(imagePath, configuredApiBase).href;
  return imagePath;
}

export async function foodOpsRequest(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.message || 'FoodOps is unavailable. Please try again.');
    error.code = payload?.error?.code || 'FOODOPS_REQUEST_FAILED';
    error.details = payload?.error?.details || null;
    error.status = response.status;
    throw error;
  }
  return payload;
}

export const loadPublicMenu = () => foodOpsRequest('/public/menu');
export const submitCateringRequest = (body) => foodOpsRequest('/public/catering-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export const submitOrder = (body) => foodOpsRequest('/public/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}` }, body: JSON.stringify(body) });

export function rememberOrderCredential(orderNumber, credential) {
  sessionStorage.setItem(credentialKey(orderNumber), credential);
  sessionStorage.setItem(CURRENT_ORDER_KEY, orderNumber);
}

export const currentOrderNumber = () => sessionStorage.getItem(CURRENT_ORDER_KEY);
export const lookupOrders = (fullName, phone) => foodOpsRequest('/public/orders/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fullName, phone }) });

export function loadOrder(orderNumber) {
  const credential = sessionStorage.getItem(credentialKey(orderNumber));
  if (!credential) return Promise.reject(new Error('This order status is available only in the browser where the order was placed.'));
  return foodOpsRequest(`/public/orders/${encodeURIComponent(orderNumber)}`, { headers: { 'X-Order-Access-Credential': credential } });
}
