const fileInput = document.querySelector('#pdf-file');
const filePrompt = document.querySelector('#file-prompt');
const dropzone = document.querySelector('#dropzone');

const uploadStatus = document.querySelector('#upload-status');
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 95_000;
const results = document.querySelector('#document-results');
const summary = document.querySelector('#document-summary');
const pages = document.querySelector('#document-pages');
let busy = false;
let selectedFile;
let activeController;
let previewUrl;
const cameraInput = document.querySelector('#camera-file');
const cancelUpload = document.querySelector('#cancel-upload');
const analysisUI = window.DocumentAnalysisUI?.create({ getFile: () => selectedFile, onBusy: updateBusy });

function updateBusy(value) {
  busy = value;
  fileInput.disabled = value;
  cameraInput.disabled = value;
  dropzone.classList.toggle('processing', value);
  dropzone.setAttribute('aria-busy', String(value));
  analysisUI?.setExternalBusy(value);
}

function clearPreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = undefined;
  document.querySelector('#photo-preview').hidden = true;
  document.querySelector('#photo-preview-image').src = '';
}

function setStatus(message, isError = false) {
  uploadStatus.textContent = message;
  uploadStatus.classList.toggle('error', isError);
}

function displayResult(result) {
  summary.textContent = `${result.documentName} · ${result.pageCount} страници`;
  const fragment = document.createDocumentFragment();
  for (const page of result.pages) {
    const article = document.createElement('article');
    article.className = 'page-result';
    article.id = `page-${page.pageNumber}`;
    const heading = document.createElement('h3');
    heading.textContent = `Страница ${page.pageNumber}${page.extractionMethod === 'ocr' ? ' · OCR от снимка' : ''}`;
    const text = document.createElement('p');
    text.className = 'page-text';
    text.textContent = page.text || 'На тази страница няма извлекаем текст.';
    article.append(heading, text);
    fragment.append(article);
  }
  pages.replaceChildren(fragment);
  document.querySelector('#extracted-text').open = result.pageCount <= 5;
  const warnings = result.warnings || [];
  const warningBox = document.querySelector('#extraction-warnings');
  warningBox.textContent = warnings.join(' ');
  warningBox.hidden = !warnings.length;
  results.hidden = false;
}

async function uploadFiles(files) {
  if (busy || !files.length) {
    return;
  }
  selectedFile = undefined;
  analysisUI?.reset();
  clearPreview();
  results.hidden = true;
  pages.replaceChildren();
  if (files.length !== 1) {
    setStatus('Избери само един PDF файл или една снимка.', true);
    return;
  }
  const file = files[0];
  filePrompt.textContent = `Избран файл: ${file.name}`;
  if (file.size > MAX_FILE_BYTES) {
    setStatus('Файлът надвишава разрешения размер от 10 MB.', true);
    fileInput.value = '';
    return;
  }
  updateBusy(true);
  cancelUpload.hidden = false;
  setStatus('Качване и извличане на текста… При снимка се изпълнява OCR за български и английски.');
  const controller = new AbortController();
  activeController = controller;
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append('document', file);
    const response = await fetch('/api/documents/upload', {
      method: 'POST', body: form, signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) {
      setStatus(data.error?.message || 'Неуспешна обработка. Опитай отново.', true);
      return;
    }
    displayResult(data);
    selectedFile = file;
    if (data.sourceType === 'photo' && typeof URL !== 'undefined' && URL.createObjectURL) {
      previewUrl = URL.createObjectURL(file);
      document.querySelector('#photo-preview-image').src = previewUrl;
      document.querySelector('#photo-preview').hidden = false;
    }
    analysisUI?.fileReady();
    setStatus('Текстът е извлечен успешно. Виж резултата по-долу.');
  } catch (error) {
    setStatus(error.name === 'AbortError'
      ? 'Обработката е прекратена или времето е изтекло. Опитай с по-кратък документ или по-ясна снимка.'
      : 'Няма връзка със сървъра или отговорът е невалиден. Опитай отново.', true);
  } finally {
    clearTimeout(timeout);
    activeController = undefined;
    cancelUpload.hidden = true;
    updateBusy(false);
    fileInput.value = '';
    cameraInput.value = '';
  }
}

fileInput.setAttribute('aria-describedby', 'upload-help upload-status');
fileInput.addEventListener('change', () => uploadFiles(fileInput.files));
cameraInput.addEventListener('change', () => uploadFiles(cameraInput.files));
cancelUpload.addEventListener('click', () => activeController?.abort());

for (const eventName of ['dragenter', 'dragover']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    if (!busy) dropzone.classList.add('dragging');
  });
}

for (const eventName of ['dragleave', 'drop']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragging');
  });
}

dropzone.addEventListener('drop', (event) => uploadFiles(event.dataTransfer.files));
