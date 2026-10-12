'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname,'..');
const geckodriver = process.env.GECKODRIVER_PATH
  || (process.env.GECKOWEBDRIVER ? path.join(process.env.GECKOWEBDRIVER,'geckodriver') : '/snap/bin/geckodriver');
const serverOnlyVisual = process.env.PARKING_SMOKE_SERVER_ONLY === '1';
let bookingStatus='PENDING';
let bookingVersion=1;
let rejectAuthorizedRequests=false;
let unauthorizedRequestCount=0;
let failDashboard=false;
let loginCount=0;
let currentRole='OWNER';
let assignedSpace='163';
let shopBlocked=false;
const notes=[];
const booking = () => ({id:7,reservation_number:'TH-TEST-0007',status:bookingStatus,arrival_at:'2034-05-10T14:00:00.000Z',departure_at:'2034-06-10T14:00:00.000Z',first_name:'Browser',last_name:'Driver',mobile_phone:'+16155550107',email:'browser.driver@example.test',company_name:'Browser Smoke',usdot_number:'1234567',tractor_unit_number:'BS-7',trailer_number:'',license_plate:'SMOKE7',license_plate_state:'TN',version:bookingVersion,location_name:'Smoke Lot',location_timezone:'America/Chicago',category_name:'General Truck Parking',zone_name:'Smoke Area',assigned_spot_id:assignedSpace==='163'?1:2,assigned_spot_label:assignedSpace,assignment_mode_snapshot:'CUSTOMER_SELECTED_SPOT',parking_product:'MONTHLY',payment_status:'PAID',customer_public_id:'cus_smoke',customer_display_name:'Browser Driver',customer_account_company_name:'Browser Smoke',snapshot:{duration:'MONTHLY',totalCents:25000}});
const customerAccount = () => ({publicId:'cus_smoke',displayName:'Browser Driver',companyName:'Browser Smoke',firstName:'Browser',lastName:'Driver',phone:'+16155550107',email:'browser.driver@example.test',usdotNumber:'1234567',mcNumber:'765432',phoneVerified:true,emailVerified:true,status:'ACTIVE',reservationCount:1,vehicleCount:1,paidPaymentCount:1,openConflictCount:0,reservations:[],vehicles:[],documents:[]});
const currentReservation = () => ({id:7,reservationNumber:'TH-TEST-0007',status:bookingStatus,startsAt:'2034-05-10T14:00:00.000Z',endsAt:'2034-06-10T14:00:00.000Z',duration:'MONTHLY',customer:{publicId:'cus_smoke'},rateCents:25000});
const currentCustomer = () => ({publicId:'cus_smoke',name:'Browser Driver',company:'Browser Smoke',phone:'+16155550107',email:'browser.driver@example.test',usdotNumber:'1234567',mcNumber:'765432',rateCents:25000,payment:{status:'PAID',balanceCents:0}});
const overdueCustomer = () => ({publicId:'cus_smoke',displayName:'Browser Driver',companyName:'Browser Smoke',lifecycleStatus:'ACTIVE',currentParkings:[{bookingId:7,spot:assignedSpace,parkingProduct:'MONTHLY',rateCents:25000}],payment:{status:'OVERDUE',balanceCents:5000}});

function json(res,status,body,headers={}){
  res.writeHead(status,{'content-type':'application/json','access-control-allow-origin':'http://127.0.0.1:5181','access-control-allow-credentials':'true',...headers});
  res.end(JSON.stringify(body));
}

