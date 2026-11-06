/** 在扩展页面里把数据存成文件（浏览器下载，不经过网络） */
export function downloadBlob(filename: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** 在扩展页面里把文本存成文件 */
export function downloadText(filename: string, text: string, mime = 'text/markdown;charset=utf-8'): void {
  downloadBlob(filename, new Blob([text], { type: mime }));
}

export function openInCurrentTab(videoId: string): void {
  void chrome.tabs.update({ url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` });
}
