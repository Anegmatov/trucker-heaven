const crypto = require('crypto');
const pool = require('../db');
const config = require('../config');
const notifications = require('./customerNotifications');
const { apiError, token, digest } = require('../utils');
const { normalizeIdentifier, maskIdentifier, activateCustomerFromBooking } = require('./customerIdentity');

const cookieName = config.customerAuth.cookieName;

function hmac(value) {
  return crypto.createHmac('sha256', config.customerAuth.otpPepper).update(String(value)).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requestFingerprint(req) {
  return {
    ipHash: hmac(`ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`),
    userAgentHash: hmac(`ua:${String(req.get?.('user-agent') || '').slice(0, 500)}`)
  };
}

function cookieSettings() {
  return {
    httpOnly: true,
    secure: config.customerAuth.cookieSecure,
    sameSite: config.customerAuth.cookieSameSite,
    path: '/',
    maxAge: config.customerAuth.sessionTtlSeconds * 1000
  };
}

function customerView(row) {
  return {
    id: row.public_id,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.normalized_phone,
    email: row.normalized_email,
    phoneVerified: Boolean(row.phone_verified_at),
    emailVerified: Boolean(row.email_verified_at),
    status: row.status
  };
}

function sixDigitCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function requestCode(req, identifierOverride = null, { suppressDelivery = false } = {}) {
  const identity = normalizeIdentifier(identifierOverride == null ? req.body?.identifier : identifierOverride);
  if (!notifications.configured(identity.channel)) {
    throw apiError('AUTH_DELIVERY_NOT_CONFIGURED', identity.channel === 'SMS'
      ? 'Text-message sign-in is temporarily unavailable. Try email or contact parking support.'
      : 'Email sign-in is temporarily unavailable. Try phone or contact parking support.', 503);
  }
  const identifierHash = hmac(`identifier:${identity.channel}:${identity.normalized}`);
  const fingerprint = requestFingerprint(req);
  const publicId = `otp_${token(24)}`;
  const code = sixDigitCode();
  const expiresAt = new Date(Date.now() + config.customerAuth.otpTtlSeconds * 1000).toISOString();
  const client = await pool.connect();
  let customer = null;
  try {
    await client.query('BEGIN');
    const recent = await client.query(`SELECT count(*)::int count FROM parking_customer_auth_challenges
      WHERE identifier_hash=$1 AND created_at>now()-($2 * interval '1 second')`,
    [identifierHash, config.customerAuth.requestWindowSeconds]);
    if (Number(recent.rows[0].count) >= config.customerAuth.requestsPerIdentifier) {
      throw apiError('AUTH_REQUEST_RATE_LIMITED', 'Too many sign-in codes were requested. Try again later.', 429);
    }
    const field = identity.channel === 'SMS' ? 'normalized_phone' : 'normalized_email';
    customer = suppressDelivery ? null : (await client.query(`SELECT * FROM parking_customers WHERE ${field}=$1 AND status<>'SUSPENDED'`,
      [identity.normalized])).rows[0] || null;
    await client.query(`UPDATE parking_customer_auth_challenges SET invalidated_at=now()
      WHERE identifier_hash=$1 AND consumed_at IS NULL AND invalidated_at IS NULL`, [identifierHash]);
    await client.query(`INSERT INTO parking_customer_auth_challenges(
        public_id,customer_id,channel,identifier_hash,masked_destination,code_hash,
        attempts_remaining,expires_at,delivery_status,requester_ip_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
      publicId, customer?.id || null, identity.channel, identifierHash, maskIdentifier(identity),
      hmac(`code:${publicId}:${code}`), config.customerAuth.otpAttempts, expiresAt,
      customer ? 'PENDING' : 'SUPPRESSED', fingerprint.ipHash
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }

  if (customer) {
    try {
      await notifications.sendLoginCode({
        channel: identity.channel,
        destination: identity.normalized,
        code,
        expiresMinutes: Math.ceil(config.customerAuth.otpTtlSeconds / 60)
      });
      await pool.query(`UPDATE parking_customer_auth_challenges SET delivery_status='SENT' WHERE public_id=$1`, [publicId]);
    } catch (error) {
      await pool.query(`UPDATE parking_customer_auth_challenges SET delivery_status='FAILED',invalidated_at=now() WHERE public_id=$1`, [publicId]);
      // Do not reveal whether a matching account was the delivery target.
    }
  }
  return {
    challengeId: publicId,
    destination: maskIdentifier(identity),
    expiresInSeconds: config.customerAuth.otpTtlSeconds,
    message: 'If the information is eligible for My Parking, a one-time sign-in code will arrive shortly.'
  };
}

async function createSession(client, customer, req) {
  const raw = token(32);
  const csrfToken = token(24);
  const now = Date.now();
  const absolute = now + config.customerAuth.sessionTtlSeconds * 1000;
  const idle = Math.min(absolute, now + config.customerAuth.idleTtlSeconds * 1000);
  const fingerprint = requestFingerprint(req);
  await client.query(`INSERT INTO parking_customer_sessions(
      customer_id,token_hash,csrf_hash,expires_at,idle_expires_at,requester_ip_hash,user_agent_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [
    customer.id, hmac(`session:${raw}`), digest(csrfToken), new Date(absolute), new Date(idle),
    fingerprint.ipHash, fingerprint.userAgentHash
  ]);
  return { raw, csrfToken };
}

async function verifyCode(req, res) {
  const challengeId = String(req.body?.challengeId || '').trim();
  const code = String(req.body?.code || '').trim();
  if (!/^otp_[A-Za-z0-9_-]{24,80}$/.test(challengeId) || !/^\d{6}$/.test(code)) {
    throw apiError('AUTH_CODE_INVALID', 'The sign-in code is invalid or expired.', 401);
  }
  const client = await pool.connect();
  let outcome;
  try {
    await client.query('BEGIN');
    const challenge = (await client.query(`SELECT * FROM parking_customer_auth_challenges
      WHERE public_id=$1 FOR UPDATE`, [challengeId])).rows[0];
    const unusable = !challenge || challenge.consumed_at || challenge.invalidated_at
      || new Date(challenge.expires_at).getTime() <= Date.now() || challenge.attempts_remaining <= 0;
    if (unusable) {
      await client.query('COMMIT');
      outcome = { error: apiError('AUTH_CODE_INVALID', 'The sign-in code is invalid or expired.', 401) };
    } else if (!safeEqual(challenge.code_hash, hmac(`code:${challengeId}:${code}`)) || !challenge.customer_id) {
      await client.query(`UPDATE parking_customer_auth_challenges SET attempts_remaining=GREATEST(attempts_remaining-1,0),
        invalidated_at=CASE WHEN attempts_remaining<=1 THEN now() ELSE invalidated_at END WHERE id=$1`, [challenge.id]);
      await client.query('COMMIT');
      outcome = { error: apiError('AUTH_CODE_INVALID', 'The sign-in code is invalid or expired.', 401) };
    } else {
      const customer = (await client.query(`SELECT * FROM parking_customers
        WHERE id=$1 AND status<>'SUSPENDED' FOR UPDATE`, [challenge.customer_id])).rows[0];
      if (!customer) throw apiError('AUTH_CODE_INVALID', 'The sign-in code is invalid or expired.', 401);
      await client.query(`UPDATE parking_customer_auth_challenges SET consumed_at=now(),attempts_remaining=0 WHERE id=$1`, [challenge.id]);
      const verifiedField = challenge.channel === 'SMS' ? 'phone_verified_at' : 'email_verified_at';
      let verified = (await client.query(`UPDATE parking_customers SET ${verifiedField}=COALESCE(${verifiedField},now())
        WHERE id=$1 RETURNING *`, [customer.id])).rows[0];
      const eligibleBooking = (await client.query(`SELECT booking.*,category.code category_code
        FROM parking_bookings booking
        JOIN parking_categories category ON category.id=booking.category_id
        WHERE booking.customer_id=$1 AND (
          booking.payment_status IN ('PAID','DEMO_BYPASSED') OR booking.payment_confirmed_at IS NOT NULL OR
          (booking.payment_status='NOT_REQUIRED' AND booking.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT','COMPLETED'))
        ) ORDER BY booking.arrival_at DESC,booking.id DESC LIMIT 1 FOR UPDATE OF booking`, [customer.id])).rows[0] || null;
      if (customer.status === 'PENDING' && !eligibleBooking) {
        await client.query('COMMIT');
        outcome = { error: apiError('CUSTOMER_ACCOUNT_NOT_ACTIVE',
          'My Parking becomes available after a verified payment or a confirmed in-person parking record.', 403) };
      } else {
        if (eligibleBooking) verified = await activateCustomerFromBooking(client, eligibleBooking) || verified;
        const session = await createSession(client, verified, req);
        await client.query('COMMIT');
        outcome = { customer: verified, session };
      }
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
  if (outcome.error) throw outcome.error;
  res.cookie(cookieName, outcome.session.raw, cookieSettings());
  return { customer: customerView(outcome.customer), csrfToken: outcome.session.csrfToken };
}

async function customerFromRequest(req, client = pool, { touch = true } = {}) {
  const raw = req.cookies?.[cookieName];
  if (!raw) return null;
  const result = await client.query(`SELECT session.id session_id,session.csrf_hash,session.expires_at,
      session.idle_expires_at,customer.*
    FROM parking_customer_sessions session
    JOIN parking_customers customer ON customer.id=session.customer_id
    WHERE session.token_hash=$1 AND session.revoked_at IS NULL
      AND session.expires_at>now() AND session.idle_expires_at>now() AND customer.status<>'SUSPENDED'`,
  [hmac(`session:${raw}`)]);
  const customer = result.rows[0] || null;
  if (customer && touch) {
    await client.query(`UPDATE parking_customer_sessions SET last_seen_at=now(),
      idle_expires_at=LEAST(expires_at,now()+($2 * interval '1 second')) WHERE id=$1`,
    [customer.session_id, config.customerAuth.idleTtlSeconds]);
  }
  return customer;
}

async function requireCustomer(req, _res, next) {
  try {
    const customer = await customerFromRequest(req);
    if (!customer) throw apiError('AUTHENTICATION_REQUIRED', 'Sign in to My Parking to continue.', 401);
    req.customer = customer;
    next();
  } catch (error) { next(error); }
}

function csrf(req, _res, next) {
  const value = req.get('x-csrf-token');
  if (!value || !safeEqual(digest(value), req.customer.csrf_hash)) {
    return next(apiError('CSRF_REJECTED', 'A valid customer security token is required.', 403));
  }
  next();
}

async function rotateCsrf(req) {
  const csrfToken = token(24);
  await pool.query('UPDATE parking_customer_sessions SET csrf_hash=$1 WHERE id=$2', [digest(csrfToken), req.customer.session_id]);
  return csrfToken;
}

async function logout(req, res) {
  await pool.query('UPDATE parking_customer_sessions SET revoked_at=now() WHERE id=$1', [req.customer.session_id]);
  res.clearCookie(cookieName, cookieSettings());
}

async function cleanupExpired(client) {
  await client.query(`DELETE FROM parking_customer_auth_challenges
    WHERE created_at<now()-interval '2 days' OR consumed_at<now()-interval '1 day' OR invalidated_at<now()-interval '1 day'`);
  await client.query(`DELETE FROM parking_customer_sessions
    WHERE expires_at<=now() OR idle_expires_at<=now() OR revoked_at<now()-interval '30 days'`);
}

module.exports = {
  cookieName, cookieSettings, requestCode, verifyCode, customerFromRequest,
  requireCustomer, csrf, rotateCsrf, logout, cleanupExpired, customerView
};
