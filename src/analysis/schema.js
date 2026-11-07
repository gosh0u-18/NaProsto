const Ajv = require('ajv');
const diagnosticsByError = new WeakMap();
const publicFields = new Set(['items', 'warnings', 'documentContext', 'type', 'obligationLevel', 'title',
  'explanation', 'actor', 'role', 'sourceQuote', 'deadline', 'kind', 'originalText', 'date',
  'referenceEvent', 'pageNumber', 'text']);
function safeField(path) {
  if (typeof path !== 'string' || path.length > 200) {
    return '/';
  }
  const parts = path.split('/').slice(1);
  return parts.length && parts.every((part) => publicFields.has(part) || /^(?:0|[1-9]\d{0,3})$/.test(part))
    ? `/${parts.join('/')}` : '/';
}

const bounds = Object.freeze({
  inputBytes: 1_000_000,
  items: 200,
  title: 200,
  explanation: 4000,
  quote: 8000,
  deadlineText: 2000,
  warnings: 20,
  warning: 500,
});

const object = (properties) => ({
  type: 'object', additionalProperties: false,
  required: Object.keys(properties), properties,
});
const string = () => ({ type: 'string' });
const nullableString = () => ({ type: ['string', 'null'] });
const strings = () => ({ type: 'array', items: string() });

const deadlineSchema = object({
  kind: { type: 'string', enum: ['absolute', 'relative', 'ambiguous'] },
  originalText: string(),
  date: nullableString(),
  referenceEvent: nullableString(),
});
const candidateItemSchema = object({
  type: { type: 'string', enum: ['deadline', 'requirement', 'condition', 'document', 'action'] },
  obligationLevel: { type: 'string', enum: ['mandatory', 'recommended', 'informational', 'unclear'] },
  title: string(),
  explanation: string(),
  actor: { anyOf: [{ type: 'null' }, object({ role: string(), sourceQuote: string() })] },
  deadline: { anyOf: [{ type: 'null' }, deadlineSchema] },
  pageNumber: { type: 'integer' },
  sourceQuote: string(),
  warnings: strings(),
});
const candidateAnalysisSchema = object({
  documentContext: { type: 'array', items: object({
    kind: { type: 'string', enum: ['documentType', 'purpose', 'party', 'keyTerm'] },
    text: string(), pageNumber: { type: 'integer' }, sourceQuote: string(),
  }) },
  items: { type: 'array', items: candidateItemSchema },
  warnings: strings(),
});

const verifiedItemSchema = object({
  ...candidateItemSchema.properties,
  id: string(),
  actorVerificationStatus: { type: 'string', enum: ['verified', 'unverified', 'unknown'] },
  verificationStatus: { type: 'string', enum: ['verified', 'unverified'] },
  verificationReason: {
    type: 'string', enum: ['QUOTE_FOUND', 'PAGE_NOT_FOUND', 'INVALID_QUOTE', 'EMPTY_QUOTE', 'QUOTE_NOT_FOUND'],
  },
});
const pairSchema = object({ itemIds: strings(), reason: string() });
const analysisResultSchema = object({
  items: { type: 'array', items: verifiedItemSchema },
  warnings: strings(),
  pageDiagnostics: {
    type: 'array', items: object({
      pageNumber: { type: 'integer' }, suspicious: { type: 'boolean' }, reasons: strings(), warnings: strings(),
    }),
  },
  potentialDuplicates: { type: 'array', items: pairSchema },
  potentialConflicts: { type: 'array', items: pairSchema },
});

const structuredOutputFormat = {
  type: 'json_schema', name: 'document_analysis_candidates', strict: true,
  schema: candidateAnalysisSchema,
};

const ajv = new Ajv({ strict: true, allErrors: true, coerceTypes: false, useDefaults: false });
const validateCandidateShape = ajv.compile(candidateAnalysisSchema);
const validateResultShape = ajv.compile(analysisResultSchema);
const months = [
  'януари', 'февруари', 'март', 'април', 'май', 'юни',
  'юли', 'август', 'септември', 'октомври', 'ноември', 'декември',
];

function calendarDate(year, month, day) {
  if (year < 1 || year > 9999 || month < 1 || month > 12) {
    return null;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > days[month - 1]) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function explicitDates(text) {
  const dates = new Set();
  const add = (y, m, d) => { const date = calendarDate(+y, +m, +d); if (date) dates.add(date); };
  for (const match of text.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) add(match[1], match[2], match[3]);
  for (const match of text.matchAll(/(?<!\d)(\d{1,2})([./])(\d{1,2})\2(\d{4})(?!\d)/g)) add(match[4], match[3], match[1]);
  const pattern = new RegExp(`(?<![\\p{L}\\d])(\\d{1,2})\\s+(${months.join('|')})\\s+(\\d{4})(?!\\d)`, 'giu');
  for (const match of text.matchAll(pattern)) add(match[3], months.indexOf(match[2].toLowerCase()) + 1, match[1]);
  return dates;
}

function deadlineIssues(item) {
  const deadline = item.deadline;
  if (deadline === null) {
    return [];
  }
  const issues = [];
  const dates = explicitDates(deadline.originalText);
  if (!deadline.originalText.trim() || !item.sourceQuote.includes(deadline.originalText)) {
    issues.push('Текстът на срока трябва да е точен откъс от sourceQuote.');
  }
  if (deadline.referenceEvent !== null && (!deadline.referenceEvent.trim() || !deadline.originalText.includes(deadline.referenceEvent))) {
    issues.push('Началното събитие трябва да е точен откъс от текста на срока или null.');
  }
  if (deadline.kind !== 'absolute' && deadline.date !== null) {
    issues.push('Относителен или неясен срок не може да получи изчислена дата.');
  }
  if (deadline.kind === 'absolute' && deadline.referenceEvent !== null) {
    issues.push('Абсолютният срок не трябва да получава начално събитие.');
  }
  if (deadline.kind === 'absolute' && dates.size !== 1) {
    issues.push('Абсолютният срок трябва да съдържа една изрична пълна дата; иначе използвай ambiguous с date: null.');
  }
  if (deadline.date !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline.date) || !dates.has(deadline.date)) {
      issues.push('Датата трябва да е валидна и изрично подкрепена от текста на срока.');
    }
    if (dates.size > 1) issues.push('При няколко различни дати срокът трябва да остане неясен, без избрана дата.');
  }
  return issues;
}

