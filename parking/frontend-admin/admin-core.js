(function registerParkingAdminCore(root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  if (root) root.ParkingAdminCore = core;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  'use strict';

  const LIVE_STATUSES = Object.freeze(['AVAILABLE', 'RESERVED', 'OCCUPIED', 'BLOCKED', 'INACTIVE']);
  const customerUses = new Set(['CUSTOMER', 'CUSTOMER_BOBTAIL', 'DAILY', 'WEEKLY', 'MONTHLY']);

  function canonicalStatus(space) {
    if (space?.active === false) return 'INACTIVE';
    const value = String(space?.operationalStatus || '').toUpperCase();
    return LIVE_STATUSES.includes(value) ? value : 'UNKNOWN';
  }

  function statusClass(space) {
    return canonicalStatus(space).toLowerCase();
  }

  function operationallyAvailable(space) {
    return canonicalStatus(space) === 'AVAILABLE';
  }

  function allocationCategory(space) {
    const lotNumber = Number(String(space?.number ?? '').trim());
    if (Number.isInteger(lotNumber)) {
      if (lotNumber >= 10 && lotNumber <= 67) return 'MONTHLY_BOBTAIL';
      if (lotNumber >= 149 && lotNumber <= 194 && !(lotNumber >= 165 && lotNumber <= 167)) return 'MONTHLY_TRUCK_TRAILER';
      if ((lotNumber >= 165 && lotNumber <= 167) || (lotNumber >= 195 && lotNumber <= 204)) return 'CAR_HAULER';
      if (lotNumber >= 110 && lotNumber <= 148) return 'DAILY';
      if (lotNumber >= 68 && lotNumber <= 90) return 'SHOP';
      if (lotNumber >= 101 && lotNumber <= 109) return 'COMPANY';
    }
    const purpose = String(space?.parkingPurpose || space?.accessType || '').toUpperCase();
    if (purpose === 'SHOP') return 'SHOP';
    if (purpose === 'COMPANY') return 'COMPANY';
    if (String(space?.bookingTerm || '').toUpperCase() === 'DAILY') return 'DAILY';
    if (String(space?.vehicleType || '').toUpperCase() === 'BOBTAIL') return 'MONTHLY_BOBTAIL';
    if (String(space?.bookingTerm || '').toUpperCase() === 'MONTHLY') return 'MONTHLY_TRUCK_TRAILER';
    return 'UNALLOCATED';
  }

  function allocationClass(space) {
    return `allocation-${allocationCategory(space).toLowerCase().replaceAll('_', '-')}`;
  }

  function allocationLabel(space) {
    return ({
      MONTHLY_BOBTAIL: 'Monthly Bobtail',
      MONTHLY_TRUCK_TRAILER: 'Monthly Truck & Trailer',
      CAR_HAULER: 'Car Hauler',
      DAILY: 'Daily',
      SHOP: 'Shop',
      COMPANY: 'Company',
      UNALLOCATED: 'Unallocated'
    })[allocationCategory(space)];
  }

  function publiclyBookableAvailable(space) {
    const purpose = String(space?.parkingPurpose || '').toUpperCase();
    const use = String(space?.parkingUse || '').toUpperCase();
    const hasProductContract = ['dailyEligible', 'monthlyEligible'].some(key => Object.hasOwn(space || {}, key));
    const hasProduct = !hasProductContract || space?.dailyEligible || space?.monthlyEligible;
    const rateReady = !Object.hasOwn(space || {}, 'ratePlan') || space?.ratePlan?.active === true;
    return canonicalStatus(space) === 'AVAILABLE'
      && space?.active !== false
      && space?.publicBookable === true
      && hasProduct && rateReady
      && (purpose === 'CUSTOMER' || customerUses.has(use))
      && space?.classificationState === 'COMPLETE'
      && Array.isArray(space?.vehicleEligibility)
      && space.vehicleEligibility.length > 0;
  }

  function bookingEligibilityWarnings(space, plan, now = Date.now()) {
    const warnings = [];
    const purpose = String(space?.parking_purpose ?? space?.parkingPurpose ?? '').toUpperCase();
    const daily = Boolean(space?.daily_eligible ?? space?.dailyEligible);
    const monthly = Boolean(space?.monthly_eligible ?? space?.monthlyEligible);
    const publicBookable = Boolean(space?.space_public_bookable ?? space?.publicBookable);
    const hasPlan = Boolean(plan?.id ?? space?.rate_plan_id ?? space?.ratePlan?.id);
    if (purpose !== 'CUSTOMER') {
      if (daily || monthly || publicBookable || hasPlan) warnings.push({ code: 'NON_CUSTOMER_BOOKING_CONFIGURATION', blocking: true, message: 'Shop, Company, Internal, and unresolved spaces cannot offer customer parking products.' });
      return warnings;
    }
    if (daily && monthly) warnings.push({ code: 'MULTIPLE_BOOKING_TERMS', blocking: true, message: 'Choose exactly one customer booking term: Daily or Monthly.' });
    if (!hasPlan) {
      if (daily || monthly) warnings.push({ code: 'RATE_PLAN_REQUIRED', blocking: true, message: 'Choose a rate plan before enabling Daily or Monthly parking.' });
      else warnings.push({ code: 'RATE_PLAN_NOT_ASSIGNED', blocking: false, message: 'No rate plan is assigned. This space cannot offer priced parking.' });
      return warnings;
    }
    const activePlan = plan?.active !== false && (!plan?.starts_at || new Date(plan.starts_at).getTime() <= now)
      && (!plan?.ends_at || new Date(plan.ends_at).getTime() > now);
    if (!activePlan) warnings.push({ code: 'RATE_PLAN_INACTIVE', blocking: daily || monthly, message: 'The assigned rate plan is inactive or outside its effective dates.' });
    const category = space?.spot_category_code ?? space?.categoryCode;
    if (category && plan?.category_code && category !== plan.category_code) warnings.push({ code: 'RATE_PLAN_INCOMPATIBLE', blocking: true, message: 'The assigned rate plan does not match this space classification.' });
    if (daily && plan?.daily_rate_cents == null) warnings.push({ code: 'DAILY_RATE_REQUIRED', blocking: true, message: 'Daily parking is enabled but this plan has no daily price.' });
    if (monthly && plan?.monthly_rate_cents == null) warnings.push({ code: 'MONTHLY_RATE_REQUIRED', blocking: true, message: 'Monthly parking is enabled but this plan has no monthly price.' });
    return warnings;
  }

  function filterLiveSpaces(spaces, filters = {}) {
    return (spaces || []).filter(space => {
      if (filters.operationalStatus && canonicalStatus(space) !== filters.operationalStatus) return false;
      if (filters.parkingUse && String(space.parkingUse) !== String(filters.parkingUse)) return false;
      if (filters.vehicleCategoryId && !(space.vehicleEligibility || []).some(item => String(item.id ?? item.categoryId ?? item) === String(filters.vehicleCategoryId))) return false;
      if (filters.availableOnly && !operationallyAvailable(space)) return false;
      if (filters.issuesOnly && !(space.warnings || []).length && space.classificationState !== 'NEEDS_CLASSIFICATION') return false;
      if (filters.futureOnly && !space.nextReservation) return false;
      if (filters.dailyOnly && !space.dailyEligible) return false;
      if (filters.monthlyOnly && !space.monthlyEligible) return false;
      return true;
    });
  }

  function summarizeLiveSpaces(spaces, backendSummary = null) {
    const source = spaces || [];
    const backend = backendSummary && typeof backendSummary === 'object' ? backendSummary : {};
    const value = (key, fallback) => Number.isFinite(Number(backend[key])) ? Number(backend[key]) : fallback;
    return Object.freeze({
      physical: value('physicalSpaces', source.length),
      available: source.filter(operationallyAvailable).length,
      customerBookable: value('availableCustomerSpaces', source.filter(publiclyBookableAvailable).length),
      publiclyBookable: value('publiclyBookable', source.filter(space => space?.publicBookable === true).length),
      reserved: value('reserved', source.filter(space => canonicalStatus(space) === 'RESERVED').length),
      occupied: value('occupied', source.filter(space => canonicalStatus(space) === 'OCCUPIED').length),
      blocked: value('blocked', source.filter(space => canonicalStatus(space) === 'BLOCKED').length),
      inactive: source.filter(space => canonicalStatus(space) === 'INACTIVE').length,
      unknown: source.filter(space => canonicalStatus(space) === 'UNKNOWN').length,
      unresolved: value('unresolved', source.filter(space => space.classificationState === 'NEEDS_CLASSIFICATION').length),
      configurationWarnings: value('configurationIssues', source.reduce((total, space) => total + (space.warnings || []).filter(item => item.severity !== 'INFO').length, 0))
    });
  }

  function createRequestGate() {
    let sequence = 0;
    let controller = null;
    return Object.freeze({
      next() {
        controller?.abort();
        controller = typeof AbortController === 'undefined' ? null : new AbortController();
        const id = ++sequence;
        return { id, signal: controller?.signal, current: () => id === sequence };
      },
      cancel() { controller?.abort(); sequence += 1; },
      isCurrent(id) { return id === sequence; }
    });
  }

  const busySnapshots = new WeakMap();
  function setFormBusy(form, busy) {
    if (!form) return;
    const controls = [...form.querySelectorAll('button, input, select, textarea')].filter(control => control.type !== 'hidden');
    if (busy) {
      if (busySnapshots.has(form)) return;
      busySnapshots.set(form, controls.map(control => [control, control.disabled]));
      controls.forEach(control => { control.disabled = true; });
      form.setAttribute('aria-busy', 'true');
      form.classList.add('is-loading');
      form.querySelector('[type="submit"]')?.classList.add('is-loading');
      return;
    }
    const snapshot = busySnapshots.get(form);
    if (snapshot) snapshot.forEach(([control, disabled]) => { if (control.isConnected) control.disabled = disabled; });
    busySnapshots.delete(form);
    form.removeAttribute('aria-busy');
    form.classList.remove('is-loading');
    form.querySelector('[type="submit"]')?.classList.remove('is-loading');
  }

  function partsInZone(instant, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(instant));
    return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  }

  function formatDateTimeLocal(instant, timeZone) {
    if (!instant) return '';
    const parts = partsInZone(instant, timeZone);
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  }

  function localDateTimeToInstant(value, timeZone, { disambiguation = 'reject' } = {}) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || ''));
    if (!match) throw new Error('Enter a valid local date and time.');
    const [, year, month, day, hour, minute] = match;
    const wanted = `${year}-${month}-${day}T${hour}:${minute}`;
    const approximate = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
    const matches = [];
    for (let delta = -14 * 60; delta <= 14 * 60; delta += 15) {
      const instant = approximate + delta * 60000;
      if (formatDateTimeLocal(instant, timeZone) === wanted) matches.push(instant);
    }
    const unique = [...new Set(matches)];
    if (!unique.length) throw new Error(`${wanted} does not exist in ${timeZone} because of a daylight-saving transition.`);
    if (unique.length > 1 && disambiguation === 'reject') throw new Error(`${wanted} occurs twice in ${timeZone}. Choose a time outside the daylight-saving overlap.`);
    return new Date(disambiguation === 'later' ? unique.at(-1) : unique[0]).toISOString();
  }

  function formatInZone(value, timeZone, options = {}) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '—';
    return new Intl.DateTimeFormat('en-US', { timeZone, dateStyle: 'medium', timeStyle: 'short', ...options }).format(parsed);
  }

  function boundsFor(elements) {
    const placed = (elements || []).filter(item => [item.x, item.y, item.width, item.height].every(value => Number.isFinite(Number(value))));
    if (!placed.length) return null;
    const minX = Math.min(...placed.map(item => Number(item.x)));
    const minY = Math.min(...placed.map(item => Number(item.y)));
    const maxX = Math.max(...placed.map(item => Number(item.x) + Number(item.width)));
    const maxY = Math.max(...placed.map(item => Number(item.y) + Number(item.height)));
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }

  function fitScale(elements, viewportWidth, viewportHeight, baseWidth = 100, baseHeight = 150, padding = 24) {
    const bounds = boundsFor(elements);
    if (!bounds || viewportWidth <= padding * 2 || viewportHeight <= padding * 2) return 1;
    const renderedWidth = bounds.width / baseWidth * Math.max(baseWidth, viewportWidth);
    const renderedHeight = bounds.height / baseHeight * Math.max(baseHeight, viewportHeight);
    return Math.max(.45, Math.min(1.5, Math.min((viewportWidth - padding * 2) / renderedWidth, (viewportHeight - padding * 2) / renderedHeight)));
  }

  return Object.freeze({ LIVE_STATUSES, canonicalStatus, statusClass, operationallyAvailable, allocationCategory, allocationClass, allocationLabel, publiclyBookableAvailable, bookingEligibilityWarnings, filterLiveSpaces, summarizeLiveSpaces, createRequestGate, setFormBusy, formatDateTimeLocal, localDateTimeToInstant, formatInZone, boundsFor, fitScale });
});
