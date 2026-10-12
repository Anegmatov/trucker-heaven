/* Trucker Heaven Parking: "My Parking" (all of a driver's reservations, payments and documents)
   and document uploads (driver license / insurance). Uses the page helpers passed in by app.js. */
(() => {
  'use strict';

  const DOC_TYPES = { DRIVER_LICENSE: 'Driver license', INSURANCE: 'Insurance' };
  const DOC_STATUS = { MISSING: 'Not added', RECEIVED: 'Received', APPROVED: 'Approved', REPLACEMENT_REQUESTED: 'Please send a new one' };
  const MAX_BYTES = 15 * 1024 * 1024;
  const FILE_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
  const TABS = [['current', 'Current'], ['upcoming', 'Upcoming'], ['past', 'Past'], ['payments', 'Payments'], ['documents', 'Documents']];
  const IDENTITY_FIELDS = `
    <div class="row"><label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" required></label>
    <label class="field"><span>Mobile phone</span><input name="phone" type="tel" autocomplete="tel" required></label></div>`;

  const docStatus = status => DOC_STATUS[status] || DOC_STATUS.MISSING;

  // Checks a picked file before uploading: PDF, JPG or PNG up to 15 MB.
  function checkFile(file) {
    const extension = String(file?.name || '').toLowerCase().split('.').pop();
    const mimeType = FILE_TYPES[extension];
    if (!file?.size || !mimeType || (file.type && file.type !== mimeType)) throw { message: 'Choose a PDF, JPG or PNG file.' };
    if (file.size > MAX_BYTES) throw { message: 'Files can be up to 15 MB.' };
    return { filename: file.name, mimeType, sizeBytes: file.size };
  }

  function putFile(upload, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(upload.method || 'PUT', upload.url, true);
      Object.entries(upload.headers || {}).forEach(([name, value]) => xhr.setRequestHeader(name, value));
      xhr.upload.addEventListener('progress', event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); });
      xhr.addEventListener('load', () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject({ message: 'The upload did not finish. Please try again.' })));
      xhr.addEventListener('error', () => reject({ message: 'The upload was interrupted. Check your connection and try again.' }));
      xhr.send(file);
    });
  }

  // One upload: ask the server for a signed link, send the file, then confirm it.
  async function sendDocument(file, { start, complete }, onProgress = () => {}) {
    const details = checkFile(file);
    const started = await start(details);
    await putFile(started.upload, file, onProgress);
    return complete(started.upload.token);
  }

  window.ParkingAccount = function createAccount(ui) {
    const { $, esc, C, cfg, toast, setBusy, showError, loadingHtml } = ui;
    const account = { status: 'UNKNOWN', data: null, csrf: '', grantType: null, tab: 'current', message: '' };
    let upload = { type: '', file: null, progress: 0, busy: false, message: '', done: '' };

    async function request(path, { body, mutation = false } = {}) {
      if (!cfg.accountApiBase) throw { message: 'My Parking is not available right now. Please call the office.' };
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (mutation) headers['X-CSRF-Token'] = account.csrf;
      let response;
      try {
        response = await fetch(`${cfg.accountApiBase}/lookup${path}`, { method: body === undefined && !mutation ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'include', cache: 'no-store' });
      } catch (_) { throw { code: 'NETWORK' }; }
      const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
      if (!response.ok) throw { code: data.error?.code, message: data.error?.message, status: response.status };
      return data;
    }
    function signedIn(response) {
      Object.assign(account, { status: 'IN', data: response.summary, csrf: response.csrfToken || '', grantType: response.documentType || null, message: '' });
    }
    function signedOut(message = '') {
      Object.assign(account, { status: 'OUT', data: null, csrf: '', grantType: null, message });
    }
    async function resume() {
      account.status = 'LOADING';
      try { signedIn(await request('/summary')); }
      catch (error) { signedOut([401, 403, 404].includes(error.status) ? '' : C.friendlyError(error)); }
    }

    // ---------- My Parking ----------
    function reservationCard(item) {
      const term = C.TERMS[item.parkingProduct]?.label || item.parkingProduct;
      const dates = `${C.formatInstantDate(item.startsAt)} – ${item.endsAt ? C.formatInstantDate(item.endsAt) : 'ongoing'}`;
      const vehicle = [item.vehicle?.classification === 'Bobtail' ? 'Bobtail' : 'Truck & trailer', item.vehicle?.unitNumber && `Unit ${item.vehicle.unitNumber}`, item.vehicle?.licensePlate].filter(Boolean).join(' · ');
      return `<article class="card account-card">
        <div class="ticket-top"><div><span class="label">${esc(term)} parking</span><strong class="resnum">${esc(item.reservationNumber)}</strong></div><span class="status s-${esc(String(item.status).toLowerCase())}">${esc(C.statusLabel(item.status))}</span></div>
        <dl class="facts">
          <div><dt>Space</dt><dd>${esc(item.space || 'Office assigns at check-in')}</dd></div>
          <div><dt>Dates</dt><dd>${esc(dates)}</dd></div>
          <div class="wide"><dt>Vehicle</dt><dd>${esc(vehicle)}</dd></div>
          <div><dt>Driver license</dt><dd>${esc(docStatus(item.documents?.DRIVER_LICENSE?.status))}</dd></div>
          <div><dt>Insurance</dt><dd>${esc(docStatus(item.documents?.INSURANCE?.status))}</dd></div>
        </dl></article>`;
    }
    const empty = (title, text) => `<div class="card"><h2>${esc(title)}</h2><p class="muted">${esc(text)}</p></div>`;
    function tabBody() {
      const data = account.data || {};
      const reservations = data.reservations || {};
      if (account.tab === 'payments') {
        const rows = data.payments || [];
        return rows.length ? `<ul class="saved account-list">${rows.map(payment => `<li><div><b>${esc(C.money(payment.amountCents))}</b><span>${esc([`${C.TERMS[payment.parkingProduct]?.label || ''} parking`, payment.reservationNumber, C.formatInstantDate(payment.paidAt || payment.createdAt)].filter(Boolean).join(' · '))}</span></div><span class="status s-${payment.status === 'PAID' ? 'confirmed' : 'pending'}">${esc(C.statusLabel(payment.status))}</span></li>`).join('')}</ul>`
          : empty('No payments yet', 'Payments you make at the office show up here.');
      }
      if (account.tab === 'documents') {
        const all = [...(reservations.current || []), ...(reservations.upcoming || []), ...(reservations.past || [])];
        const rows = all.flatMap(item => Object.keys(DOC_TYPES).map(type => ({ number: item.reservationNumber, type, status: item.documents?.[type]?.status })));
        return `${rows.length ? `<ul class="saved account-list">${rows.map(row => `<li><div><b>${esc(DOC_TYPES[row.type])}</b><span>${esc(row.number)}</span></div><span>${esc(docStatus(row.status))}</span></li>`).join('')}</ul>` : ''}
          <div class="btn-row"><a class="btn primary" href="#upload">Upload or replace a document</a></div>
          <p class="muted small">For your privacy, uploaded files can't be viewed here.</p>`;
      }
      const items = reservations[account.tab] || [];
      const none = { current: ['No current parking', 'Parking that is active right now shows up here.'], upcoming: ['No upcoming parking', 'Confirmed future reservations show up here.'], past: ['No past parking', 'Finished and cancelled reservations show up here.'] }[account.tab];
      return items.length ? `<div class="account-cards">${items.map(reservationCard).join('')}</div>` : empty(...none);
    }
    function renderMyParking() {
      const body = $('#myParkingBody');
      if (account.status === 'UNKNOWN') { resume().then(renderMyParking); }
      if (['UNKNOWN', 'LOADING'].includes(account.status)) { body.innerHTML = loadingHtml('Loading My Parking…'); return; }
      if (account.status !== 'IN') {
        body.innerHTML = `<p class="kicker">All your parking</p><h1 class="page-title">My Parking</h1>
          <form class="card stack" id="accountForm" method="post" novalidate>
            <p class="muted">Enter the email and mobile phone you booked with to see all your parking, payments and documents.</p>
            ${IDENTITY_FIELDS}
            <p class="error" id="accountError" role="alert"${account.message ? '' : ' hidden'}>${esc(account.message)}</p>
            <button class="btn primary block" type="submit">Find my parking</button>
          </form>`;
        return;
      }
      body.innerHTML = `<div class="account-head"><div><p class="kicker">All your parking</p><h1 class="page-title">My Parking</h1></div><button type="button" class="link" data-account-signout>Sign out</button></div>
        <div class="account-tabs" role="tablist">${TABS.map(([key, label]) => `<button type="button" role="tab" data-account-tab="${key}" aria-selected="${account.tab === key}">${esc(label)}</button>`).join('')}</div>
        <div class="account-body">${tabBody()}</div>`;
    }

    // ---------- Upload documents ----------
    function renderUpload() {
      const body = $('#uploadBody');
      if (account.status === 'UNKNOWN') { resume().then(renderUpload); body.innerHTML = loadingHtml('Loading…'); return; }
      if (upload.done) {
        body.innerHTML = `<p class="kicker">Document received</p><h1 class="page-title">Thanks.</h1>
          <div class="card"><p>Your ${esc(DOC_TYPES[upload.done].toLowerCase())} was uploaded. The office reviews it before you arrive.</p>
          <div class="btn-row"><button type="button" class="btn primary" data-upload-again>Upload another</button><a class="btn ghost" href="#my-parking">My Parking</a><a class="btn ghost" href="#book">Reserve parking</a></div></div>`;
        return;
      }
      const choice = `<fieldset class="seg-group"><legend>What are you uploading?</legend><div class="seg two">
        ${Object.entries(DOC_TYPES).map(([type, label]) => `<label><input type="radio" name="docType" value="${type}"${upload.type === type ? ' checked' : ''}><span>${esc(label)}</span></label>`).join('')}</div></fieldset>`;
      let next = '';
      if (upload.type && account.grantType !== upload.type) {
        next = `<form class="stack" id="uploadIdentityForm" method="post" novalidate>
          <p class="muted">Enter the email and mobile phone you booked with.</p>
          ${IDENTITY_FIELDS}
          <p class="error" id="uploadIdentityError" role="alert"${account.message ? '' : ' hidden'}>${esc(account.message)}</p>
          <button class="btn primary block" type="submit">Continue</button></form>`;
      } else if (upload.type) {
        const reservation = account.data?.uploadReservation;
        const replacing = reservation && docStatus(reservation.documents?.[upload.type]?.status) !== DOC_STATUS.MISSING;
        next = !reservation ? `<p class="muted">We couldn't find a confirmed reservation to attach this to. Call the office for help.</p>`
          : `<form class="stack" id="uploadForm" method="post" novalidate>
            <dl class="facts"><div><dt>Reservation</dt><dd>${esc(reservation.reservationNumber)}</dd></div><div><dt>Parking</dt><dd>${esc(C.TERMS[reservation.parkingProduct]?.label || '')} · ${esc(C.formatInstantDate(reservation.startsAt))}</dd></div></dl>
            ${replacing ? `<p class="muted small">We already have one. This upload replaces it.</p>` : ''}
            <div class="btn-row"><label class="btn ghost file-btn">Take photo<input type="file" data-upload-file accept="image/jpeg,image/png" capture="environment"></label><label class="btn ghost file-btn">Choose file<input type="file" data-upload-file accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"></label></div>
            <p class="muted small">${upload.file ? esc(upload.file.name) : 'PDF, JPG or PNG, up to 15 MB.'}</p>
            ${upload.busy ? `<progress class="upload-progress" max="100" value="${upload.progress}">${upload.progress}%</progress>` : ''}
            <p class="error" role="alert"${upload.message ? '' : ' hidden'}>${esc(upload.message)}</p>
            <button class="btn primary block" type="submit"${upload.file && !upload.busy ? '' : ' disabled'}>${upload.busy ? 'Uploading…' : `${replacing ? 'Replace' : 'Upload'} ${esc(DOC_TYPES[upload.type].toLowerCase())}`}</button></form>`;
      }
      body.innerHTML = `<p class="kicker">Documents</p><h1 class="page-title">Upload a document</h1>
        <div class="card stack">${choice}${next}</div>`;
    }
    async function submitUpload() {
      upload.busy = true; upload.progress = 0; upload.message = ''; renderUpload();
      try {
        const type = upload.type;
        await sendDocument(upload.file, {
          start: details => request(`/documents/${type}/upload`, { body: details, mutation: true }),
          complete: uploadToken => request('/documents/complete', { body: { uploadToken }, mutation: true })
        }, progress => { upload.progress = progress; const bar = $('.upload-progress'); if (bar) bar.value = progress; });
        await resume();
        upload = { type: '', file: null, progress: 0, busy: false, message: '', done: type };
      } catch (error) {
        upload.busy = false; upload.message = error.message || C.friendlyError(error);
      }
      renderUpload();
    }

    // ---------- events (delegated from app.js) ----------
    async function signIn(form, errorEl, documentType = null) {
      const details = Object.fromEntries(new FormData(form));
      if (Object.values(details).some(value => !String(value).trim())) { showError(errorEl, 'Enter your email and mobile phone.'); return false; }
      const button = form.querySelector('button[type="submit"]');
      setBusy(button, true, 'Checking…');
      try {
        signedIn(await request('', { body: { ...details, ...(documentType ? { documentType } : {}) } }));
        return true;
      } catch (error) {
        showError(errorEl, error.code === 'PARKING_RECORD_NOT_FOUND' ? 'We couldn\'t find a confirmed reservation with those details.' : C.friendlyError(error));
        return false;
      } finally { setBusy(button, false); }
    }
    async function onSubmit(event) {
      const form = event.target;
      if (form.id === 'accountForm') { event.preventDefault(); if (await signIn(form, $('#accountError'))) renderMyParking(); }
      else if (form.id === 'uploadIdentityForm') { event.preventDefault(); account.message = ''; if (await signIn(form, $('#uploadIdentityError'), upload.type)) renderUpload(); }
      else if (form.id === 'uploadForm') { event.preventDefault(); if (upload.file && !upload.busy) submitUpload(); }
    }
    async function onClick(target) {
      if (target.dataset.accountTab) { account.tab = target.dataset.accountTab; renderMyParking(); return true; }
      if (target.hasAttribute('data-account-signout')) {
        try { await request('/logout', { mutation: true }); } catch (_) { /* signing out locally is enough */ }
        signedOut(); toast('Signed out'); renderMyParking(); return true;
      }
      if (target.hasAttribute('data-upload-again')) { upload.done = ''; renderUpload(); return true; }
      return false;
    }
    function onChange(event) {
      if (event.target.name === 'docType') { upload = { ...upload, type: event.target.value, file: null, message: '', done: '' }; renderUpload(); }
      else if (event.target.matches('[data-upload-file]')) {
        const file = event.target.files?.[0] || null;
        try { if (file) checkFile(file); upload.file = file; upload.message = ''; } catch (error) { upload.file = null; upload.message = error.message; }
        renderUpload();
      }
    }

    return { renderMyParking, renderUpload, onSubmit, onClick, onChange, sendDocument, docStatus, DOC_TYPES };
  };
})();