function validateCandidateAnalysis(input, { deferDeadlineChecks = false } = {}) {
  let data;
  try {
    const json = typeof input === 'string' ? input : JSON.stringify(input);
    if (typeof json !== 'string' || Buffer.byteLength(json) > bounds.inputBytes) {
      return { valid: false, errors: [{ path: '', message: 'Невалиден или прекалено голям JSON резултат.' }] };
    }
    data = JSON.parse(json);
    if (data && typeof data === 'object' && !Array.isArray(data) && !Object.hasOwn(data, 'documentContext')) data.documentContext = [];

    if (Array.isArray(data?.items)) {
      for (const item of data.items) {
        if (item && typeof item === 'object' && !Array.isArray(item) && !Object.hasOwn(item, 'actor')) item.actor = null;
      }
    }
  } catch {
    return { valid: false, errors: [{ path: '', message: 'Резултатът не е валиден JSON.' }] };
  }
  if (!validateCandidateShape(data)) {
    return {
      valid: false,
      errors: validateCandidateShape.errors.map((error) => ({
        path: error.keyword === 'required' && publicFields.has(error.params.missingProperty)
          ? `${error.instancePath}/${error.params.missingProperty}` : error.instancePath,
        message: ({ required: 'Липсва задължително поле.', type: 'Полето има неправилен тип данни.',
          enum: 'Стойността не е сред разрешените варианти.', additionalProperties: 'Има непозволено допълнително поле.',
          anyOf: 'Полето не отговаря на разрешените структури.' })[error.keyword] || 'Полето не отговаря на схемата.', keyword: error.keyword,
      })),
    };
  }
  const errors = [];
  const issue = (path, message) => errors.push({ path, message });
  if (data.documentContext.length > 12) issue('/documentContext', 'Прекалено много елементи на обобщението.');
  for (const entry of data.documentContext) {
    if (!entry.text.trim() || entry.text.length > 500 || !entry.sourceQuote.trim() || entry.sourceQuote.length > 1000 ||
        entry.pageNumber < 1 || entry.pageNumber > 100) issue('/documentContext', 'Невалидно обобщение или източник.');
  }
  const checkWarnings = (warnings, path) => {
    if (warnings.length > bounds.warnings || warnings.some((warning) => !warning.trim() || warning.length > bounds.warning)) {
      issue(path, 'Прекалено много, празни или прекалено дълги предупреждения.');
    }
  };
  if (data.items.length > bounds.items) issue('/items', 'Прекалено много находки.');
  checkWarnings(data.warnings, '/warnings');
  for (const [index, item] of data.items.entries()) {
    const base = `/items/${index}`;
    for (const [field, max] of [['title', bounds.title], ['explanation', bounds.explanation], ['sourceQuote', bounds.quote]]) {

      if (item[field].length > max || (field !== 'sourceQuote' && !item[field].trim())) issue(`${base}/${field}`, 'Невалидна дължина на текста.');
    }
    if (item.pageNumber < 1 || item.pageNumber > 100) issue(`${base}/pageNumber`, 'Невалиден номер на страница.');
    checkWarnings(item.warnings, `${base}/warnings`);
    if (item.actor && (!item.actor.role.trim() || item.actor.role.length > 120 ||
        !item.actor.sourceQuote.trim() || item.actor.sourceQuote.length > 600)) {
      issue(`${base}/actor`, 'Ролята и цитатът за нея трябва да са непразни и с ограничена дължина.');
    }
    if (item.deadline) {
      if (item.deadline.originalText.length > bounds.deadlineText || (item.deadline.referenceEvent?.length || 0) > bounds.deadlineText) {
        issue(`${base}/deadline`, 'Прекалено дълъг текст на срока.');
      }
      if (!deferDeadlineChecks) {
        for (const message of deadlineIssues(item)) issue(`${base}/deadline`, message);
      }
    }
  }
  return errors.length ? { valid: false, errors } : { valid: true, data, errors: [] };
}

function parseCandidateAnalysis(input, options) {
  const result = validateCandidateAnalysis(input, options);
  if (!result.valid) {
    const error = new Error('Резултатът от анализа не отговаря на изискванията.');
    error.code = 'INVALID_ANALYSIS';
    error.issues = result.errors;
    diagnosticsByError.set(error, {
      issues: result.errors.slice(0, 10).map((issue) => ({
        field: safeField(issue.path), code: issue.keyword || 'VALIDATION_RULE', message: issue.message,
      })),
      truncated: result.errors.length > 10,
    });
    throw error;
  }
  return result.data;
}

module.exports = {
  getValidationDiagnostics: (error) => diagnosticsByError.get(error),
  candidateAnalysisSchema, analysisResultSchema, structuredOutputFormat,
  validateCandidateAnalysis, parseCandidateAnalysis, validateResultShape, bounds,
};

