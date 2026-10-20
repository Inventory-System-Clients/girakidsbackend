import { Pedido, PedidoItem, Produto } from "../models/index.js";
import { CAMPO_CALCULADORA_POR_EMBALAGEM } from "../services/freteService.js";
import { responderErro, erroHttp, dataISO } from "../utils/helpers.js";

// Dados de um pedido da própria loja para as ferramentas do Comercial:
// Calculadora de Pedidos (quantidades por tipo de embalagem), Pedidos e Notas
// Fiscais (cliente/número/data/valor) e Busca de Transportadoras (destino e
// peso) — antes isso era digitado à mão a partir da loja antiga.
export const dadosDoPedido = async (req, res) => {
  try {
    const numero = Number(String(req.params.numero || "").replace(/\D/g, ""));
    if (!numero) throw erroHttp(400, "Informe o número do pedido.");
    const pedido = await Pedido.findOne({
      where: { tipo: "PEDIDO", numero },
      include: [{ model: PedidoItem, as: "itens", include: [{ model: Produto, as: "produto" }] }],
    });
    if (!pedido) throw erroHttp(404, "Pedido não encontrado.");

    const quantidades = {};
    const produtosPersonalizados = [];
    for (const item of pedido.itens) {
      const unidades = item.quantidade * item.unidadesPacote;
      const campo = CAMPO_CALCULADORA_POR_EMBALAGEM[item.produto?.tipoEmbalagem];
      if (campo) {
        quantidades[campo] = (quantidades[campo] || 0) + unidades;
      } else {
        produtosPersonalizados.push({
          nome: item.nome,
          quantidade: unidades,
          pesoUnitario:
            item.produto?.pesoPacoteGramas && item.unidadesPacote
              ? item.produto.pesoPacoteGramas / 1000 / item.unidadesPacote
              : null,
        });
      }
    }

    res.json({
      id: pedido.id,
      numero: pedido.numero,
      clienteNome: pedido.clienteNome,
      dataPedido: dataISO(pedido.createdAt),
      valor: Number(pedido.total),
      notaFiscalNumero: pedido.notaFiscalNumero,
      transportadoraNome: pedido.transportadoraNome,
      cidade: pedido.cidade,
      estado: pedido.estado,
      cep: pedido.cep,
      pesoKg: Number(pedido.pesoTotalGramas || 0) / 1000,
      metodoEnvio: pedido.metodoEnvio,
      quantidades,
      produtosPersonalizados,
    });
  } catch (error) {
    responderErro(res, error, "Erro ao carregar pedido");
  }
};
