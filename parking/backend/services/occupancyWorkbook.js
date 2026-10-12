const fs = require('fs');
const { unzipSync, strFromU8 } = require('fflate');
const customerImport = require('./customerImport');

const SHEET_NAME = 'PARKING PAYMENT MANAGEMENT';
const AVAILABLE_MARKER = /^AVAIL(?:ABLE)?$/i;

function attributes(source = '') {
  const result = {};
  for (const match of source.matchAll(/([:\w-]+)=(?:"([^"]*)"|'([^']*)')/g)) result[match[1]] = match[2] ?? match[3];
  return result;
}

function xmlFile(archive, name) {
  const value = archive[name];
  if (!value) throw new Error(`XLSX archive is missing ${name}`);
  return strFromU8(value);
}

function normalizeTarget(target) {
  const parts = [];
  for (const part of String(target).replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return parts.join('/');
}

function workbookSheetPath(archive, sheetName) {
  const workbook = xmlFile(archive, 'xl/workbook.xml');
  const sheet = [...workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/g)]
    .map(match => attributes(match[1])).find(item => item.name === sheetName);
  if (!sheet) throw new Error(`Workbook sheet ${sheetName} was not found`);
  const relationshipId = sheet['r:id'];
  const relationships = xmlFile(archive, 'xl/_rels/workbook.xml.rels');
  const relationship = [...relationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)]
    .map(match => attributes(match[1])).find(item => item.Id === relationshipId);
  if (!relationship) throw new Error(`Workbook relationship ${relationshipId} was not found`);
  return normalizeTarget(`xl/${relationship.Target}`);
}

function parseColor(source) {
  if (!source) return null;
  const attrs = attributes(source);
  return {
    rgb: attrs.rgb ? attrs.rgb.toUpperCase() : null,
    indexed: attrs.indexed === undefined ? null : Number(attrs.indexed),
    theme: attrs.theme === undefined ? null : Number(attrs.theme),
    tint: attrs.tint === undefined ? null : Number(attrs.tint),
    auto: attrs.auto === '1'
  };
}

const INDEXED_COLORS = [
  '000000','FFFFFF','FF0000','00FF00','0000FF','FFFF00','FF00FF','00FFFF',
  '000000','FFFFFF','FF0000','00FF00','0000FF','FFFF00','FF00FF','00FFFF',
  '800000','008000','000080','808000','800080','008080','C0C0C0','808080',
  '9999FF','993366','FFFFCC','CCFFFF','660066','FF8080','0066CC','CCCCFF',
  '000080','FF00FF','FFFF00','00FFFF','800080','800000','008080','0000FF',
  '00CCFF','CCFFFF','CCFFCC','FFFF99','99CCFF','FF99CC','CC99FF','FFCC99',
  '3366FF','33CCCC','99CC00','FFCC00','FF9900','FF6600','666699','969696',
  '003366','339966','003300','333300','993300','993366','333399','333333'
];

function themeColors(archive) {
  const file = archive['xl/theme/theme1.xml'];
  if (!file) return [];
  const xml = strFromU8(file);
  const scheme = /<a:clrScheme\b[^>]*>([\s\S]*?)<\/a:clrScheme>/.exec(xml)?.[1] || '';
  return [...scheme.matchAll(/<a:(?:dk1|lt1|dk2|lt2|accent[1-6]|hlink|folHlink)\b[^>]*>([\s\S]*?)<\/a:[^>]+>/g)]
    .map(match => /<(?:a:)?(?:srgbClr|sysClr)\b([^>]*)\/?\s*>/.exec(match[1]))
    .map(match => match ? (attributes(match[1]).val || attributes(match[1]).lastClr || null) : null);
}

function tintChannel(channel, tint) {
  const value = channel / 255;
  return Math.round(255 * (tint < 0 ? value * (1 + tint) : value * (1 - tint) + tint));
}

