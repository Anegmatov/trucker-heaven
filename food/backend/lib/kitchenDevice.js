const { AppError } = require('./http');
const { sha256, requireAdmin } = require('./auth');

function kitchenScope(req) {
  if (req.method === 'GET') return ['/device-session', '/kitchen', '/orders'].includes(req.path)
    || /^\/orders\/[^/]+$/.test(req.path);
  if (['POST', 'DELETE'].includes(req.method) && req.path === '/push/register') return true;
  return req.method === 'POST' && /^\/orders\/[^/]+\/transition$/.test(req.path)
    && ['CONFIRMED', 'PREPARING', 'READY', 'COMPLETED'].includes(req.body?.status);
}

function requireKitchenOrAdmin(database) {
  const admin = requireAdmin(database);
  return async (req, res, next) => {
    if (!req.headers.authorization) return admin(req, res, next);
    try {
      const match = /^Bearer (kdev_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization);
      if (!match) throw new AppError(401, 'DEVICE_INVALID', 'Invalid kitchen device credential.');
      const hash = sha256(match[1]);
      const result = await database.query(`SELECT d.is_active AS device_active, u.id, u.is_active,
        u.email, u.display_name FROM kitchen_devices d JOIN admin_users u ON u.id=d.admin_user_id
        WHERE d.token_hash=$1`, [hash]);
      const row = result.rows[0];
      if (!row) throw new AppError(401, 'DEVICE_NOT_ENROLLED', 'This tablet needs administrator activation.');
      if (!row.device_active || !row.is_active) throw new AppError(401, 'DEVICE_REVOKED', 'This tablet has been deactivated by an administrator.');
      if (!kitchenScope(req)) throw new AppError(403, 'KITCHEN_SCOPE_REQUIRED', 'Kitchen devices cannot perform this action.');
      req.kitchenDeviceHash = hash;
      req.admin = { id: String(row.id), email: row.email, displayName: row.display_name, role: 'STAFF' };
      next();
    } catch (error) { next(error); }
  };
}

module.exports = { kitchenScope, requireKitchenOrAdmin };
