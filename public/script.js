const fileInput = document.querySelector('#pdf-file');
const filePrompt = document.querySelector('#file-prompt');
const dropzone = document.querySelector('#dropzone');

function showSelectedFile(file) {
  if (!file) return;

  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    filePrompt.textContent = 'Моля, избери PDF файл';
    fileInput.value = '';
    return;
  }

  filePrompt.textContent = `Избран файл: ${file.name}`;
}

fileInput.addEventListener('change', () => showSelectedFile(fileInput.files[0]));

for (const eventName of ['dragenter', 'dragover']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add('dragging');
  });
}

for (const eventName of ['dragleave', 'drop']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragging');
  });
}

dropzone.addEventListener('drop', (event) => showSelectedFile(event.dataTransfer.files[0]));
