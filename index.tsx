import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// 全局 Fetch 拦截器 - 用于调试 Supabase 请求头
const originalFetch = window.fetch;
window.fetch = async (...args) => {
  const [resource, config] = args;
  
  // 只拦截发往 Supabase 的请求
  if (typeof resource === 'string' && resource.includes('supabase.co')) {
    console.log('--- SUPABASE FETCH INTERCEPTOR ---');
    console.log('URL:', resource);
    console.log('Method:', config?.method || 'GET');
    
    // 打印 Headers 确认 Key 是否存在
    if (config?.headers) {
      const headers = config.headers as Record<string, string>;
      console.log('Headers apikey:', headers['apikey'] ? `${headers['apikey'].substring(0, 10)}...` : 'MISSING');
      console.log('Headers Authorization:', headers['Authorization'] ? 'Bearer [PRESENT]' : 'MISSING');
    } else {
      console.warn('Headers: MISSING (No config or headers provided)');
    }
    console.log('--- END INTERCEPTOR ---');
  }
  
  return originalFetch(...args);
};

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
