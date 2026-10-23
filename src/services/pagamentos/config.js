import crypto from "crypto";
import { CredencialPagamento } from "../../models/index.js";
import { lerConfiguracao, salvarConfiguracao } from "../../models/Configuracao.js";
import { decifrarCredenciais } from "../../utils/cofreCredenciais.js";

// Configuração dos pagamentos (aba Pagamentos), mantida em memória para o
// checkout consultar sem ir ao banco: qual provedor cobra cada canal, as
// credenciais (decifradas só aqui dentro) e as maquininhas cadastradas.
//   canal "online": PIX/cartão no site; canal "maquininha": venda presencial.

const estado = { canais: { online: null, maquininha: null }, credenciais: {}, maquininhas: [], carregado: false };

export const carregarConfigPagamentos = async () => {
  const [canais, maquininhas, linhas] = await Promise.all([
    lerConfiguracao("pagamentoCanais", {}),
    lerConfiguracao("pagamentoMaquininhas", []),
    CredencialPagamento.findAll(),
  ]);
  const credenciais = {};
  for (const linha of linhas) {
    try {
      credenciais[linha.provedor] = decifrarCredenciais(linha.provedor, linha.dadosCifrados);
    } catch (error) {
      console.error(`[Pagamentos] Credencial de ${linha.provedor} ilegível (chave trocada ou dado alterado):`, error.message);
    }
  }
  estado.canais = { online: canais?.online || null, maquininha: canais?.maquininha || null };
  estado.maquininhas = Array.isArray(maquininhas) ? maquininhas : [];
  estado.credenciais = credenciais;
  estado.carregado = true;
  return estado;
};

export const configPagamentos = () => estado;
export const credenciaisDe = (provedor) => estado.credenciais[provedor] || null;
export const provedorDoCanal = (canal) => estado.canais[canal] || null;

export const salvarCanais = async (canais) => {
  await salvarConfiguracao("pagamentoCanais", canais);
  estado.canais = { online: canais.online || null, maquininha: canais.maquininha || null };
};

export const salvarMaquininhas = async (lista) => {
  await salvarConfiguracao("pagamentoMaquininhas", lista);
  estado.maquininhas = lista;
};

export const novoIdMaquininha = () => crypto.randomUUID();

// Endereços públicos usados nos retornos dos bancos.
export const urlBackend = () => String(process.env.BACKEND_URL || "https://girakidsbackend.onrender.com").replace(/\/+$/, "");
export const urlFrontend = () =>
  String(process.env.FRONTEND_URL || "https://girakidsfrontend.vercel.app")
    .split(",")[0]
    .trim()
    .replace(/\/+$/, "");
