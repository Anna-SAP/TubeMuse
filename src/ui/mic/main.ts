// 麦克风授权页：在标签页中请求一次麦克风权限（侧边栏无法弹出授权框）。
// 只申请权限，拿到后立刻关闭音轨，不录音、不保存任何音频。

export {};

const btn = document.getElementById('grant') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLElement;

function show(msg: string, kind: 'ok' | 'error' | 'info') {
  statusEl.textContent = msg;
  statusEl.className = `notice notice-${kind}`;
}

async function refresh() {
  try {
    const s = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    if (s.state === 'granted') show('已经授权。可以关掉这个标签页，回到侧边栏使用语音输入。', 'ok');
    else if (s.state === 'denied') show('麦克风已被拒绝。请点地址栏左侧的图标（或 chrome://settings/content/microphone）把本扩展改为"允许"，再刷新本页。', 'error');
  } catch {
    // 部分环境不支持查询，忽略
  }
}

btn.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of stream.getTracks()) t.stop();
    show('授权成功。可以关掉这个标签页，回到侧边栏使用语音输入。', 'ok');
  } catch (e) {
    const name = e instanceof DOMException ? e.name : '';
    show(
      name === 'NotFoundError' ? '没有找到可用的麦克风设备。' : '没有拿到麦克风权限。如果没有看到授权弹窗，请在浏览器设置里允许本扩展使用麦克风。',
      'error',
    );
  }
});

void refresh();
