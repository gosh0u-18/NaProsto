(() => {
  const types = { deadline: 'Срок', requirement: 'Изискване', condition: 'Условие', document: 'Необходим документ', action: 'Действие' };
  const levels = { mandatory: 'Задължително', recommended: 'Препоръка', informational: 'Информация', unclear: 'Не е ясно дали е задължително' };
  const statuses = { complete: 'Предоставеният текст е обработен.', partial: 'Анализът е частичен — има пропуснато или несигурно съдържание.', failed: 'Анализът не е завършен успешно.' };
  const coverageLabels = { analyzed: 'Обработена', partial: 'Частично обработена', skipped: 'Пропусната' };
  const providers = { openai: 'OpenAI', gemini: 'Google Gemini' };
  function createElement(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function showWarnings(container, warnings) {
    container.replaceChildren();
    container.hidden = !warnings.length;
    if (!warnings.length) {
      return;
    }
    const list = createElement('ul');
    for (const warning of warnings) list.append(createElement('li', warning));
    container.append(list);
  }

  function create({ getFile, onBusy }) {
    function getElement(id) {
      return document.querySelector(`#${id}`);
    }
    let available = false;
    let mode = 'disabled';
    let busy = false;
    let externalBusy = false;
    let checking = false;
    let controller;
    let savedResult;
    let selectedRoleId = '';
    const completed = new Set();
    let personalTasks = [];

    function openPrintOptions() {
      if (!savedResult || busy || externalBusy) return;
      getElement('print-options-status').textContent = selectedRoleId ? '' : 'Няма избрана роля. Избери роля в задачите, ако искаш личен списък.';
      getElement('print-options').showModal();
    }

    function printSelectedContent() {
      if (!savedResult || busy || externalBusy) return;
      const includeSummary = getElement('print-summary-option').checked;
      const includeTasks = getElement('print-tasks-option').checked;
      const includeQuotes = getElement('print-quotes-option').checked;
      if (!includeSummary && !includeTasks && !includeQuotes) {
        getElement('print-options-status').textContent = 'Избери поне една част за печат.';
        return;
      }
      const analysis = savedResult.analysis;
      const report = getElement('print-report');
      report.replaceChildren();
      report.append(createElement('h1', 'НаПросто · Отчет'), createElement('h2', savedResult.documentName),
        createElement('p', statuses[analysis.status] || 'Провери статуса на анализа.'));
      const warnings = [...(analysis.warnings || []), 'Намереният цитат не гарантира правилно обяснение. Провери оригинала преди действие.'];
      if (analysis.status !== 'complete') warnings.push('Внимание: анализът не е пълен. Възможно е да липсва важна информация.');
      for (const page of analysis.pageCoverage || []) {
        if (page.status !== 'analyzed') warnings.push(`Страница ${page.pageNumber}: ${coverageLabels[page.status] || 'Непроверена'}.`);
      }
      for (const item of analysis.items) warnings.push(...(item.warnings || []));
      for (const point of analysis.insights?.reviewPoints || []) warnings.push(point.message);
      for (const page of analysis.pageDiagnostics || []) warnings.push(...(page.warnings || []));
      report.append(createElement('h2', 'Важно преди действие'));
      const warningList = createElement('ul');
      for (const warning of new Set(warnings)) warningList.append(createElement('li', warning));
      report.append(warningList);
      if (includeSummary) {
        report.append(createElement('h2', 'Обобщение'));
        const summary = analysis.insights?.documentSummary;
        if (summary) {
          report.append(createElement('p', summary.warning));
          for (const fact of summary.facts) {
            if (fact.verificationStatus === 'verified') report.append(createElement('p', `${fact.text} (стр. ${fact.pageNumber})`));
          }
          if (!summary.facts.length) report.append(createElement('p', 'Няма достатъчно проверени данни за обобщение.'));
        }
        if (analysis.insights?.summary) report.append(createElement('p', analysis.insights.summary.text));
      }
      if (includeTasks) {
        const role = analysis.insights?.roles?.find((role) => role.id === selectedRoleId);
        report.append(createElement('h2', role ? `Моите задачи · ${role.label}` : 'Моите задачи'));
        if (!role) report.append(createElement('p', 'Не е избрана роля. Не са включени лични задачи.'));
        else if (!personalTasks.length) report.append(createElement('p', 'Няма потвърдени задачи за тази роля.'));
        for (const item of personalTasks) {
          const entry = createElement('div', undefined, 'print-entry');
          entry.append(createElement('h3', `${completed.has(item.id) ? '☑' : '☐'} ${item.title}`),
            createElement('p', item.explanation), createElement('p', `Страница ${item.pageNumber} · ${item.deadline ? item.deadline.originalText : 'Не е посочен срок'}`));
          report.append(entry);
        }
      }
      if (includeQuotes) {
        report.append(createElement('h2', 'Оригинални цитати'));
        const quotes = analysis.items.map((item) => ({ ...item, text: item.title }));
        if (includeSummary) quotes.push(...(analysis.insights?.documentSummary?.facts || []));
        const seen = new Set();
        for (const entry of quotes) {
          const key = JSON.stringify([entry.pageNumber, entry.sourceQuote]);
          if (!entry.sourceQuote || seen.has(key)) continue;
          seen.add(key);
          const block = createElement('div', undefined, 'print-entry');
          block.append(createElement('h3', `${entry.text} · стр. ${entry.pageNumber}`),
            createElement('p', entry.verificationStatus === 'verified' ? 'Цитатът е намерен в текста.' : 'Внимание: цитатът не е потвърден.'),
            createElement('blockquote', entry.sourceQuote));
          report.append(block);
        }
        if (!seen.size) report.append(createElement('p', 'Няма цитати за показване.'));
      }
      getElement('print-options').close();
      report.hidden = false;
      window.print();
    }

    function renderTasks(analysis) {
      const byId = new Map(analysis.items.map((item) => [item.id, item]));
      const eligible = (item) => item && item.verificationStatus === 'verified' && item.obligationLevel === 'mandatory'
        && ['action', 'requirement', 'document'].includes(item.type);
      const candidates = analysis.insights ? analysis.insights.nextSteps.map((step) => byId.get(step.findingId)).filter(eligible)
        : analysis.items.filter(eligible);
      const roles = analysis.insights?.roles || [];
      const selected = roles.find((role) => role.id === selectedRoleId);
      const assigned = (item) => item.actorVerificationStatus === 'verified' && roles.some((role) => role.findingIds.includes(item.id));
      const tasks = selected ? candidates.filter((item) => assigned(item) && selected.findingIds.includes(item.id)) : [];
      personalTasks = tasks;
      const progress = () => { getElement('tasks-progress').textContent = `${tasks.filter((item) => completed.has(item.id)).length} от ${tasks.length} изпълнени`; };
      getElement('role-status').textContent = selected ? `Избрана роля: ${selected.label}. Провери дали тя съответства на твоята страна в документа.`
        : roles.length ? 'Избери своята роля, за да видиш личния списък със задачи.' : 'Няма потвърдена роля. Действията остават за уточняване.';
      getElement('analysis-tasks').replaceChildren();
      for (const item of tasks) {
        const label = createElement('label', undefined, 'task-row');
        const checkbox = createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = completed.has(item.id);
        label.classList.toggle('completed', checkbox.checked);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) completed.add(item.id); else completed.delete(item.id);
          label.classList.toggle('completed', checkbox.checked);
          progress();
        });
        const content = createElement('span');
        content.append(createElement('strong', item.title), createElement('small', `Страница ${item.pageNumber}${item.deadline ? ` · ${item.deadline.originalText}` : ' · Не е посочен срок'}`));
        label.append(checkbox, content);
        getElement('analysis-tasks').append(label);
      }
      if (!tasks.length) getElement('analysis-tasks').append(createElement('p', selected ? 'Няма потвърдени задачи за тази роля.' : 'Личният списък очаква избор на роля.', 'empty-state'));
      for (const [id, entries] of [
        ['unassigned-tasks', candidates.filter((item) => !assigned(item))],
        ['other-party-tasks', candidates.filter((item) => assigned(item) && !tasks.includes(item))],
      ]) {
        getElement(id).replaceChildren();
        for (const item of entries) {
          const link = createElement('button', `${item.title}${assigned(item) ? ` · ${item.actor.role}` : ''} · стр. ${item.pageNumber}`, 'button text-button');
          link.type = 'button';
          link.addEventListener('click', () => document.getElementById(`finding-${item.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
          getElement(id).append(link);
        }
        if (!entries.length) getElement(id).append(createElement('p', 'Няма действия в тази група.', 'task-help'));
      }
      progress();
    }

    function updateButton() {
      getElement('analyze-document').disabled = checking || busy || externalBusy || !available || !getElement('analysis-consent').checked || !getFile();
      getElement('retry-analysis').disabled = getElement('analyze-document').disabled;
      getElement('analysis-consent').disabled = checking || busy || externalBusy || !available;
      getElement('refresh-analysis').disabled = checking || busy || externalBusy;
    }
    async function refreshCapabilities() {
      if (checking) {
        return;
      }
      checking = true;
      updateButton();
      try {
        const response = await fetch('/api/capabilities', { cache: 'no-store' });
        if (response.status === 404) {
          throw Object.assign(new Error('Old server'), { code: 'OLD_SERVER' });
        }
        if (!response.ok) {
          throw Object.assign(new Error('Server unavailable'), { code: 'SERVER_UNAVAILABLE' });
        }
        let data;
        try { data = await response.json(); } catch { throw Object.assign(new Error('Invalid configuration response'), { code: 'INVALID_CAPABILITIES' }); }
        if (!data?.analysis || typeof data.analysis.enabled !== 'boolean' || !['disabled', 'mock', 'openai', 'gemini'].includes(data.analysis.mode)) {
          throw Object.assign(new Error('Invalid configuration response'), { code: 'INVALID_CAPABILITIES' });
        }
        if (available !== data.analysis.enabled || mode !== data.analysis.mode) getElement('analysis-consent').checked = false;
        available = data.analysis.enabled;
        mode = data.analysis.mode;
        const provider = providers[mode] || 'избрания AI доставчик';
        getElement('analysis-availability').textContent = !available
          ? 'AI анализът не е настроен. Добави ключ и модел в .env на сървъра и включи изрично реалните заявки. Не поставяй ключа в страницата.'
          : mode === 'mock' ? 'Демонстрационен режим: няма реален AI анализ или платени заявки.'
            : `AI анализът е активен. Ще изпратим текста към ${provider} след потвърждението ти.`;
        getElement('analysis-consent-label').textContent = mode === 'mock'
          ? 'Разбирам, че това е демонстрация с mock отговори, а не истински анализ.'
          : `Разрешавам извлеченият текст да бъде изпратен към ${provider} за анализ. Услугата може да има разход.`;
      } catch (error) {
        available = false;
        getElement('analysis-consent').checked = false;
        const messages = {
          OLD_SERVER: 'Работи стара версия на сървъра. Спри я с Ctrl+C, стартирай npm.cmd start и натисни „Провери настройките отново“.',
          SERVER_UNAVAILABLE: 'Сървърът отговори с грешка при проверката на настройките. Опитай отново след малко.',
          INVALID_CAPABILITIES: 'Сървърът върна непознат отговор за настройките. Рестартирай го с npm.cmd start и провери отново.',
        };
        getElement('analysis-availability').textContent = messages[error.code] || 'Няма връзка със сървъра. Провери връзката и опитай отново.';
      } finally {
        checking = false;
        updateButton();
      }
    }

    function renderOverview(analysis) {
      const byId = new Map(analysis.items.map((item) => [item.id, item]));
      getElement('analysis-overview').hidden = !analysis.insights;
      getElement('overview-points').replaceChildren();
      getElement('review-points').replaceChildren();
      getElement('document-context-summary').replaceChildren();
      const documentSummary = analysis.insights?.documentSummary;
      if (documentSummary) {
        const labels = { documentType: 'Вид на документа', purpose: 'Цел', party: 'Страна', keyTerm: 'Основно условие' };
        getElement('document-context-summary').append(createElement('h4', 'За какво е документът?'));
        getElement('document-context-summary').append(createElement('p', documentSummary.status === 'partial' ? 'Частично обобщение — има пропуснат или непотвърден текст.'
          : documentSummary.status === 'unavailable' ? 'Няма достатъчно данни за съдържателно обобщение.' : 'Обобщение по намерените цитати.', 'task-help'));
        for (const fact of documentSummary.facts) {
          if (fact.verificationStatus !== 'verified') {
            continue;
          }
          const section = createElement('div');
          section.append(createElement('strong', labels[fact.kind] || 'Информация'), createElement('p', fact.text));
          const source = createElement('details', undefined, 'source-quote');
          source.append(createElement('summary', `Цитат · страница ${fact.pageNumber}`), createElement('blockquote', fact.sourceQuote));
          const link = createElement('button', 'Към оригиналния текст', 'button text-button');
          link.type = 'button';
          link.addEventListener('click', () => {
            const extracted = getElement('extracted-text');
            if (extracted) extracted.open = true;
            document.getElementById(`page-${fact.pageNumber}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
          source.append(link); section.append(source); getElement('document-context-summary').append(section);
        }
        for (const kind of documentSummary.missingKinds) getElement('document-context-summary').append(createElement('p', `${labels[kind]}: няма потвърдена информация.`, 'task-help'));
        if (documentSummary.rejectedCount) getElement('document-context-summary').append(createElement('p', `${documentSummary.rejectedCount} твърдения са пропуснати поради непотвърдени цитати.`, 'item-warning'));
        getElement('document-context-summary').append(createElement('p', documentSummary.warning, 'task-help'));
      }
      if (analysis.insights) {
        getElement('overview-description').textContent = analysis.insights.summary.text;
        for (const id of analysis.insights.summary.keyFindingIds) {
          const item = byId.get(id);
          if (!item || item.verificationStatus !== 'verified') {
            continue;
          }
          getElement('overview-points').append(createElement('li', `${item.title}: ${item.explanation} (стр. ${item.pageNumber})`));
        }
        for (const point of analysis.insights.reviewPoints) {
          const paragraph = createElement('p', point.message);
          for (const id of point.findingIds) {
            const item = byId.get(id);
            if (!item) {
              continue;
            }
            const link = createElement('button', `${item.title} · стр. ${item.pageNumber}`, 'button text-button');
            link.type = 'button';
            link.addEventListener('click', () => document.getElementById(`finding-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
            paragraph.append(link);
          }
          getElement('review-points').append(paragraph);
        }
        if (!analysis.insights.reviewPoints.length) getElement('review-points').append(createElement('p', 'Автоматичните проверки не откриха допълнителни точки за внимание. Това не замества прочитането на оригинала.', 'task-help'));
      }
    }

    function renderFindings(analysis) {
      if (!analysis.items.length) getElement('analysis-items').append(createElement('p', analysis.mode === 'mock'
        ? 'Mock клиентът не извършва истински анализ. За реални резултати настрой AI услугата.'
        : analysis.status === 'complete' ? 'Не са открити структурирани изисквания. Прегледай и оригиналния документ.' : 'Няма надежден завършен резултат. Прегледай предупрежденията и опитай с по-кратък документ.', 'empty-state'));
      for (const item of analysis.items) {
        const card = createElement('article', undefined, 'analysis-card');
        card.id = `finding-${item.id}`;
        const badges = createElement('div', undefined, 'badges');
        badges.append(createElement('span', types[item.type] || item.type, 'badge'), createElement('span', levels[item.obligationLevel] || 'Неясно', `badge level-${item.obligationLevel}`));
        card.append(badges, createElement('h4', item.title), createElement('p', item.explanation));
        if (item.deadline) card.append(createElement('p', `Срок: ${item.deadline.originalText}${item.deadline.date ? ` (${item.deadline.date})` : ' · Няма изчислена дата'}`, 'deadline'));
        card.append(createElement('p', item.verificationStatus === 'verified' ? '✓ Цитатът е намерен' : '⚠ Цитатът не е потвърден — провери източника', `verification ${item.verificationStatus}`));
        const details = createElement('details', undefined, 'source-quote');
        details.append(createElement('summary', `Източник · страница ${item.pageNumber}`), createElement('blockquote', item.sourceQuote));
        const source = createElement('button', 'Към текста на страницата', 'button text-button');
        source.type = 'button';
        source.addEventListener('click', () => {
          const extracted = document.querySelector('#extracted-text');
          if (extracted) extracted.open = true;
          document.getElementById(`page-${item.pageNumber}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        details.append(source);
        card.append(details);
        card.append(createElement('p', item.actorVerificationStatus === 'verified' && item.actor
          ? `Кой действа: ${item.actor.role}. Ролята е спомената в цитата. Провери дали това действие се отнася за нея.`
          : 'Не е ясно кой трябва да изпълни това действие.', 'task-help'));
        for (const warning of item.warnings || []) card.append(createElement('p', warning, 'item-warning'));
        getElement('analysis-items').append(card);
      }
    }

    function render(data) {
      savedResult = data;
      completed.clear();
      selectedRoleId = '';
      const analysis = data.analysis;
      const needsRetry = analysis.status === 'failed' || (analysis.status === 'partial' && !analysis.items.length);
      getElement('analysis-retry').hidden = !needsRetry;
      updateButton();
      getElement('user-role').replaceChildren(createElement('option', 'Избери роля…'));
      getElement('user-role').children[0].value = '';
      for (const role of analysis.insights?.roles || []) {
        const option = createElement('option', role.label);
        option.value = role.id;
        getElement('user-role').append(option);
      }
      getElement('user-role').value = '';
      getElement('user-role').disabled = !analysis.insights?.roles?.length;
      getElement('analysis-summary').textContent = `${data.documentName} · ${statuses[analysis.status] || 'Непознат статус.'}${analysis.mode === 'mock' ? ' Демонстрационен mock режим.' : providers[analysis.mode] ? ` Доставчик: ${providers[analysis.mode]}.` : ''}`;
      const warnings = [...(analysis.warnings || []), 'Намереният цитат показва откъде е обяснението. Това не гарантира, че обяснението е правилно. Провери текста на документа.'];
      for (const chunk of analysis.chunks || []) {
        for (const issue of chunk.validationDiagnostics?.issues || []) {
          warnings.push(`AI част ${chunk.chunkId} · поле ${issue.field}: ${issue.message}`);
        }
        if (chunk.validationDiagnostics?.truncated) warnings.push(`AI част ${chunk.chunkId}: показани са първите 10 грешки при проверката.`);
      }
      if (analysis.extractionMethod === 'ocr') warnings.push('Източникът е OCR текст от снимка. Сравни всеки важен цитат със снимката.');
      if (analysis.potentialDuplicates?.length) warnings.push('Има потенциални дубликати. Находките са запазени отделно.');
      if (analysis.potentialConflicts?.length) warnings.push('Има потенциални противоречия — провери сроковете и условията.');
      showWarnings(getElement('analysis-warnings'), [...new Set(warnings)]);
      getElement('analysis-coverage').replaceChildren();
      for (const page of analysis.pageCoverage || []) {
        getElement('analysis-coverage').append(createElement('li', `Страница ${page.pageNumber}: ${coverageLabels[page.status] || 'Необработена'} (${page.processedCharacters} / ${page.totalCharacters} символа)`));
      }
      getElement('analysis-items').replaceChildren();
      getElement('analysis-tasks').replaceChildren();
      renderOverview(analysis);
      renderFindings(analysis);
      renderTasks(analysis);
      getElement('analysis-results').hidden = false;
      getElement('analysis-results').scrollIntoView?.({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    }

    async function run() {
      if (!available || busy || externalBusy || !getElement('analysis-consent').checked || !getFile()) {
        return;
      }
      busy = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 95000);
      onBusy(true);
      getElement('cancel-analysis').hidden = false;
      getElement('analysis-status').textContent = 'Извличане и анализ на оригиналния документ…';
      getElement('analysis-results').hidden = true;
      try {
        const form = new FormData();
        form.append('document', getFile());
        const response = await fetch('/api/documents/analyze', { method: 'POST', body: form, signal: controller.signal });
        const data = await response.json();
        if (data.analysis) {
          render(data);
          getElement('analysis-status').textContent = statuses[data.analysis.status] || 'Провери резултата.';
        } else getElement('analysis-status').textContent = data.error?.message || 'Анализът не е достъпен. Опитай отново.';
      } catch (error) {
        getElement('analysis-status').textContent = error.name === 'AbortError' ? 'Анализът е прекратен или времето е изтекло.' : 'Няма връзка със сървъра. Опитай отново.';
      } finally {
        clearTimeout(timeout);
        busy = false;
        controller = undefined;
        getElement('cancel-analysis').hidden = true;
        onBusy(false);
        updateButton();
      }
    }
    getElement('analysis-consent').addEventListener('change', updateButton);
    getElement('user-role').addEventListener('change', () => {
      selectedRoleId = getElement('user-role').value;
      if (savedResult) renderTasks(savedResult.analysis);
    });
    getElement('analyze-document').addEventListener('click', run);
    getElement('retry-analysis').addEventListener('click', run);
    getElement('cancel-analysis').addEventListener('click', () => controller?.abort());
    getElement('refresh-analysis').addEventListener('click', refreshCapabilities);
    getElement('print-analysis').addEventListener('click', openPrintOptions);
    getElement('export-analysis').addEventListener('click', () => {
      if (!savedResult) return;
      const file = new Blob([JSON.stringify(savedResult, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(file);
      const link = createElement('a');
      link.href = url;
      link.download = 'naprosto-analysis.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    getElement('cancel-print').addEventListener('click', () => getElement('print-options').close());
    getElement('confirm-print').addEventListener('click', printSelectedContent);
    window.addEventListener?.('afterprint', () => {
      getElement('print-report').hidden = true;
      getElement('print-report').replaceChildren();
    });
    const ready = refreshCapabilities();
    return {
      ready, render,
      setExternalBusy(value) { externalBusy = value; updateButton(); },
      reset() {
        savedResult = undefined;
        personalTasks = [];
        getElement('print-report').hidden = true;
        getElement('print-report').replaceChildren();
        if (getElement('print-options').open) getElement('print-options').close();
        getElement('analysis-retry').hidden = true;
        completed.clear();
        getElement('analysis-results').hidden = true;
        getElement('analysis-actions').hidden = true;
        getElement('analysis-consent').checked = false;
        getElement('analysis-status').textContent = '';
        updateButton();
      },
      fileReady() {
        getElement('analysis-actions').hidden = false;
        updateButton();
        if (!available && !checking) refreshCapabilities();
      },
    };
  }
  window.DocumentAnalysisUI = { create };
})();
