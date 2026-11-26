// Acceso mínimo a la API de GitHub para un repositorio privado.

export class GitHubError extends Error {
  constructor(status, detail, path) {
    super(GitHubError.describe(status, detail, path));
    this.status = status;
    this.detail = detail;
  }

  static describe(status, detail, path) {
    if (status === 0) return 'No hay conexión con GitHub.';
    if (status === 401) return 'GitHub no acepta el token: puede haber caducado o estar mal copiado. Crea uno nuevo y pégalo en Ajustes.';
    if (status === 403 && /rate limit/i.test(detail)) return 'GitHub ha limitado las peticiones por un rato. Vuelve a intentarlo en unos minutos.';
    if (status === 403) return 'El token no tiene permiso para este repositorio. Dale acceso a «Contents: Read and write».';
    if (status === 404) return path ? `No encuentro «${path}» en el repositorio.` : 'No encuentro el repositorio. Comprueba el usuario, el nombre y que el token tenga acceso a él.';
    if (status === 409) return 'El archivo cambió en GitHub mientras se guardaba.';
    return `GitHub respondió con un error ${status}.`;
  }
}

function b64encodeUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64decodeUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export class GitHub {
  constructor({ token, owner, repo, branch = 'main', apiBase = 'https://api.github.com' }) {
    Object.assign(this, { token, owner, repo, branch: branch || 'main', apiBase: apiBase.replace(/\/$/, '') });
  }

  async request(path, { method = 'GET', accept = 'application/vnd.github+json', body, signal } = {}) {
    const url = `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${path ? '/' + path : ''}`;
    const headers = { Accept: accept, Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new GitHubError(0, String(err));
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch { /* sin cuerpo */ }
      throw new GitHubError(res.status, detail);
    }
    return res;
  }

  /** Comprueba que el repositorio existe y es accesible. */
  async repoInfo() {
    return (await this.request('')).json();
  }

  /** Árbol completo de la rama: [{path, type, sha, size}] */
  async tree() {
    const res = await this.request(`git/trees/${encodeURIComponent(this.branch)}?recursive=1`);
    const data = await res.json();
    return { sha: data.sha, truncated: !!data.truncated, items: data.tree || [] };
  }

  /** Contenido de un blob por su sha (respuesta cruda, para leer en streaming). */
  blob(sha, signal) {
    return this.request(`git/blobs/${sha}`, { accept: 'application/vnd.github.raw+json', signal });
  }

  contentsPath(path) {
    return 'contents/' + path.split('/').map(encodeURIComponent).join('/');
  }

  /** Lee un JSON pequeño con su sha (para poder actualizarlo después). */
  async getJson(path) {
    const res = await this.request(`${this.contentsPath(path)}?ref=${encodeURIComponent(this.branch)}`);
    const meta = await res.json();
    if (meta.content && meta.encoding === 'base64') return { sha: meta.sha, data: JSON.parse(b64decodeUtf8(meta.content)) };
    const raw = await this.blob(meta.sha);
    return { sha: meta.sha, data: await raw.json() };
  }

  /** Crea un archivo nuevo (falla con 422 si ya existe). Devuelve su sha. */
  async createFile(path, text, message) {
    const body = { message, content: b64encodeUtf8(text), branch: this.branch };
    const res = await this.request(this.contentsPath(path), { method: 'PUT', body });
    return (await res.json()).content?.sha;
  }

  async deleteFile(path, sha, message) {
    await this.request(this.contentsPath(path), { method: 'DELETE', body: { message, sha, branch: this.branch } });
  }

  async putJson(path, data, sha, message) {
    const body = {
      message,
      content: b64encodeUtf8(JSON.stringify(data, null, 1) + '\n'),
      branch: this.branch,
    };
    if (sha) body.sha = sha;
    const res = await this.request(this.contentsPath(path), { method: 'PUT', body });
    const out = await res.json();
    return out.content?.sha;
  }
}
