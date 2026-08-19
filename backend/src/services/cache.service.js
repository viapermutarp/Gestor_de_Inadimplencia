/**
 * Cache genérico em memória, com TTL por entrada. Pensado para respostas
 * de endpoints que dependem de uma chamada cara/sujeita a rate limit a um
 * serviço externo (ex.: GET /api/inadimplencia/resumo, que consulta a API
 * do Asaas) — não é um cache distribuído, vive só na memória do processo,
 * então se reinicia a cada deploy/restart e não é compartilhado entre
 * múltiplas instâncias da API.
 */

const armazenamento = new Map();

/** Retorna o valor cacheado em `chave`, ou `undefined` se ausente/expirado. */
function get(chave) {
  const registro = armazenamento.get(chave);
  if (!registro) return undefined;

  if (Date.now() >= registro.expiraEm) {
    armazenamento.delete(chave);
    return undefined;
  }

  return registro.valor;
}

/** Guarda `valor` em `chave`, expirando após `ttlMs` milissegundos. */
function set(chave, valor, ttlMs) {
  armazenamento.set(chave, { valor, expiraEm: Date.now() + ttlMs });
}

/** Limpa todo o cache — usado nos testes, para garantir estado conhecido. */
function clear() {
  armazenamento.clear();
}

module.exports = { get, set, clear };
