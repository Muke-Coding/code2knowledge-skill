#!/usr/bin/env node
import { ensureConfig } from './lib/config.mjs';
try {
  const configPath = await ensureConfig();
  console.log(`Code2Knowledge 通知配置已就绪（保留已有配置）：${configPath}；模板默认关闭通知。`);
} catch {
  console.warn('Code2Knowledge 无法初始化通知模板；运行 code2knowledge 注册时将重试。');
}
