(() => {
  const status = document.querySelector('#connection-status');
  const install = document.querySelector('#install-app');
  let installPrompt;
  function updateConnection() {
    status.hidden = navigator.onLine;
    status.textContent = 'Няма интернет връзка. Можеш да отвориш приложението, но за OCR и анализ е нужна връзка със сървъра.';
  }
  window.addEventListener('online', updateConnection);
  window.addEventListener('offline', updateConnection);
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    install.hidden = false;
  });
  install.addEventListener('click', async () => {
    if (!installPrompt) {
      return;
    }
    await installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = undefined;
    install.hidden = true;
  });
  window.addEventListener('appinstalled', () => { install.hidden = true; installPrompt = undefined; });
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  updateConnection();
})();
