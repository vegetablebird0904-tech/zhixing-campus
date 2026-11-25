'use strict';
// The server already requires admin role before serving the dashboard and this script.
window.campusSession = null;
let readyResolve;
window.campusReady = new Promise(resolve => { readyResolve = resolve; });
window.campusRequireLogin = () => {
  window.campusSession = null;
  document.body.classList.add('access-locked');
  location.replace('/admin/login.html');
};
document.querySelector('#admin-logout').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/auth/logout', {
      method: 'POST', credentials: 'same-origin',
      headers: {'content-type': 'application/json', 'X-Campus-CSRF': window.campusSession?.csrf || ''},
      body: '{}', signal: AbortSignal.timeout(10000)
    });
    if (!response.ok && response.status !== 401) throw new Error('退出失败，请检查服务连接后重试');
    window.campusRequireLogin();
  } catch (error) { alert(error.message); }
});
(async () => {
  if (location.protocol === 'file:') {
    document.querySelector('#session-loading').textContent = '请完整解压后运行“启动管理端.cmd”，不要直接打开HTML文件。';
    return;
  }
  try {
    const response = await fetch('/api/auth/status', {credentials: 'same-origin', signal: AbortSignal.timeout(8000)});
    const status = await response.json();
    if (!response.ok || !status.authenticated || status.user?.role !== 'admin') return window.campusRequireLogin();
    window.campusSession = status;
    document.querySelector('#session-name').textContent = status.user.name + ' · 管理员';
    document.querySelector('#session-loading').hidden = true;
    document.body.classList.remove('access-locked');
    readyResolve();
  } catch (error) {
    document.querySelector('#session-loading').textContent = '无法验证管理员会话，请确认服务已启动后刷新。';
  }
})();
