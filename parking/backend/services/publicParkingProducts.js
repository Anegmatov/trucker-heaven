'use strict';

const { apiError } = require('../utils');

const SUPPORTED_PUBLIC_DURATIONS = Object.freeze(['DAILY', 'WEEKLY', 'MONTHLY']);
const supported = new Set(SUPPORTED_PUBLIC_DURATIONS);

function isSupportedPublicDuration(value) {
  return supported.has(String(value || '').trim().toUpperCase());
}

function assertSupportedPublicDuration(value) {
  const duration = String(value || '').trim().toUpperCase();
  if (!supported.has(duration)) {
    throw apiError('UNSUPPORTED_PRODUCT_DURATION', 'Customer parking supports only DAILY, WEEKLY, or MONTHLY', 422);
  }
  return duration;
}

function filterSupportedPublicDurations(values) {
  return (Array.isArray(values) ? values : []).filter(value => isSupportedPublicDuration(value?.code));
}

module.exports = Object.freeze({
  SUPPORTED_PUBLIC_DURATIONS,
  isSupportedPublicDuration,
  assertSupportedPublicDuration,
  filterSupportedPublicDurations
});
