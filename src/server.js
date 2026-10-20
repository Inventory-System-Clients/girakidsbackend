import dotenv from "dotenv";

dotenv.config();
// Datas e filtros por dia sempre no horário de Brasília.
process.env.TZ = process.env.TZ || "America/Sao_Paulo";

const { default: express } = await import("express");
const { default: cors } = await import("cors");
const { default: helmet } = await import("helmet");
const { default: morgan } = await import("morgan");
const { sequelize } = await import("./database/connection.js");
const { sincronizarBanco } = await import("./database/migrate.js");
const { default: routes } = await import("./routes/index.js");

const app = express();
const PORT = process.env.PORT || 3001;

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:4173",
  ...String(process.env.FRONTEND_URL || "").split(",").map((o) => o.trim()),
].filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
        return callback(null, true);
      }
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);

// rawBody fica disponível para validar assinatura de webhooks de pagamento.
app.use(
  express.json({
    limit: "10mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== "test") app.use(morgan("dev"));

app.use("/api", routes);

app.use((req, res) => res.status(404).json({ error: "Rota não encontrada" }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Erro interno" });
});

try {
  await sequelize.authenticate();
  await sincronizarBanco();
  app.listen(PORT, () => console.log(`🎡 Gira Kids backend rodando na porta ${PORT}`));
} catch (error) {
  console.error("Não foi possível iniciar o servidor:", error);
  process.exit(1);
}
