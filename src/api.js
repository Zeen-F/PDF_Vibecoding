export async function api(path, options = {}) {
  const {headers, ...rest} = options;
  const response = await fetch(`/api${path}`, { ...rest, headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `请求未完成 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}
export const patchDocument = (id, body) => api(`/documents/${id}`, { method:'PATCH', body:JSON.stringify(body) });