function displayColor(color, themes) {
  if (!color) return null;
  let rgb = color.rgb ? color.rgb.slice(-6) : null;
  if (!rgb && Number.isInteger(color.indexed)) rgb = INDEXED_COLORS[color.indexed] || null;
  if (!rgb && Number.isInteger(color.theme)) rgb = themes[color.theme] || null;
  if (!rgb || !/^[0-9A-F]{6}$/i.test(rgb)) return null;
  if (color.tint) {
    const channels = rgb.match(/../g).map(value => tintChannel(parseInt(value, 16), color.tint));
    rgb = channels.map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  return `#${rgb.toUpperCase()}`;
}

function parseStyles(archive) {
  const xml = xmlFile(archive, 'xl/styles.xml');
  const themes = themeColors(archive);
  const fillsSection = /<fills\b[^>]*>([\s\S]*?)<\/fills>/.exec(xml)?.[1] || '';
  const fills = [...fillsSection.matchAll(/<fill\b[^>]*>([\s\S]*?)<\/fill>/g)].map(match => {
    const pattern = /<patternFill\b([^>]*)>([\s\S]*?)<\/patternFill>|<patternFill\b([^>]*)\/>/.exec(match[1]);
    const patternAttrs = attributes(pattern?.[1] || pattern?.[3] || '');
    const content = pattern?.[2] || '';
    const foreground = parseColor(/<fgColor\b([^>]*)\/?\s*>/.exec(content)?.[1]);
    const background = parseColor(/<bgColor\b([^>]*)\/?\s*>/.exec(content)?.[1]);
    const effective = foreground || background;
    return { type: patternAttrs.patternType || null, foreground, background, display: displayColor(effective, themes) };
  });
  const xfsSection = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] || '';
  const xfs = [...xfsSection.matchAll(/<xf\b([^>]*)\/?\s*>/g)].map(match => {
    const attrs = attributes(match[1]);
    return { fillId: Number(attrs.fillId || 0), applyFill: attrs.applyFill === undefined ? null : attrs.applyFill === '1' };
  });
  return { fills, xfs };
}

function lotCellStyles(file, sheetName = SHEET_NAME) {
  const archive = unzipSync(new Uint8Array(fs.readFileSync(file)));
  const styles = parseStyles(archive);
  const sheet = xmlFile(archive, workbookSheetPath(archive, sheetName));
  const result = new Map();
  for (const match of sheet.matchAll(/<c\b([^>]*)>/g)) {
    const attrs = attributes(match[1]);
    const cell = /^A(\d+)$/i.exec(attrs.r || '');
    if (!cell) continue;
    const styleId = Number(attrs.s || 0);
    const xf = styles.xfs[styleId] || { fillId: 0, applyFill: null };
    const fill = styles.fills[xf.fillId] || { type: null, foreground: null, background: null, display: null };
    result.set(Number(cell[1]), { styleId, fillId: xf.fillId, applyFill: xf.applyFill, ...fill });
  }
  return result;
}

