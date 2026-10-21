import Usuario from "./Usuario.js";
import Categoria from "./Categoria.js";
import Produto from "./Produto.js";
import HistoricoPreco from "./HistoricoPreco.js";
import MovimentacaoEstoque from "./MovimentacaoEstoque.js";
import Parceiro from "./Parceiro.js";
import { Recebimento, RecebimentoItem } from "./Recebimento.js";
import { Pedido, PedidoItem, PedidoParcela } from "./Pedido.js";
import { Configuracao, AlertaPagamento } from "./Configuracao.js";
import CorreiosPostagem from "./CorreiosPostagem.js";
import PedidoNotaFiscal from "./PedidoNotaFiscal.js";
import LogAtividade from "./LogAtividade.js";
import Arquivo from "./Arquivo.js";
import Banner from "./Banner.js";
import PedidoCustoExtra from "./PedidoCustoExtra.js";
import { PreRecebimento, PreRecebimentoItem, OrdemMontagem } from "./PreRecebimento.js";

Produto.belongsTo(Parceiro, {
  foreignKey: "fornecedorPreferencialId",
  as: "fornecedorPreferencial",
  constraints: false,
});
Produto.hasMany(HistoricoPreco, { foreignKey: "produtoId", as: "historicoPrecos" });
HistoricoPreco.belongsTo(Produto, { foreignKey: "produtoId", as: "produto" });

Pedido.hasMany(PedidoItem, { foreignKey: "pedidoId", as: "itens", onDelete: "CASCADE" });
PedidoItem.belongsTo(Pedido, { foreignKey: "pedidoId", as: "pedido" });
Pedido.hasMany(PedidoParcela, { foreignKey: "pedidoId", as: "parcelas", onDelete: "CASCADE" });
PedidoParcela.belongsTo(Pedido, { foreignKey: "pedidoId", as: "pedido" });
PedidoItem.belongsTo(Produto, { foreignKey: "produtoId", as: "produto", constraints: false });
Pedido.belongsTo(Usuario, { foreignKey: "clienteId", as: "cliente", constraints: false });
Pedido.hasMany(PedidoCustoExtra, { foreignKey: "pedidoId", as: "custosExtras", onDelete: "CASCADE" });
PedidoCustoExtra.belongsTo(Pedido, { foreignKey: "pedidoId", as: "pedido" });
Pedido.belongsTo(Parceiro, { foreignKey: "transportadoraId", as: "transportadora", constraints: false });

Recebimento.hasMany(RecebimentoItem, { foreignKey: "recebimentoId", as: "itens", onDelete: "CASCADE" });
RecebimentoItem.belongsTo(Recebimento, { foreignKey: "recebimentoId", as: "recebimento" });
Recebimento.belongsTo(Parceiro, { foreignKey: "fornecedorId", as: "fornecedor" });
RecebimentoItem.belongsTo(Produto, { foreignKey: "produtoId", as: "produto", constraints: false });

PreRecebimento.hasMany(PreRecebimentoItem, { foreignKey: "preRecebimentoId", as: "itens", onDelete: "CASCADE" });
PreRecebimentoItem.belongsTo(PreRecebimento, { foreignKey: "preRecebimentoId", as: "preRecebimento" });
PreRecebimento.belongsTo(Parceiro, { foreignKey: "fornecedorId", as: "fornecedor", constraints: false });
OrdemMontagem.belongsTo(Produto, { foreignKey: "produtoId", as: "produto", constraints: false });

CorreiosPostagem.belongsTo(Usuario, { foreignKey: "usuarioId", as: "usuario", constraints: false });
PedidoNotaFiscal.belongsTo(Usuario, { foreignKey: "usuarioId", as: "usuario", constraints: false });
LogAtividade.belongsTo(Usuario, { foreignKey: "usuarioId", as: "usuario", constraints: false });

export {
  Usuario,
  Categoria,
  Produto,
  HistoricoPreco,
  MovimentacaoEstoque,
  Parceiro,
  Recebimento,
  RecebimentoItem,
  Pedido,
  PedidoItem,
  PedidoParcela,
  Configuracao,
  AlertaPagamento,
  CorreiosPostagem,
  PedidoNotaFiscal,
  LogAtividade,
  Arquivo,
  Banner,
  PedidoCustoExtra,
  PreRecebimento,
  PreRecebimentoItem,
  OrdemMontagem,
};
