const BASE = '/api';

export async function api(method, path, body) {
  const headers = {};
  let processedBody = undefined;

  if (body instanceof FormData) {
    processedBody = body;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    processedBody = JSON.stringify(body);
  }

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: processedBody
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }

  return res.json();
}

export const get = (path) => api('GET', path);
export const post = (path, body) => api('POST', path, body);
export const put = (path, body) => api('PUT', path, body);
export const patch = (path, body) => api('PATCH', path, body);
export const del = (path) => api('DELETE', path);
