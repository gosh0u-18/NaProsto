const { randomUUID } = require('node:crypto');
const { parseCandidateAnalysis, validateResultShape } = require('./schema');
const pdfLimits = require('../limits');
const { verifyActor, canonicalRole } = require('./actors');

const diagnosticMessages = {
  NO_EXTRACTABLE_TEXT: 'На страницата няма извлекаем текст.',
  SPARSE_LETTERS: 'Извлечени са твърде малко букви спрямо числа и пунктуация. Текстът може да е непълен.',
  UNREADABLE_CHARACTERS: 'Текстът съдържа заместващи, служебни или частни символи и може да е неправилно извлечен.',
  SUSPICIOUS_NUMERIC_TEXT: 'Дата, час или сума съдържа букви, наподобяващи цифри. Възможна е OCR грешка. Свери стойността с изображението; не я поправяме автоматично.',
};

function diagnosePage(page) {
  const text = page.text;
  const nonSpace = [...text].filter((character) => !/\s/u.test(character)).length;
  const letters = (text.match(/\p{L}/gu) || []).length;
  const reasons = [];
  if (!text.trim()) reasons.push('NO_EXTRACTABLE_TEXT');
  if (nonSpace >= 12 && letters < 6 && letters / nonSpace < 0.2) reasons.push('SPARSE_LETTERS');
  if (/[\uFFFD\p{Co}\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(text)) reasons.push('UNREADABLE_CHARACTERS');

  const numericLike = '[0-9IOlООб]';
  const dateLike = new RegExp(`(?<![\\p{L}\\p{N}])(${numericLike}{1,2}[./]${numericLike}{1,2}[./]${numericLike}{4})(?![\\p{L}\\p{N}])`, 'gu');
  const timeLike = new RegExp(`(?<![\\p{L}\\p{N}])(${numericLike}{1,2}:${numericLike}{2})(?![\\p{L}\\p{N}])`, 'gu');
  const amountLike = new RegExp(`(?<![\\p{L}\\p{N}])(${numericLike}{1,3}(?:[ \\u00a0]${numericLike}{3})*(?:[,.]${numericLike}{2})?)\\s*(?:евро|лв\\.?|EUR|BGN)(?!\\p{L})`, 'gu');
  if ([dateLike, timeLike, amountLike].some((pattern) => [...text.matchAll(pattern)].some((match) => /[IOlООб]/u.test(match[1])))) {
    reasons.push('SUSPICIOUS_NUMERIC_TEXT');
  }
  return { pageNumber: page.pageNumber, suspicious: reasons.length > 0, reasons, warnings: reasons.map((reason) => diagnosticMessages[reason]) };
}

function validatePages(pages) {
  const fail = () => {
    const error = new Error('Невалиден източник за проверка на анализа.');
    error.code = 'INVALID_SOURCE_PAGES';
    throw error;
  };
  if (!Array.isArray(pages) || pages.length > pdfLimits.maxPages) fail();
  let total = 0;
  const numbers = new Set();
  for (const page of pages) {
    if (!page || !Number.isInteger(page.pageNumber) || page.pageNumber < 1 || page.pageNumber > pdfLimits.maxPages ||
        typeof page.text !== 'string' || page.text.length > pdfLimits.maxPageCharacters || numbers.has(page.pageNumber)) fail();
    numbers.add(page.pageNumber);
    total += page.text.length;
    if (total > pdfLimits.maxCharacters) fail();
  }
}

function checkSource(item, page, diagnostic) {
  const warnings = [];
  let reason;
  if (typeof item.sourceQuote !== 'string') reason = 'INVALID_QUOTE';
  else if (!item.sourceQuote.trim()) reason = 'EMPTY_QUOTE';
  else if (!page) reason = 'PAGE_NOT_FOUND';
  else reason = page.text.includes(item.sourceQuote) ? 'QUOTE_FOUND' : 'QUOTE_NOT_FOUND';
  if (diagnostic?.suspicious) warnings.push(...diagnostic.warnings);
  if (reason !== 'QUOTE_FOUND') warnings.push('Оригиналният цитат не е потвърден на посочената страница.');
  return {
    verificationStatus: reason === 'QUOTE_FOUND' ? 'verified' : 'unverified',
    verificationReason: reason,
    warnings,
  };
}

function verifySource(item, pages) {
  validatePages(pages);
  const page = pages.find((entry) => entry.pageNumber === item.pageNumber);
  return checkSource(item, page, page && diagnosePage(page));
}

const normalized = (text) => text.normalize('NFC').toLocaleLowerCase('bg').replace(/\s+/gu, ' ').trim();
function similarTitle(first, second) {
  const a = new Set(normalized(first).match(/[\p{L}\p{N}]+/gu) || []);
  const b = new Set(normalized(second).match(/[\p{L}\p{N}]+/gu) || []);
  if (!a.size || !b.size) {
    return false;
  }
  const overlap = [...a].filter((word) => b.has(word)).length;
  return overlap / new Set([...a, ...b]).size >= 0.8;
}

function compareItems(items) {
  const potentialDuplicates = [];
  const potentialConflicts = [];

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const first = items[i];
      const second = items[j];
      if (first.actorVerificationStatus === 'verified' && second.actorVerificationStatus === 'verified' &&
          canonicalRole(first.actor.role) !== canonicalRole(second.actor.role)) continue;
      if (first.verificationStatus !== 'verified' || second.verificationStatus !== 'verified' ||
          first.type !== second.type || !similarTitle(first.title, second.title)) continue;
      const itemIds = [first.id, second.id];
      const differentDates = first.deadline?.date && second.deadline?.date && first.deadline.date !== second.deadline.date;
      const differentLevels = first.obligationLevel !== second.obligationLevel;
      if (differentDates || differentLevels) {
        potentialConflicts.push({ itemIds, reason: differentDates ? 'DIFFERENT_EXPLICIT_DEADLINES' : 'DIFFERENT_OBLIGATION_LEVELS' });
        continue;
      }
      
      if (normalized(first.sourceQuote) === normalized(second.sourceQuote) &&
          JSON.stringify(first.deadline) === JSON.stringify(second.deadline)) {
        potentialDuplicates.push({ itemIds, reason: 'SAME_TYPE_QUOTE_OBLIGATION_AND_DEADLINE' });
      }
    }
  }
  return { potentialDuplicates, potentialConflicts };
}