function usefulUnit(value) {
  const raw = customerImport.text(value);
  if (!raw || /^(N\/?A|NO\s*KEY|PAID|PAID FULL Y|[.*'-]+)$/i.test(raw)) return null;
  return raw;
}

function credibleOccupant(row) {
  const name = customerImport.text(row[1]);
  const nameCredible = /[A-Za-z]{2}/.test(name) && !AVAILABLE_MARKER.test(name)
    && !/^(SHOP|COMPANY|INTERNAL|DAILY CUSTOMER|DAILY\s+\d{1,2}\/)/i.test(name);
  return Boolean(nameCredible || customerImport.usefulPlate(row[7]) || usefulUnit(row[8]));
}

function fillEvidence(fill) {
  return {
    type: fill?.type || null,
    rgb: fill?.foreground?.rgb || fill?.background?.rgb || null,
    indexed: fill?.foreground?.indexed ?? fill?.background?.indexed ?? null,
    theme: fill?.foreground?.theme ?? fill?.background?.theme ?? null,
    tint: fill?.foreground?.tint ?? fill?.background?.tint ?? null,
    display: fill?.display || null,
    styleId: fill?.styleId ?? 0,
    fillId: fill?.fillId ?? 0
  };
}

function isRed(display) {
  const match = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/i.exec(display || '');
  if (!match) return false;
  const [red, green, blue] = match.slice(1).map(value => parseInt(value, 16));
  return red >= 128 && red > green * 1.5 && red > blue * 1.5;
}

function isYellow(display) {
  const match = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/i.exec(display || '');
  if (!match) return false;
  const [red, green, blue] = match.slice(1).map(value => parseInt(value, 16));
  return red >= 160 && green >= 160 && blue <= Math.min(red, green) * 0.55;
}

function classifyWorkbookRows(rows, styles, semanticColors = null) {
  const numeric = rows.slice(1).map((row, index) => ({ row, sourceRow: index + 2, lotText: customerImport.text(row[0]) }))
    .filter(item => /^\d+$/.test(item.lotText));
  const duplicateLots = new Set();
  const counts = new Map();
  for (const item of numeric) counts.set(item.lotText, (counts.get(item.lotText) || 0) + 1);
  for (const [lot, count] of counts) if (count > 1) duplicateLots.add(lot);

  const availableColors = new Set(semanticColors?.available || numeric
    .filter(item => AVAILABLE_MARKER.test(customerImport.text(item.row[1])))
    .map(item => styles.get(item.sourceRow)?.display).filter(isYellow));
  const internalColors = new Set(semanticColors?.internal || numeric
    .map(item => styles.get(item.sourceRow)?.display).filter(isRed));
  if (!availableColors.size) throw new Error('No XLSX fill color could be established from AVAIL/AVAILABLE lot rows');
  if (!internalColors.size) throw new Error('No operational red XLSX fill color was found on Lot # cells');

  const classifications = numeric.map(item => {
    const fill = styles.get(item.sourceRow) || null;
    const evidence = fillEvidence(fill);
    const base = {
      sourceRow: item.sourceRow, lot: Number(item.lotText), lotText: item.lotText,
      customer: customerImport.text(item.row[1]) || null,
      phone: customerImport.text(item.row[2]) || null,
      email: customerImport.text(item.row[3]) || null,
      rawDate: item.row[6] instanceof Date ? item.row[6].toISOString() : customerImport.text(item.row[6]) || null,
      plate: item.row[7] instanceof Date && !Number.isNaN(item.row[7].getTime())
        ? item.row[7].toISOString().slice(0, 10) : customerImport.text(item.row[7]) || null,
      unit: customerImport.text(item.row[8]) || null,
      rateCents: customerImport.currencyCents(item.row[11]),
      fill: evidence
    };
    if (duplicateLots.has(item.lotText)) return { ...base, classification: 'INVALID_OR_AMBIGUOUS', reason: 'DUPLICATE_PHYSICAL_ASSIGNMENT' };
    if (internalColors.has(evidence.display)) return { ...base, classification: 'SHOP_COMPANY_INTERNAL', reason: 'LOT_CELL_RED' };
    if (availableColors.has(evidence.display)) return { ...base, classification: 'AVAILABLE_YELLOW', reason: 'LOT_CELL_YELLOW' };
    if (AVAILABLE_MARKER.test(customerImport.text(item.row[1]))) {
      return { ...base, classification: 'AVAILABLE_EMPTY', reason: 'EXPLICIT_AVAILABILITY_MARKER' };
    }
    if (!credibleOccupant(item.row)) return { ...base, classification: 'AVAILABLE_EMPTY', reason: 'NO_CREDIBLE_CURRENT_OCCUPANT' };
    return { ...base, classification: 'CUSTOMER_OCCUPIED', reason: 'CREDIBLE_CURRENT_CUSTOMER_OR_TRUCK_DATA' };
  });
  return {
    sheet: SHEET_NAME,
    detectedColors: {
      available: [...availableColors].sort(),
      internal: [...internalColors].sort()
    },
    rows: classifications
  };
}

async function readAndClassify(file) {
  const rows = await customerImport.readWorkbook(file);
  return classifyWorkbookRows(rows, lotCellStyles(file));
}

module.exports = {
  SHEET_NAME, attributes, displayColor, lotCellStyles, credibleOccupant, classifyWorkbookRows, readAndClassify
};
