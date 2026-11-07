const { collectRoles } = require('./actors');
const { buildDocumentSummary } = require('./summary');

function buildInsights(analysis, { pages = [] } = {}) {
  const items = analysis.items || [];
  const verified = items.filter((item) => item.verificationStatus === 'verified');
  const conflictIds = new Set((analysis.potentialConflicts || []).flatMap((pair) => pair.itemIds));
  const byId = new Map(items.map((item) => [item.id, item]));
  const topics = [];
  function review(code, message, ids = []) {
    topics.push({ code, message, findingIds: [...new Set(ids)].filter((id) => byId.has(id)) });
  }
  if (analysis.status !== 'complete') review('INCOMPLETE_ANALYSIS', 'Анализът не покрива надеждно целия документ. Провери пропуснатите страници и предупрежденията.');
  const unverified = items.filter((item) => item.verificationStatus !== 'verified');
  if (unverified.length) review('UNVERIFIED_FINDINGS', 'Не намерихме цитат за някои от обясненията. Провери ги в документа, преди да действаш.', unverified.map((item) => item.id));
  if (conflictIds.size) review('POTENTIAL_CONFLICTS', 'Някои условия или срокове може да си противоречат. Уточни кое важи за твоя случай. Не избираме вместо теб.', [...conflictIds]);
  const duplicates = (analysis.potentialDuplicates || []).flatMap((pair) => pair.itemIds);
  if (duplicates.length) review('POTENTIAL_DUPLICATES', 'Някои точки си приличат. Оставили сме ги отделно, защото може да важат при различни условия.', duplicates);
  const relative = verified.filter((item) => item.deadline?.kind === 'relative');
  if (relative.length) review('RELATIVE_DEADLINES', 'Уточни кога настъпва началното събитие на относителните срокове. Календарни дати не са изчислени.', relative.map((item) => item.id));
  const ambiguous = verified.filter((item) => item.deadline && (item.deadline.kind === 'ambiguous' || item.deadline.date === null && item.deadline.kind === 'absolute'));
  if (ambiguous.length) review('AMBIGUOUS_DEADLINES', 'Има срокове без еднозначна календарна дата. Провери липсващата година, формулировката или алтернативите.', ambiguous.map((item) => item.id));
  const unclear = verified.filter((item) => item.obligationLevel === 'unclear');
  if (unclear.length) review('UNCLEAR_OBLIGATIONS', 'Не е ясно дали някои формулировки са задължителни. Не ги превръщаме автоматично в задачи.', unclear.map((item) => item.id));

  const keywordTopics = [
    ['FINANCIAL_TERMS', /(?:^|[^\p{L}])(?:(?:неустойк|лихв|санкц|плащ|заплащ|възнагражд)[\p{L}]*|такс(?:а|ата|и|ите|уване|уването)|цен(?:а|ата|и|ите))(?=$|[^\p{L}])/iu,
      'Прегледай финансовите условия: размери, основания и срокове за плащане, ако са посочени.'],
    ['TERMINATION_TERMS', /(?:^|[^\p{L}])(?:прекрат|отказ|предизвест)[\p{L}]*/iu,
      'Прегледай условията за прекратяване, отказ или предизвестие в техния пълен контекст.'],
    ['DATA_CONSENT', /лични\s+данни|съгласи[ея]/iu,
      'Прочети какво съгласие се изисква и какви условия за личните данни са описани.'],
  ];
  for (const [code, pattern, message] of keywordTopics) {
    const matches = verified.filter((item) => pattern.test(item.sourceQuote));
    if (matches.length) review(code, message, matches.map((item) => item.id));
  }
  if (analysis.extractionMethod === 'ocr' || pages.some((page) => page.extractionMethod === 'ocr')) {
    review('OCR_SOURCE', 'Сравни важните имена, числа и срокове със снимката; OCR текстът може да съдържа грешки.');
  }

  const actionable = verified.filter((item) => item.obligationLevel === 'mandatory' &&
    ['action', 'requirement', 'document'].includes(item.type) && !conflictIds.has(item.id));
  const rank = (item) => item.deadline?.date ? 0 : item.deadline?.kind === 'relative' ? 1 : 2;
  const sorted = [...actionable].sort((first, second) => rank(first) - rank(second) ||
    (first.deadline?.date || '').localeCompare(second.deadline?.date || '') || first.pageNumber - second.pageNumber);
  const nextSteps = sorted.map((item) => ({
    findingId: item.id,
    reason: item.deadline?.date ? 'EXPLICIT_DATE' : item.deadline?.kind === 'relative' ? 'RELATIVE_DEADLINE' : item.deadline ? 'UNCLEAR_DATE' : 'NO_DEADLINE',
  }));
  const roles = collectRoles(items);
  const assigned = new Set(roles.flatMap((role) => role.findingIds));
  const unassignedFindingIds = actionable.filter((item) => !assigned.has(item.id)).map((item) => item.id);
  if (unassignedFindingIds.length) review('UNCLEAR_ACTOR', 'За някои действия не е потвърдено коя страна трябва да ги изпълни. Те остават за уточняване.', unassignedFindingIds);
  const keyFindingIds = [...new Set([...nextSteps.map((step) => step.findingId),
    ...verified.filter((item) => !conflictIds.has(item.id)).map((item) => item.id)])].slice(0, 5);
  const coverage = analysis.pageCoverage || [];
  const completePages = coverage.filter((page) => page.status === 'analyzed').length;
  return {
    documentSummary: buildDocumentSummary(analysis),
    summary: {
      text: items.length
        ? `Открихме ${items.length === 1 ? '1 важна точка' : `${items.length} важни точки`}. С намерен цитат: ${verified.length}. Действия за списъка със задачи: ${nextSteps.length}, според избраната роля. ${analysis.status !== 'complete' ? 'Анализът е непълен. Част от текста не е проверена надеждно. Прегледай предупрежденията.' : 'Провери условията и цитатите, преди да действаш.'}`
        : analysis.status === 'complete' ? 'Не открихме изисквания или действия в проверения текст. Възможно е да сме пропуснали нещо. Прочети и документа.'
          : 'Няма достатъчен завършен резултат за обобщение. Провери причините за непълния анализ.',
      keyFindingIds,
      completePages,
      totalPages: coverage.length,
    },
    nextSteps,
    roles,
    unassignedFindingIds,
    reviewPoints: topics,
  };
}

module.exports = { buildInsights };