function verifyAnalysis(input, pages) {
  const candidate = parseCandidateAnalysis(input);
  validatePages(pages);
  const pageDiagnostics = pages.map(diagnosePage);
  const byNumber = new Map(pages.map((page) => [page.pageNumber, page]));
  const diagnostics = new Map(pageDiagnostics.map((page) => [page.pageNumber, page]));
  const items = candidate.items.map((item) => {
    const source = checkSource(item, byNumber.get(item.pageNumber), diagnostics.get(item.pageNumber));
    const warnings = [...item.warnings, ...source.warnings];
    if (item.obligationLevel === 'unclear') warnings.push('Не е ясно дали текстът създава задължение.');
    if (item.deadline?.kind === 'relative') warnings.push('Относителният срок няма изчислена дата; необходимо е да се установи началното събитие.');
    if (item.deadline?.kind === 'ambiguous' || (item.deadline?.kind === 'absolute' && item.deadline.date === null)) warnings.push('Срокът няма еднозначно установена календарна дата.');
    const actor = verifyActor(item, pages);
    if (actor.actorVerificationStatus === 'unverified') warnings.push('Цитатът не потвърждава посочената страна. Отговорността остава за уточняване.');
    return { ...item, id: randomUUID(), ...source, ...actor, warnings: [...new Set(warnings)] };
  });
  const comparisons = compareItems(items);
  const warnings = [...candidate.warnings];
  if (pageDiagnostics.some((page) => page.suspicious)) warnings.push('Има страници със съмнения за непълно извличане. Анализът може да пропуска съдържание.');
  if (comparisons.potentialConflicts.length) warnings.push('Има потенциални противоречия. Находките са запазени отделно за преглед.');
  const result = { items, warnings: [...new Set(warnings)], pageDiagnostics, ...comparisons };
  if (!validateResultShape(result)) {
    throw new Error('Невалиден сървърен резултат от проверката.');
  }
  return result;
}

module.exports = { verifySource, verifyAnalysis, diagnosePage, validatePages, compareItems };