const api=http.createServer((req,res)=>{
  if(req.method==='OPTIONS'){
    res.writeHead(204,{'access-control-allow-origin':'http://127.0.0.1:5181','access-control-allow-credentials':'true','access-control-allow-methods':'GET,POST,PATCH,DELETE','access-control-allow-headers':'Content-Type,X-CSRF-Token'});res.end();return;
  }
  const authenticated=serverOnlyVisual||String(req.headers.cookie||'').includes('parking_admin_session=browser-smoke');
  if(req.url==='/api/admin/auth/login'&&req.method==='POST') { loginCount+=1;currentRole=loginCount===2?'STAFF':'OWNER';return json(res,200,{user:{username:currentRole==='OWNER'?'browser-owner':'browser-staff',role:currentRole},csrfToken:'browser-csrf'},{'set-cookie':'parking_admin_session=browser-smoke; Path=/; HttpOnly; SameSite=Lax'}); }
  if(!authenticated) return json(res,401,{error:{code:'AUTHENTICATION_REQUIRED',message:'Sign in is required'}});
  if(req.url==='/api/admin/auth/session') return json(res,200,{user:{username:currentRole==='OWNER'?'browser-owner':'browser-staff',role:currentRole}});
  if(rejectAuthorizedRequests){unauthorizedRequestCount+=1;return json(res,401,{error:{code:'AUTHENTICATION_REQUIRED',message:'Session expired'}});}
  if(req.url==='/api/admin/auth/csrf') return json(res,200,{csrfToken:'browser-csrf'});
  if(req.url==='/api/admin/auth/logout') return json(res,204,null);
  if(failDashboard&&req.url.startsWith('/api/admin/parking/v1/dashboard')) return json(res,500,{error:{code:'SMOKE_FAILURE',message:'Authoritative service unavailable'}});
  if(req.url.startsWith('/api/admin/parking/v1/dashboard')) return json(res,200,{summary:{current_customers:1,available_spaces:1,overdue_customers:1,overdue_balance_cents:5000,insurance_pending_review:1,arrivals:1,checked_in:0,departures:0,overdue:0,no_shows:0,upcoming:1,active_physical_spaces:2,monthly_spaces:2,monthly_active:1,publicly_bookable_spaces:2,reserved_spaces:1,blocked_spaces:0,booked_value:25000},occupancy:[],recentActivity:[{created_at:'2034-05-01T10:00:00.000Z',new_status:bookingStatus,reservation_number:'TH-TEST-0007'}],currentCustomers:[{id:7,reservation_number:'TH-TEST-0007',parking_product:'MONTHLY',customer_public_id:'cus_smoke',customer_name:'Browser Driver',customer_phone:'+16155550107',license_plate:'SMOKE7',license_plate_state:'TN',tractor_unit_number:'BS-7',assigned_spot_id:1,assigned_spot_label:'163',payment_status:'OVERDUE',balance_cents:5000}],attentionRequired:[{id:7,reservation_number:'TH-TEST-0007',status:'PENDING',customer_public_id:'cus_smoke',customer_name:'Browser Driver',assigned_spot_id:1,assigned_spot_label:'163',attention_type:'PAID_ALLOCATION_REVIEW'},{id:8,reservation_number:'TH-IGNORE-0008',status:'PENDING',customer_public_id:'cus_smoke',customer_name:'Browser Driver',attention_type:'PENDING_CONFIRMATION'}]});
  if(req.url==='/api/admin/parking/v1/canonical-live-lot/snapshot') return json(res,200,{location:{id:1,name:'Smoke Lot',timezone:'America/Chicago',publishedLayoutId:1,layoutVersion:1},summary:{physicalSpaces:2,customerSpaces:2,availableCustomerSpaces:1,dailyAvailable:0,monthlyAvailable:1,dailyPhysical:0,monthlyPhysical:2,publiclyBookable:2,generalTruck:2,bobtail:0,internalUse:0,unresolved:0,reserved:1,occupied:0,blocked:shopBlocked?1:0,configurationIssues:0},spaces:[{id:1,number:'163',active:true,area:{id:1,name:'Smoke Area'},physicalSection:'MONTHLY_TRUCK_TRAILER',operationalStatus:assignedSpace==='163'?'RESERVED':'AVAILABLE',parkingUse:'CUSTOMER',parkingUseLabel:'General Truck Parking',classificationState:'COMPLETE',parkingPurpose:'CUSTOMER',bookingTerm:'MONTHLY',vehicleType:'TRACTOR_TRAILER',accessType:'CUSTOMER',dailyEligible:false,weeklyEligible:true,monthlyEligible:true,publicBookable:true,ratePlan:{id:1,name:'Smoke Rate',active:true,dailyRateCents:1900,weeklyRateCents:10000,monthlyRateCents:25000},bookingVisibility:'PUBLIC',vehicleEligibility:[{id:2,code:'TRACTOR_TRAILER',name:'General Truck Parking'}],currentReservation:assignedSpace==='163'?currentReservation():null,layout:{elementId:1,x:10,y:20,width:8,height:18,rotation:0,zOrder:20},warnings:[]},{id:2,number:'164',active:true,area:{id:1,name:'Smoke Area'},physicalSection:'MONTHLY_TRUCK_TRAILER',operationalStatus:assignedSpace==='164'?'RESERVED':shopBlocked?'BLOCKED':'AVAILABLE',parkingUse:'CUSTOMER',parkingUseLabel:'General Truck Parking',classificationState:'COMPLETE',parkingPurpose:'CUSTOMER',bookingTerm:'MONTHLY',vehicleType:'TRACTOR_TRAILER',accessType:'CUSTOMER',dailyEligible:false,weeklyEligible:true,monthlyEligible:true,publicBookable:true,ratePlan:{id:1,name:'Smoke Rate',active:true,dailyRateCents:1900,weeklyRateCents:10000,monthlyRateCents:25000},bookingVisibility:'PUBLIC',vehicleEligibility:[{id:2,code:'TRACTOR_TRAILER',name:'General Truck Parking'}],currentReservation:assignedSpace==='164'?currentReservation():null,activeBlock:shopBlocked?{id:2,reason:'Browser block'}:null,layout:{elementId:2,x:24,y:20,width:8,height:18,rotation:0,zOrder:20},warnings:[]}],layout:{id:1,name:'Published smoke map',version:1,elements:[{id:10,type:'OFFICE',label:'Office',spaceId:null,x:5,y:5,width:20,height:8,rotation:0,zOrder:1},{id:1,type:'PARKING_SPOT',label:'163',spaceId:1,x:10,y:20,width:8,height:18,rotation:0,zOrder:20},{id:2,type:'PARKING_SPOT',label:'164',spaceId:2,x:24,y:20,width:8,height:18,rotation:0,zOrder:20}]},warnings:[]});
  if(req.url==='/api/admin/parking/v1/bookings/7/spot-alternatives') return json(res,200,{current:{public_label:assignedSpace},alternatives:[{id:assignedSpace==='163'?2:1,public_label:assignedSpace==='163'?'164':'163',area_name:'Smoke Area'}]});
  if(req.url==='/api/admin/parking/v1/bookings/7/reassign-spot'&&req.method==='POST'){assignedSpace=assignedSpace==='163'?'164':'163';bookingVersion+=1;return json(res,200,{assignedSpace});}
  if(req.url==='/api/admin/parking/v1/bookings/7/notes'&&req.method==='POST'){notes.push({username:currentRole==='OWNER'?'browser-owner':'browser-staff',note:'Standalone browser note',created_at:new Date().toISOString()});return json(res,201,{ok:true});}
  if(req.url.startsWith('/api/admin/parking/v1/bookings/7/')&&req.method==='POST'){bookingStatus=req.url.endsWith('/confirm')?'CONFIRMED':bookingStatus;bookingVersion+=1;return json(res,200,{status:bookingStatus,version:bookingVersion});}
  if(req.url==='/api/admin/parking/v1/bookings/7') return json(res,200,{booking:booking(),history:[{created_at:'2034-05-01T10:00:00.000Z',previous_status:null,new_status:bookingStatus,actor_type:'SYSTEM'}],notes,adjustments:[],assignments:[{id:1,public_label:assignedSpace,area_name:'Smoke Area',assigned_at:'2034-05-01T10:00:00.000Z',released_at:null}],documents:[],customerAccount:customerAccount()});
  if(req.url.startsWith('/api/admin/parking/v1/bookings')) return json(res,200,{bookings:[booking()],pagination:{limit:50,hasMore:false,nextCursor:null}});
  if(req.url==='/api/admin/parking/v1/reservation-desk/bootstrap') return json(res,200,{locations:[{id:1,name:'Smoke Lot',address:'100 Example Way',timezone:'America/Chicago',phone:'+16155550100',active:true,categories:[{code:'BOBTAIL',name:'Bobtail'},{code:'TRACTOR_TRAILER',name:'General Truck Parking'}]}],permissions:['reservation.read','reservation.create','reservation.update','reservation.document.manage','reservation.payment_link','reservation.price_override','reservation.global_pricing.manage'],payment:{stripeCheckoutConfigured:true,currency:'usd'},documents:{secureUploadConfigured:true},notifications:{emailConfigured:true,smsConfigured:true}});
  if(req.url.startsWith('/api/admin/parking/v1/reservation-desk/customers')) return json(res,200,{customers:[]});
  if(req.url.startsWith('/api/admin/parking/v1/documents')) return json(res,200,{documents:[{id:'doc_smoke',type:'INSURANCE',verificationStatus:'PENDING_REVIEW',customerPublicId:'cus_smoke',customer:'Browser Driver',companyName:'Browser Smoke'},{id:'doc_smoke_duplicate',type:'INSURANCE',verificationStatus:'PENDING_REVIEW',customerPublicId:'cus_smoke',customer:'Browser Driver',companyName:'Browser Smoke'},{id:'doc_smoke_license',type:'DRIVER_LICENSE',verificationStatus:'PENDING_REVIEW',customerPublicId:'cus_smoke',customer:'Browser Driver',companyName:'Browser Smoke'}]});
  if(req.url==='/api/admin/parking/v1/customers/cus_smoke') return json(res,200,{customer:{publicId:'cus_smoke',displayName:'Browser Driver',firstName:'Browser',lastName:'Driver',companyName:'Browser Smoke',phone:'+16155550107',email:'browser.driver@example.test',usdotNumber:'1234567',mcNumber:'765432',lifecycleStatus:'ACTIVE',recordSource:'PARKINGOPS',createdAt:'2034-05-01T10:00:00.000Z'},reservations:[booking()],vehicles:[{license_plate:'SMOKE7',unit_number:'BS-7',active:true,record_source:'PARKINGOPS'}],billingPeriods:[],payments:[],documents:[],notes:[],legacyParkingRecords:[],legacyAnomalies:[]});
  if(req.url.startsWith('/api/admin/parking/v1/customers')) return json(res,200,{customers:[overdueCustomer()],metrics:{activeCustomers:1,dueThisMonth:0,overdueBalanceCents:5000,paidThisMonthCents:0},totals:{customers:1},pagination:{limit:50,hasMore:false,nextCursor:null}});
  if(req.url.startsWith('/api/admin/parking/v1/calendar')) return json(res,200,{timezone:'America/Chicago',range:{startDate:'2034-05-10',endDate:'2034-05-11'},totalEvents:1,events:[{bookingId:7,reservationNumber:'TH-TEST-0007',status:bookingStatus,customerName:'Browser Driver',assignedSpace,at:'2034-05-10T14:00:00.000Z',localDate:'2034-05-10',type:'ARRIVAL'}],pagination:{limit:100,hasMore:false,nextCursor:null}});
  if(req.url==='/api/admin/parking/v1/operational-locations') return json(res,200,{items:[{id:1,name:'Smoke Lot',timezone:'America/Chicago',exact_mode_active:true,active:true,version:1}]});
  if(req.url==='/api/admin/parking/v1/locations') return json(res,200,{items:[{id:1,name:'Smoke Lot',timezone:'America/Chicago',exact_mode_active:true,active:true,version:1,public_description:'Disposable smoke property',address:'100 Example Way',phone:'+16155550100',business_hours:'Always open',arrival_instructions:'Follow posted signs.',exit_instructions:'Use the marked exit.',road_directions_url:'https://example.test/directions',booking_approval_mode:'AUTO_CONFIRM',cancellation_cutoff_hours:24,payment_instructions:'Pay at the office.'}]});
  if(req.url==='/api/admin/parking/v1/zones') return json(res,200,{items:[]});
  if(req.url==='/api/admin/parking/v1/categories') return json(res,200,{items:[{id:1,code:'BOBTAIL',name:'Bobtail Parking',active:true},{id:2,code:'TRACTOR_TRAILER',name:'General Truck',active:true}]});
  if(req.url==='/api/admin/parking/v1/closures') return json(res,200,{items:[]});
  if(req.url==='/api/admin/parking/v1/locations/1/layout') return json(res,200,{draft:null,published:{id:1,name:'Published smoke map',status:'PUBLISHED',version:1,elements:[{id:1,version:1,parking_spot_id:1,parking_spot_version:1,element_type:'PARKING_SPOT',label:'163',x:10,y:10,width:8,height:18,rotation:0,layer_order:20,active:true,parking_purpose:'CUSTOMER',spot_category_code:'TRACTOR_TRAILER',spot_parking_use:'CUSTOMER',space_public_bookable:true,daily_eligible:false,weekly_eligible:true,monthly_eligible:true,rate_plan_id:1,space_internal_note:''}]},ratePlans:[{id:1,version:1,plan_name:'Smoke Rate',daily_rate_cents:1900,weekly_rate_cents:10000,monthly_rate_cents:25000}],canonicalMaintenanceLocked:true});
  if(req.url==='/api/admin/parking/v1/admin-users') return json(res,200,{items:[{id:1,username:'browser-owner',role:'OWNER',active:true,version:1}]});
  if(req.url==='/api/admin/parking/v1/spaces/1/operational-detail') return json(res,200,{id:1,actions:{canReserve:assignedSpace!=='163',canMove:assignedSpace==='163',canBlock:assignedSpace!=='163',canUnblock:false,canEditLayout:true},currentReservation:assignedSpace==='163'?currentReservation():null,currentCustomer:assignedSpace==='163'?currentCustomer():null,currentVehicle:assignedSpace==='163'?{unitNumber:'BS-7',licensePlate:'SMOKE7',licensePlateState:'TN'}:null,recentHistory:[]});
  if(req.url==='/api/admin/parking/v1/spaces/2/operational-detail') return json(res,200,{id:2,operationalStatus:shopBlocked?'BLOCKED':assignedSpace==='164'?'RESERVED':'AVAILABLE',activeBlock:shopBlocked?{id:2,reason:'Browser block'}:null,actions:{canReserve:!shopBlocked&&assignedSpace!=='164',canMove:assignedSpace==='164',canBlock:currentRole==='OWNER'&&!shopBlocked&&assignedSpace!=='164',canUnblock:currentRole==='OWNER'&&shopBlocked,canEditLayout:currentRole==='OWNER'},currentReservation:assignedSpace==='164'?currentReservation():null,currentCustomer:assignedSpace==='164'?currentCustomer():null,currentVehicle:assignedSpace==='164'?{unitNumber:'BS-7',licensePlate:'SMOKE7',licensePlateState:'TN'}:null,recentHistory:[]});
  if(req.url==='/api/admin/parking/v1/spots/2/block'&&req.method==='POST'){shopBlocked=true;return json(res,201,{item:{id:2}});}
  if(req.url==='/api/admin/parking/v1/spots/2/unblock'&&req.method==='POST'){shopBlocked=false;return json(res,200,{released:1});}
  return json(res,404,{error:{code:'NOT_FOUND',message:`No smoke route for ${req.method} ${req.url}`}});
});

