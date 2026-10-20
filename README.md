# Gira Kids — Backend

API do catálogo e da gestão Gira Kids: catálogo público, checkout, pedidos e orçamentos, Time Financeiro (dashboard, metas, recebimentos e parcelas), Time de Vendas, Time Expedição (checklist e expedição), produtos e estoque, entradas de fornecedores, usuários com permissões por tela e a aba **Comercial** herdada do AgarraMais (Transportadoras com IA, Calculadora de Pedidos, Pedidos e Notas Fiscais via NFeMail e postagens nos Correios via VIPP), agora consultando os pedidos do próprio banco.

Stack: Node.js 20+, Express, Sequelize, PostgreSQL.

## Rodando localmente

```bash
cp .env.example .env      # ajuste banco, JWT_SECRET e ADMIN_EMAIL/ADMIN_PASSWORD
npm install
npm run dev               # cria/ajusta as tabelas e o admin inicial ao subir
```

A API fica em `http://localhost:3001/api` (`GET /api/health`).

## Importar os dados da loja antiga

Com os JSON exportados da loja anterior (products, users, suppliers, carriers, orders, quotes, stock_movements):

```bash
npm run import:legado -- /caminho/da/exportacao
```

Pode rodar de novo com uma exportação mais nova: registros já importados são ignorados. Senhas não são exportáveis — os usuários importados precisam de uma nova senha (Gerenciar Usuários → Resetar Senha, ou `LEGADO_SENHA_PADRAO`). Pedidos antigos com código não numérico (ex.: `GK-110326-006`) mantêm o código original na tela e na busca.

## Pagamentos online (banco de sua escolha)

A camada fica em `src/services/pagamentos/`. Para conectar um banco/gateway:

1. Copie `modelo.js` para `<banco>.js` e implemente `criarCobranca`, `consultarCobranca` e `interpretarWebhook`.
2. Registre o provedor em `src/services/pagamentos/index.js`.
3. Defina `PAGAMENTO_PROVEDOR=<banco>` e as credenciais no `.env`.
4. Aponte o webhook do banco para `POST /api/pagamentos/webhook/<banco>`.

Sem provedor, PIX online e cartão online ficam desabilitados no checkout e o Time Financeiro confirma os pagamentos manualmente. Pagamentos com valor divergente ou sem pedido viram **Alertas de pagamento** no Time de Vendas.

## Frete

Retirar no local e Transportadora sempre disponíveis. PAC/SEDEX usam a cotação do VIPP quando `VIPP_USUARIO`/`VIPP_SENHA` estão configurados (caixa calculada pela mesma regra da Calculadora de Pedidos); sem VIPP, usam uma estimativa por peso e região configurável (`configuracoes.freteEstimado`).

## Estrutura

```
src/
  controllers/   regras de cada tela (pedidos, expedição, produtos, entradas, usuários, dashboard, comercial)
  models/        Sequelize (Pedido, PedidoItem, PedidoParcela, Produto, Parceiro, Recebimento, ...)
  services/      estoque, pedidos, frete, pagamentos, VIPP, NFeMail, calculadora de caixas
  database/      conexão, sincronização e importação da loja antiga
  routes/        rotas (permissões por tela: FINANCEIRO, VENDAS, EXPEDICAO, PRODUTOS, ENTRADAS, ORCAMENTOS, USUARIOS, CHECKOUT, COMERCIAL)
```
