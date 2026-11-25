'use strict';
// This public page never downloads the dashboard script or any management data.
const form = document.querySelector('#access-form');
const errorNode = document.querySelector('#access-error');
const button = document.querySelector('#access-submit');
let setup = false;
let available = false;

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!available || button.disabled) return;
  button.disabled = true;
  errorNode.textContent = '';
  try {
    const response = await fetch(setup ? '/api/auth/bootstrap' : '/api/auth/admin/login', {
      method: 'POST', credentials: 'same-origin',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({username: document.querySelector('#access-user').value,
        password: document.querySelector('#access-password').value,
        setupCode: document.querySelector('#access-code').value, client: 'web'}),
      signal: AbortSignal.timeout(30000)
    });
    const result = await response.json();
    document.querySelector('#access-password').value = '';
    document.querySelector('#access-code').value = '';
    if (!response.ok) throw new Error(result.error?.message || '管理员登录失败');
    if (result.user?.role !== 'admin') throw new Error('账号没有管理权限');
    location.replace('/admin/');
  } catch (error) {
    errorNode.textContent = error.message === 'Failed to fetch'
      ? '连接已断开。请在Windows文件资源管理器双击“打开管理端.cmd”启动后台服务，再刷新。' : error.message;
  } finally { button.disabled = false; }
});

(async () => {
  if (location.protocol === 'file:') {
    errorNode.textContent = '请完整解压后双击“启动管理端.cmd”，不要直接打开HTML文件。';
    return;
  }
  try {
    const response = await fetch('/api/auth/status', {credentials: 'same-origin', signal: AbortSignal.timeout(8000)});
    const status = await response.json();
    if (!response.ok || status.app !== 'zhixing-campus' || !/^1\.2\.\d+$/.test(status.version) || Number(status.version.split('.')[2]) < 5) {
      throw new Error('请关闭旧版服务，再从当前版本的完整解压目录启动。');
    }
    if (status.authenticated && status.user?.role === 'admin') { location.replace('/admin/'); return; }
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
    setup = !!status.setupNeeded && local;
    if (status.setupNeeded && !local) {
      errorNode.textContent = '管理员尚未初始化，请在电脑本机打开管理端并使用启动窗口的一次性设置码完成初始化。';
      button.textContent = '请先在电脑本机初始化';
      return;
    }
    document.querySelector('#access-setup').hidden = !setup;
    document.querySelector('#access-title').textContent = setup ? '首次管理员初始化（仅本机）' : '管理员专属登录';
    document.querySelector('#access-password').autocomplete = setup ? 'new-password' : 'current-password';
    button.textContent = setup ? '验证设置码并创建管理员' : '登录管理端';
    if (setup) errorNode.textContent = '这是受设置码保护的一次性初始化，不是普通用户注册。';
    else if (status.authenticated) errorNode.textContent = '当前是普通用户会话，没有管理权限。请输入管理员账号。';
    available = true;
    button.disabled = false;
  } catch (error) {
    errorNode.textContent = '请在Windows文件资源管理器中双击“打开管理端.cmd”，不要只在微信编辑器内查看。服务日志位于server/storage/logs/service.log。具体信息：' + (error.message || '无法连接');
    button.textContent = '服务未运行，请启动后刷新';
  }
})();
