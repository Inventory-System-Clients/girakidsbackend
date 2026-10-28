// Cliente da loja antiga (Krion/Firebase): as mesmas Cloud Functions que o
// painel de lá usa, só leitura. O login é o de um administrador de lá
// (guardado criptografado na configuração da sincronização).

const FUNCOES = () => process.env.LEGADO_FUNCTIONS_URL || "https://us-central1-girakids-5c1a0.cloudfunctions.net";
// Chave pública do app web do Firebase (a mesma que vai no site antigo).
const CHAVE_FIREBASE = () => process.env.LEGADO_FIREBASE_KEY || "AIzaSyDu4jcA7nvpsgAAOyRDVpwyaAGcx4XcnMo";
const TEMPO_LIMITE = 60 * 1000;

const STATUS_PEDIDOS = "AGUARDANDO PAGAMENTO,PENDENTE,PAGAMENTO CONFIRMADO,ENVIADO,CANCELADO,SEM ESTOQUE,CONFIRMADO,NF GERADA";

const comTempo = (ms) => AbortSignal.timeout(ms);

export const criarCliente = ({ email, senha }) => {
  let sessao = null; // { token, usuarioId, expiraEm }

  const entrar = async () => {
    const login = await fetch(`${FUNCOES()}/loginUser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: senha }),
      signal: comTempo(TEMPO_LIMITE),
    });
    const corpo = await login.json().catch(() => ({}));
    if (!login.ok || !corpo.customToken) {
      throw new Error(login.status === 401 || login.status === 403 || login.status === 400 ? "Login do sistema antigo recusado (confira e-mail e senha)." : `Sistema antigo não respondeu ao login (${login.status}).`);
    }
    const troca = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${CHAVE_FIREBASE()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: corpo.customToken, returnSecureToken: true }),
      signal: comTempo(TEMPO_LIMITE),
    });
    const token = await troca.json().catch(() => ({}));
    if (!troca.ok || !token.idToken) throw new Error("Não foi possível abrir a sessão no Firebase do sistema antigo.");
    sessao = {
      token: token.idToken,
      usuarioId: corpo.user?.id || email,
      usuarioNome: corpo.user?.full_name || null,
      // O token vale 1 h; renova com folga.
      expiraEm: Date.now() + (Number(token.expiresIn || 3600) - 300) * 1000,
    };
    return sessao;
  };

  const chamar = async (funcao, parametros = {}) => {
    for (let tentativa = 1; ; tentativa += 1) {
      if (!sessao || Date.now() > sessao.expiraEm) await entrar();
      const query = new URLSearchParams({ requesterUserId: sessao.usuarioId, ...parametros });
      let resposta;
      try {
        resposta = await fetch(`${FUNCOES()}/${funcao}?${query}`, {
          headers: { Authorization: `Bearer ${sessao.token}` },
          signal: comTempo(TEMPO_LIMITE),
        });
      } catch (error) {
        if (tentativa >= 3) throw new Error(`Sistema antigo sem resposta em ${funcao}: ${error.message}`);
        await new Promise((r) => setTimeout(r, 2000 * tentativa));
        continue;
      }
      if (resposta.ok) return resposta.json();
      if (resposta.status === 401) sessao = null;
      if (tentativa >= 3) throw new Error(`Sistema antigo respondeu ${resposta.status} em ${funcao}.`);
      await new Promise((r) => setTimeout(r, 2000 * tentativa));
    }
  };

  // Percorre todas as páginas (cursor).
  const listarTodos = async (funcao, parametros = {}, limite = 100) => {
    const itens = [];
    let cursor;
    let extra = {};
    do {
      const pagina = await chamar(funcao, { ...parametros, limit: String(limite), ...(cursor ? { cursor } : {}) });
      itens.push(...(pagina.items || []));
      const { items: _itens, nextCursor, ...resto } = pagina;
      extra = resto;
      cursor = nextCursor;
    } while (cursor);
    return { itens, extra };
  };

  return {
    entrar,
    produtos: async () => (await listarTodos("listProductsAdmin", { includeExcluded: "true", status: "all" })).itens,
    usuarios: async () => (await listarTodos("listUsersAdmin")).itens,
    transportadoras: async () => (await listarTodos("listCarriersAdmin")).itens,
    fornecedores: async () => (await listarTodos("listSuppliersAdmin")).itens,
    pedidos: async (desde) =>
      (
        await listarTodos("listOrdersHistory", {
          orderStatuses: STATUS_PEDIDOS,
          orderBySequence: "true",
          startDate: new Date(desde).toISOString(),
          endDate: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        })
      ).itens,
    orcamentos: async (desde) =>
      (
        await listarTodos("listOrdersHistory", {
          orderStatuses: "AGUARDANDO_ORCAMENTO",
          orderBySequence: "true",
          startDate: new Date(desde).toISOString(),
          endDate: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        })
      ).itens,
  };
};