const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.jpg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml'};
const web=http.createServer((req,res)=>{
  if(req.url==='/api'||req.url.startsWith('/api/')) return api.emit('request',req,res);
  if(req.url==='/favicon.ico'){res.writeHead(204,{'cache-control':'no-store'});res.end();return;}
  const relative=req.url==='/'?'index.html':req.url.replace(/^\//,'');
  const file=path.resolve(root,relative);
  if(!file.startsWith(root)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream','cache-control':'no-store'});fs.createReadStream(file).pipe(res);
});

const listen=(server,port)=>new Promise((resolve,reject)=>server.once('error',reject).listen(port,'127.0.0.1',resolve));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

const runBrowserSmoke=async()=>{
  let driver;let sessionId='';
  try{
    await listen(web,5181);
    driver=spawn(geckodriver,['--port','4457'],{stdio:['ignore','pipe','pipe']});
    for(let i=0;i<50;i+=1){try{const ready=await fetch('http://127.0.0.1:4457/status');if(ready.ok)break;}catch(_){}await delay(100);}
    const command=async(endpoint,method='GET',body)=>{const response=await fetch(`http://127.0.0.1:4457${endpoint}`,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const payload=await response.json();if(!response.ok||(payload.value?.error&&payload.value?.stacktrace!==undefined))throw new Error(JSON.stringify(payload));return payload.value;};
    const created=await command('/session','POST',{capabilities:{alwaysMatch:{browserName:'firefox','moz:firefoxOptions':{args:['-headless']}}}});sessionId=created.sessionId;
    const session=endpoint=>`/session/${sessionId}${endpoint}`;
    await command(session('/url'),'POST',{url:'http://127.0.0.1:5181/'});
    const waitFor=async(script,message)=>{for(let i=0;i<80;i+=1){if(await command(session('/execute/sync'),'POST',{script,args:[]}))return;await delay(100);}const diagnostic=await command(session('/execute/sync'),'POST',{script:"return {text:document.body.innerText.slice(0,2000),errors:window.__PARKING_ADMIN_ERROR_COUNT||0}",args:[]});throw new Error(`${message}\n${JSON.stringify(diagnostic)}`);};
    await waitFor("return Boolean(document.querySelector('#loginForm'))",'Login did not render.');
    const find=async selector=>{const value=await command(session('/element'),'POST',{using:'css selector',value:selector});return value[Object.keys(value)[0]];};
    const user=await find('#loginUser');await command(session(`/element/${user}/value`),'POST',{text:'browser-owner'});
    const pass=await find('#loginPass');await command(session(`/element/${pass}/value`),'POST',{text:'browser-password'});
    const submit=await find('#loginForm button[type="submit"]');await command(session(`/element/${submit}/click`),'POST',{});
    await waitFor("return document.querySelector('.main h2')?.textContent==='Overview'",'Overview did not load after login.');
    await command(session('/window/rect'),'POST',{width:1440,height:900,x:0,y:0});
    fs.writeFileSync('/tmp/parkingops-admin-dashboard.png',Buffer.from(await command(session('/screenshot')),'base64'));
    assert.equal(await command(session('/execute/sync'),'POST',{script:"return [...document.querySelectorAll('.dashboard-kpi')].find(item=>item.textContent.includes('Available Now'))?.querySelector('strong')?.textContent",args:[]}), '1');
    assert.deepEqual(await command(session('/execute/sync'),'POST',{script:"return {login:document.querySelectorAll('#loginForm').length,sidebar:document.querySelectorAll('.sidebar').length,apiBase:window.PARKING_ADMIN_CONFIG.apiBase}",args:[]}),{login:0,sidebar:1,apiBase:'http://127.0.0.1:5181/api'},'The signed-in admin must have one shell and one API base.');
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('[data-nav=\"Lot Setup\"]').click(); return true",args:[]});
    await waitFor("return document.querySelector('.parking-page-heading h2')?.textContent==='Lot Setup' && document.querySelectorAll('.operational-map-space').length===2",'OWNER Lot Setup did not load the published layout.');
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('[data-nav=\"Advanced Map Tools\"]').click(); return true",args:[]});
    await waitFor("return !document.querySelector('#advancedAdminRoot').hidden && document.querySelectorAll('[data-lot-space]').length===1",'OWNER Advanced Map Tools did not load the publication workspace.');
    assert.equal(await command(session('/execute/sync'),'POST',{script:"return !document.querySelector('#layoutMaintenanceNotice').hidden && Boolean(document.querySelector('#layoutCreateDraft')) && Boolean(document.querySelector('#layoutPreview')) && Boolean(document.querySelector('#layoutReviewPublish'))",args:[]}),true,'Lot Setup safety, draft, preview, or publish controls are missing.');
    fs.writeFileSync('/tmp/parkingops-admin-advanced.png',Buffer.from(await command(session('/screenshot')),'base64'));
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('[data-nav=\"Business Settings\"]').click(); return true",args:[]});
    await waitFor("return !document.querySelector('#configuration').hidden && document.querySelector('#businessSettingsForm [name=name]').value==='Smoke Lot'",'OWNER business settings did not load.');
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('[data-nav=\"Team\"]').click(); return true",args:[]});
    await waitFor("return !document.querySelector('#adminUsersPanel').hidden && document.querySelector('#adminUsersList').textContent.includes('browser-owner')",'OWNER user security administration did not load.');
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('[data-nav=\"Overview\"]').click(); return true",args:[]});
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('[data-nav=\"Live Lot\"]').click(); return true",args:[]});
    await waitFor("return document.querySelectorAll('.operational-map-space').length===2 && document.querySelectorAll('.lot-list-fallback tbody tr').length===2",'Published Live Lot geometry and fallback list did not render.');
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('.operational-map-space[data-space-id=\"1\"]').click(); return true",args:[]});
    await waitFor("return document.querySelector('.drawer-customer-section')?.textContent.includes('Browser Driver') && document.querySelector('[data-customer-id=\"cus_smoke\"]')",'Occupied Live Lot space did not prioritize its canonical customer.');
    assert.equal(await command(session('/execute/sync'),'POST',{script:"return document.querySelector('.drawer-section h4')?.textContent==='Space' && document.querySelector('.customer-first-drawer')?.textContent.includes('Balance') && getComputedStyle(document.body).backgroundColor==='rgb(201, 216, 229)'",args:[]}),true,'Live Lot drawer hierarchy or premium Trucker Heaven theme was not active.');
    fs.writeFileSync('/tmp/parkingops-admin-live-lot-customer.png',Buffer.from(await command(session('/screenshot')),'base64'));
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('.open-customer-cta').click(); return true",args:[]});
    await waitFor("return document.querySelector('.main h2')?.textContent==='Browser Driver' && document.querySelector('.panel-head')?.textContent==='Identity'",'Live Lot Open Customer did not navigate to the canonical customer profile.');
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('[data-nav=\"Live Lot\"]').click(); return true",args:[]});
    await waitFor("return document.querySelectorAll('.operational-map-space').length===2",'Live Lot did not reload after customer navigation.');
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('.operational-map-space[data-space-id=\"2\"]').click(); return true",args:[]});
    await waitFor("return Boolean(document.querySelector('#blockSpaceForm'))",'Owner block workflow did not load from selected-space detail.');
    const blockReason=await find('#blockSpaceReason');await command(session(`/element/${blockReason}/value`),'POST',{text:'Browser block'});
    const blockSubmit=await find('#blockSpaceForm button[type="submit"]');await command(session(`/element/${blockSubmit}/click`),'POST',{});
    await waitFor("return Boolean(document.querySelector('[data-unblock-space]')) && document.querySelector('.operational-map-space[data-space-id=\"2\"]').classList.contains('blocked')",'Blocked state did not persist after authoritative refresh.');
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('[data-unblock-space]').click(); return true",args:[]});
    await waitFor("return Boolean(document.querySelector('#blockSpaceForm')) && !document.querySelector('.operational-map-space[data-space-id=\"2\"]').classList.contains('blocked')",'Unblocked state did not persist after authoritative refresh.');
    fs.writeFileSync('/tmp/parkingops-admin-live-lot.png',Buffer.from(await command(session('/screenshot')),'base64'));
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('[data-nav=\"Reservations\"]').click(); return true",args:[]});
    await waitFor("return [...document.querySelectorAll('.reservation-table th')].map(item=>item.textContent).join('|')==='Lot #|Customer|Plate / Unit|Type|Dates|Payment|Status'",'Reservations did not render the customer-first column order.');
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('[data-open-space-id=\"1\"]').click(); return true",args:[]});
    await waitFor("return document.querySelector('.parking-page-heading h2')?.textContent==='Live Lot' && document.querySelector('.operational-map-space[data-space-id=\"1\"]').classList.contains('selected')",'Reservation Lot # did not open the linked Live Lot position.');
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('[data-nav=\"Reservations\"]').click(); return true",args:[]});
    await waitFor("return Boolean(document.querySelector('.reservation-table'))",'Reservations did not return after the Lot # link test.');
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('.table-customer-link[data-customer-id=\"cus_smoke\"]').click(); return true",args:[]});
    await waitFor("return document.querySelector('.main h2')?.textContent==='Browser Driver'",'Reservation customer name did not open the canonical customer profile.');
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('[data-nav=\"Reservations\"]').click(); return true",args:[]});
    await waitFor("return Boolean(document.querySelector('[data-booking-id=\"7\"]'))",'Reservations did not return after customer navigation.');
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('[data-booking-id=\"7\"]').click(); return true",args:[]});
    await waitFor("return Boolean(document.querySelector('[data-booking-action=\"confirm\"]')) && document.querySelector('.reservation-customer-section')?.textContent.includes('Browser Driver')",'Reservation details did not load with the customer section.');
    const reason=await find('#bookingActionReason');await command(session(`/element/${reason}/value`),'POST',{text:'Browser smoke confirmation'});
    assert.equal(await command(session('/execute/sync'),'POST',{script:"return document.querySelector('#bookingActionReason').value",args:[]}),'Browser smoke confirmation','The operator reason was not entered.');
    const confirm=await find('[data-booking-action="confirm"]');await command(session(`/element/${confirm}/click`),'POST',{});
    for(let i=0;i<80&&bookingStatus!=='CONFIRMED';i+=1) await delay(100);
    const mutationDiagnostic=await command(session('/execute/sync'),'POST',{script:"return {reason:document.querySelector('#bookingActionReason')?.value||'',error:document.querySelector('.main>.error')?.textContent||'',text:document.querySelector('.main')?.innerText.slice(0,800)||''}",args:[]});
    assert.equal(bookingStatus,'CONFIRMED',`The API fixture did not receive the confirmed mutation. ${JSON.stringify(mutationDiagnostic)}`);
    await waitFor("return [...document.querySelectorAll('.data-table tbody .badge')].some(item=>item.textContent==='CONFIRMED')",'Confirmed mutation was not reflected.');
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('[data-load-alternatives]').click(); return true",args:[]});
    await waitFor("return Boolean(document.querySelector('#reassignmentForm option[value=\"2\"]'))",'Backend alternatives were not rendered.');
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('#replacementSpot').value='2';document.querySelector('#reassignmentReason').value='Browser reassignment';document.querySelector('#reassignmentForm').requestSubmit();return true",args:[]});
    await waitFor("return document.querySelector('.snapshot-item:nth-child(4) b')?.textContent==='164'",'Reassignment did not refresh the authoritative reservation detail.');
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('#standaloneBookingNote').value='Standalone browser note';document.querySelector('#bookingNoteForm').requestSubmit();return true",args:[]});
    await waitFor("return [...document.querySelectorAll('.calendar-event span')].some(item=>item.textContent==='Standalone browser note')",'Standalone note did not persist after refresh.');
    fs.writeFileSync('/tmp/parkingops-admin-reservation.png',Buffer.from(await command(session('/screenshot')),'base64'));
    await command(session('/refresh'),'POST',{});
    await waitFor("return document.querySelector('.main h2')?.textContent==='Overview'",'Authoritative Overview did not load after browser refresh.');
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('[data-nav=\"Reservations\"]').click(); return true",args:[]});
    await waitFor("return [...document.querySelectorAll('.data-table tbody .badge')].some(item=>item.textContent==='CONFIRMED')",'Authoritative mutation did not survive refresh.');
    await command(session('/window/rect'),'POST',{width:500,height:758,x:0,y:0});
    fs.writeFileSync('/tmp/parkingops-admin-narrow.png',Buffer.from(await command(session('/screenshot')),'base64'));
    assert.equal(await command(session('/execute/sync'),'POST',{script:'return document.documentElement.scrollWidth<=document.documentElement.clientWidth',args:[]}),true,'The 500px layout has horizontal page overflow.');
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('[data-nav=\"Lot Setup\"]').click(); return true",args:[]});
    await waitFor("return document.querySelector('.parking-page-heading h2')?.textContent==='Lot Setup'",'Narrow Lot Setup did not load.');
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('[data-nav=\"Advanced Map Tools\"]').click(); return true",args:[]});
    await waitFor("return !document.querySelector('#advancedAdminRoot').hidden && !document.querySelector('#layoutMobileNotice').hidden",'Narrow Lot Setup did not become read-only.');
    assert.equal(await command(session('/execute/sync'),'POST',{script:'return document.documentElement.scrollWidth<=document.documentElement.clientWidth',args:[]}),true,'The 500px advanced layout has horizontal page overflow.');
    fs.writeFileSync('/tmp/parkingops-admin-advanced-narrow.png',Buffer.from(await command(session('/screenshot')),'base64'));
    assert.equal(await command(session('/execute/sync'),'POST',{script:`return ${JSON.stringify(['Fleet Service Board','Company Yards','Assigned Driver','Work Orders','Service Reminders','Samsara','Fleet Equipment Inventory','FSB Reports'])}.every(screen=>!document.querySelector('[data-nav="'+CSS.escape(screen)+'"]'))`,args:[]}),true,'Retired fleet modules remained exposed in ParkingOps navigation.');
    assert.equal(await command(session('/execute/sync'),'POST',{script:'return localStorage.length',args:[]}),0,'Operations frontend mutated localStorage.');

    failDashboard=true;
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('[data-nav=\"Overview\"]').click(); document.querySelector('[data-refresh]').click(); return true",args:[]});
    await waitFor("return document.querySelector('.main>.error')?.textContent.includes('Authoritative service unavailable')",'Backend failure was not visible.');
    assert.equal(await command(session('/execute/sync'),'POST',{script:"return !document.body.innerText.includes('TH-TEST-0007')",args:[]}),true,'Stale private data remained visible after an authoritative refresh failure.');
    failDashboard=false;
    await command(session('/execute/sync'),'POST',{script:"document.querySelector('[data-refresh]').click(); return true",args:[]});
    await waitFor("return document.querySelector('.main h2')?.textContent==='Overview' && !document.querySelector('.main>.error')",'Overview did not recover after a visible backend error.');

    await command(session('/execute/sync'),'POST',{script:"document.querySelector('[data-logout]').click(); return true",args:[]});
    await waitFor("return Boolean(document.querySelector('#loginForm'))",'Logout did not return to login.');
    assert.equal(await command(session('/execute/sync'),'POST',{script:"return !document.body.innerText.includes('TH-TEST-0007') && !document.body.innerText.includes('Browser Driver')",args:[]}),true,'Private state remained visible after logout.');

    const userAgain=await find('#loginUser');await command(session(`/element/${userAgain}/value`),'POST',{text:'browser-owner'});
    const passAgain=await find('#loginPass');await command(session(`/element/${passAgain}/value`),'POST',{text:'browser-password'});
    const submitAgain=await find('#loginForm button[type="submit"]');await command(session(`/element/${submitAgain}/click`),'POST',{});
    await waitFor("return document.querySelector('.main h2')?.textContent==='Overview'",'Overview did not reload after second login.');
    assert.equal(await command(session('/execute/sync'),'POST',{script:"return !document.querySelector('[data-nav=\"Team\"]') && !document.querySelector('[data-nav=\"Lot Setup\"]')",args:[]}),true,'STAFF navigation exposed OWNER-only tools.');
    assert.equal(await command(session('/execute/async'),'POST',{script:"const done=arguments[arguments.length-1]; window.ParkingAdvancedAdmin.activate({username:'browser-staff',role:'STAFF'},'lot-setup').then(result=>done(result===false && document.querySelector('#advancedAdminRoot').hidden));",args:[]}),true,'STAFF was not blocked by the advanced-module guard.');
    rejectAuthorizedRequests=true;
    await command(session('/execute/async'),'POST',{script:"const done=arguments[arguments.length-1]; window.ParkingAdminApi.dashboard().catch(()=>{}).finally(()=>done(true));",args:[]});
    await waitFor("return Boolean(document.querySelector('#loginForm')) && document.body.innerText.includes('session expired')",'A simulated 401 did not clear the session.');
    await delay(500);
    assert.ok(unauthorizedRequestCount<=4,`Simulated 401 caused a request loop (${unauthorizedRequestCount} requests).`);
    assert.equal(await command(session('/execute/sync'),'POST',{script:"return !document.body.innerText.includes('TH-TEST-0007') && localStorage.length===0",args:[]}),true,'A simulated 401 retained private or locally persisted state.');
    const browserErrors=await command(session('/execute/sync'),'POST',{script:'return window.__PARKING_ADMIN_ERRORS',args:[]});
    assert.deepEqual(browserErrors,[],'Browser recorded uncaught errors.');
    console.log('Canonical admin browser smoke passed: login, customer-first Live Lot/Reservations/Customers navigation, backend reservation mutation, Trucker Heaven desktop and 500px layouts, retired-module exclusion, recovery, logout and 401 clearing, and zero localStorage mutation.');
  }finally{
    if(sessionId){try{await fetch(`http://127.0.0.1:4457/session/${sessionId}`,{method:'DELETE'});}catch(_){}}
    driver?.kill('SIGTERM');web.close();
  }
};

if(serverOnlyVisual){
  listen(web,5181).then(()=>console.log('ParkingOps browser smoke fixture available at http://127.0.0.1:5181'));
}else{
  runBrowserSmoke().catch(error=>{console.error(error);process.exitCode=1;});
}
