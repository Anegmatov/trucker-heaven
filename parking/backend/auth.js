const bcrypt = require('bcrypt');
const pool = require('./db');
const config = require('./config');
const { apiError, digest, token } = require('./utils');

const roles = { OWNER: 2, STAFF: 1 };
const cookieName = config.cookie.name;

const rolePermissions = Object.freeze({
  STAFF: Object.freeze([
    'reservation.read',
    'reservation.create',
    'reservation.update',
    'reservation.document.manage',
    'reservation.payment_link'
  ]),
  OWNER: Object.freeze([
    'reservation.read',
    'reservation.create',
    'reservation.update',
    'reservation.document.manage',
    'reservation.payment_link',
    'reservation.price_override',
    'reservation.global_pricing.manage',
    'reservation.demo_bypass'
  ])
});

function permissionsFor(role) { return [...(rolePermissions[role] || [])]; }
function userView(row) {
  return {
    id: Number(row.id), username: row.username, displayName: row.display_name || '',
    email: row.email || null, role: row.role, permissions: permissionsFor(row.role)
  };
}

function settings() {
  return { httpOnly: true, secure: config.cookie.secure, sameSite: config.cookie.sameSite, path: '/', maxAge: config.cookie.ttlSeconds * 1000 };
}

async function createSession(client, user) {
  const raw = token();
  const csrf = token(24);
  const expires = new Date(Date.now() + config.cookie.ttlSeconds * 1000);
  await client.query('INSERT INTO parking_admin_sessions(admin_user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,$4)',
    [user.id, digest(`${raw}:${config.cookie.tokenPepper}`), digest(csrf), expires]);
  return { raw, csrf };
}

async function requireAdmin(req, _res, next) {
  try {
    const raw = req.cookies?.[cookieName];
    if (!raw) throw apiError('AUTHENTICATION_REQUIRED', 'Sign in is required', 401);
    const result = await pool.query(`SELECT s.id session_id,s.csrf_hash,u.id,u.username,u.display_name,u.email,u.role
      FROM parking_admin_sessions s JOIN parking_admin_users u ON u.id=s.admin_user_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active`, [digest(`${raw}:${config.cookie.tokenPepper}`)]);
    if (!result.rowCount) throw apiError('AUTHENTICATION_REQUIRED', 'Your session has expired', 401);
    req.admin = result.rows[0];
    req.admin.permissions = permissionsFor(req.admin.role);
    await pool.query('UPDATE parking_admin_sessions SET last_seen_at=now() WHERE id=$1', [req.admin.session_id]);
    next();
  } catch (error) { next(error); }
}

function csrf(req, _res, next) {
  const value = req.get('x-csrf-token');
  if (!value || digest(value) !== req.admin.csrf_hash) return next(apiError('CSRF_REJECTED', 'A valid CSRF token is required', 403));
  next();
}

function permit(minimum) {
  return (req, _res, next) => roles[req.admin.role] >= roles[minimum]
    ? next()
    : next(apiError('PERMISSION_DENIED', 'You do not have permission for this action', 403));
}

async function login(username, password, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const normalizedUsername = String(username || '').trim().toLowerCase();
    const row = (await client.query('SELECT * FROM parking_admin_users WHERE username=$1 FOR UPDATE', [normalizedUsername])).rows[0];
    const invalid = !row || !row.active || (row.locked_until && new Date(row.locked_until) > new Date())
      || !(await bcrypt.compare(String(password || ''), row.password_hash));

    if (invalid) {
      if (row) {
        await client.query(`UPDATE parking_admin_users
          SET failed_login_count=failed_login_count+1,
              locked_until=CASE WHEN failed_login_count+1 >= $2
                THEN GREATEST(COALESCE(locked_until, '-infinity'::timestamptz), now()+($3 * interval '1 second'))
                ELSE locked_until END
          WHERE id=$1
          RETURNING failed_login_count,locked_until`, [row.id, config.adminLockout.threshold, config.adminLockout.seconds]);
      }
      await client.query('COMMIT');
      throw apiError('INVALID_CREDENTIALS', 'Invalid username or password', 401);
    }

    await client.query('UPDATE parking_admin_users SET failed_login_count=0,locked_until=NULL,last_login_at=now(),updated_at=now() WHERE id=$1', [row.id]);
    const session = await createSession(client, row);
    await client.query('COMMIT');
    res.cookie(cookieName, session.raw, settings());
    return { csrfToken: session.csrf, user: userView(row) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* The transaction may already be committed. */ }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { cookieName, settings, createSession, requireAdmin, csrf, permit, permissionsFor, userView, login };
