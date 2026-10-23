// 红线：测试中不得发出真实网络请求。任何未被注入 mock 的 fetch 都会立刻失败。
const blocked = (input: unknown) => {
  throw new Error(`测试中禁止真实网络请求：${String(input instanceof Request ? input.url : input)}`);
};
globalThis.fetch = blocked as typeof fetch;
