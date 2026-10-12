const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const { runMigrations } = require('../db/migrate');
const { loadConfig } = require('../lib/config');
const { createApp } = require('../server');
const { buildAdminRouter } = require('../routes/admin');
const { sha256 } = require('../lib/auth');
const express = require('express');
const { errorHandler } = require('../lib/http');

test('kitchen device authorization, revocation, admin isolation and order lifecycle', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const url = process.env.TEST_DATABASE_URL;
  assert.match(new URL(url).pathname, /^\/foodops(?:_[a-z0-9]+)*_test$/);
  const db = new Pool({ connectionString: url });
  let server;
  try {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await runMigrations(db);
    await runMigrations(db);
    const password = 'Kitchen-test-password-only';
    const hash = await bcrypt.hash(password, 4);
    const owner = (await db.query(`INSERT INTO admin_users(email,display_name,password_hash,role)
      VALUES ('owner@kitchen.test','Test owner',$1,'OWNER') RETURNING id`, [hash])).rows[0];
    const config = loadConfig({ DATABASE_URL: url, NODE_ENV: 'test' });
    const app = createApp({ database: db, config });
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/v1/admin`;
    const call = async (path, options={}) => {
      const response = await fetch(base+path, options);
      return { status: response.status, body: await response.json().catch(()=>null), cookie: response.headers.get('set-cookie') };
    };
    const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const token = 'kdev_'+crypto.randomBytes(32).toString('base64url');
    const activationId = sha256(token);
    const device = { Authorization: `Bearer ${token}` };
    let session;
    await t.test('public requests and arbitrary tokens cannot read orders or enroll', async()=>{
      for(const path of ['/kitchen','/orders','/device-session']) assert.equal((await call(path)).status,401);
      assert.equal((await call('/device-session',{headers:device})).body.error.code,'DEVICE_NOT_ENROLLED');
      assert.equal((await call('/auth/kitchen-device',post({activationId}))).status,401);
      assert.equal((await call('/device-session',{headers:{Authorization:'Bearer bad'}})).status,401);
    });
    await t.test('existing OWNER login and CSRF authorize migration without altering website login', async()=>{
      session = await call('/auth/login',post({email:'owner@kitchen.test',password}));
      assert.equal(session.status,200);
      assert.equal(session.body.user.role,'OWNER');
      const options=post({activationId});
      options.headers.Cookie=session.cookie.split(';')[0];
      assert.equal((await call('/auth/kitchen-device',options)).status,403);
      options.headers['X-CSRF-Token']=session.body.csrfToken;
      assert.equal((await call('/auth/kitchen-device',options)).status,201);
      assert.equal((await call('/auth/session',{headers:options.headers})).body.user.role,'OWNER');
      assert.equal((await call('/device-session',{headers:device})).body.user.role,'STAFF');
    });
    await t.test('device cannot use admin routes, cancellation, or admin authentication endpoints', async()=>{
      for(const path of ['/users','/settings','/menu-items','/dashboard','/orders/FAKE/menu'])
        assert.equal((await call(path,{headers:device})).status,403,path);
      for(const path of ['/users','/orders/FAKE/payment','/orders/FAKE/notes'])
        assert.equal((await call(path,{...post({}),headers:{...post({}).headers,...device}})).status,403,path);
      assert.equal((await call('/orders/FAKE/transition',{...post({status:'CANCELLED'}),headers:{...post({}).headers,...device}})).status,403);
      assert.equal((await call('/auth/session',{headers:device})).status,401);
      assert.equal((await call('/auth/kitchen-device',{...post({activationId}),headers:{...post({}).headers,...device}})).status,401);
    });
    await t.test('device polls and advances Accept to Ready to Complete without cookies or CSRF', async()=>{
      const order=(await db.query(`INSERT INTO orders(public_order_number,customer_name,customer_phone,order_type,
        status,payment_status,subtotal_cents,tax_cents,total_cents,lookup_token_hash,requested_at,estimated_ready_at,daily_ticket_date,daily_ticket_number)
        VALUES ('KITCHEN-V16-TEST','Test','6155550101','TAKEOUT','PENDING','DUE_ON_SITE',100,0,100,
        'test-only-lookup-hash','2026-09-18T00:30:00Z','2026-09-18T00:45:00Z','2026-09-17',1) RETURNING id`)).rows[0];
      assert.ok(order.id);
      for(const path of ['/kitchen','/orders','/orders/KITCHEN-V16-TEST']) {
        const result=await call(path,{headers:device});assert.equal(result.status,200,path);
        const value=result.body.order || result.body.orders[0];
        assert.equal(value.requestedAt,'2026-09-18T00:30:00.000Z');
        assert.equal(value.readyBy,'2026-09-18T00:45:00.000Z');
      }
      for(const status of ['CONFIRMED','READY','COMPLETED']) {
        const result=await call('/orders/KITCHEN-V16-TEST/transition',{...post({status}),headers:{...post({}).headers,...device}});
        assert.equal(result.status,200,JSON.stringify(result.body));
      }
    });
    await t.test('device push subscriptions are scoped and can be registered without browser CSRF', async()=>{
      const pushApp=express();pushApp.use(express.json());
      pushApp.use(buildAdminRouter(db,config,{configured:true,sendStatusChanged:async()=>({})}));pushApp.use(errorHandler);
      const pushServer=pushApp.listen(0,'127.0.0.1');
      await new Promise(resolve=>pushServer.once('listening',resolve));
      try {
        const pushUrl=`http://127.0.0.1:${pushServer.address().port}/push/register`;
        const pushToken='test-fcm-token-with-sufficient-length';
        assert.equal((await fetch(pushUrl,{...post({token:pushToken}),headers:{...post({}).headers,...device}})).status,201);
        const row=(await db.query('SELECT kitchen_device_hash FROM admin_push_subscriptions WHERE fcm_token=$1',[pushToken])).rows[0];
        assert.equal(row.kitchen_device_hash,activationId);
        assert.equal((await fetch(pushUrl,{method:'DELETE',headers:{'Content-Type':'application/json',...device},body:JSON.stringify({token:pushToken})})).status,204);
      } finally {await new Promise(resolve=>pushServer.close(resolve));}
    });
    await t.test('credential survives admin session expiry but revocation and disabled owner stop access', async()=>{
      await db.query('DELETE FROM admin_sessions');
      assert.equal((await call('/device-session',{headers:device})).status,200);
      await db.query('UPDATE admin_users SET is_active=FALSE WHERE id=$1',[owner.id]);
      assert.equal((await call('/device-session',{headers:device})).body.error.code,'DEVICE_REVOKED');
      await db.query('UPDATE admin_users SET is_active=TRUE WHERE id=$1',[owner.id]);
      await db.query('UPDATE kitchen_devices SET is_active=FALSE WHERE token_hash=$1',[activationId]);
      assert.equal((await call('/kitchen',{headers:device})).body.error.code,'DEVICE_REVOKED');
      await db.query('UPDATE admin_push_subscriptions SET enabled=TRUE WHERE kitchen_device_hash=$1',[activationId]);
      const { GoogleAuth }=require('google-auth-library');
      const transport=t.mock.method(GoogleAuth.prototype,'getClient',async()=>{throw new Error('Revoked device reached push transport');});
      try {
        const push=require('../lib/pushNotifications').createPushNotifications(db,{firebaseServiceAccount:{project_id:'local-test-only'}});
        const result=await push.sendNewOrder({orderNumber:'REVOKED-TEST',ticketNumber:1,itemCount:1});
        assert.equal(result.delivered,0);
        assert.equal(transport.mock.callCount(),0);
      } finally {transport.mock.restore();}
      session=await call('/auth/login',post({email:'owner@kitchen.test',password}));
      assert.equal(session.status,200);
      assert.equal((await call('/auth/kitchen-device',{...post({activationId}),headers:{...post({}).headers,Cookie:session.cookie.split(';')[0],'X-CSRF-Token':session.body.csrfToken}})).status,409);
      assert.equal((await call('/auth/logout',{method:'POST',headers:{Cookie:session.cookie.split(';')[0],'X-CSRF-Token':session.body.csrfToken}})).status,204);
    });
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));
    await db.end();
  }
});
