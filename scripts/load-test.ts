import { v7 as uuidv7 } from "uuid";

interface RequestMetric {
  latencyMs: number;
  statusCode: number;
  success: boolean;
}

async function runLoadTest() {
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";
  console.log("==========================================================");
  console.log("🚀 DISTRIBUTED WAGERING PROCESSOR — BENCHMARK & LOAD TEST");
  console.log("==========================================================");
  console.log(`Alvo: ${baseUrl}`);
  console.log("Ambiente: Bun 1.x runtime nativo");
  console.log("Metodologia: Disparo massivo com pooling de requisições concorrentes\n");

  // 1. Criar Wallet
  const playerId = uuidv7();
  console.log(`1. Criando wallet de teste para player ${playerId}...`);

  let walletId = "";
  try {
    const res = await fetch(`${baseUrl}/wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "10000.00", currency: "BRL" },
      }),
    });

    if (!res.ok) {
      throw new Error(`Falha ao criar wallet: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    walletId = data.id;
    console.log(`   Wallet criada com sucesso! ID: ${walletId}, Saldo: ${data.balance.amount} BRL\n`);
  } catch (err) {
    console.error(`❌ Erro inicial: ${(err as Error).message}`);
    console.log("⚠️ Verifique se a aplicação está em execução (bun run start ou docker compose up)");
    process.exit(1);
  }

  // 2. Parâmetros de Carga
  const totalRequests = 200;
  const concurrency = 20;
  const metrics: RequestMetric[] = [];

  console.log(`2. Executando ${totalRequests} requisições de apostas (concorrência: ${concurrency})...`);
  const startTime = Date.now();

  const chunks = Math.ceil(totalRequests / concurrency);

  for (let c = 0; c < chunks; c++) {
    const batchPromises = Array.from({ length: concurrency }).map(async (_, idx) => {
      const extTxId = `load-tx-${c * concurrency + idx}-${uuidv7()}`;
      const idempotencyKey = `provider-load:${extTxId}`;
      const startReq = performance.now();

      try {
        const response = await fetch(`${baseUrl}/wagering/transactions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            providerId: "provider-load",
            externalTransactionId: extTxId,
            playerId,
            walletId,
            roundId: `round-${c}`,
            gameId: "speed-tiger",
            kind: "BET",
            money: { amount: "10.00", currency: "BRL" },
          }),
        });

        const latencyMs = performance.now() - startReq;
        metrics.push({
          latencyMs,
          statusCode: response.status,
          success: response.ok,
        });
      } catch (e) {
        const latencyMs = performance.now() - startReq;
        metrics.push({
          latencyMs,
          statusCode: 0,
          success: false,
        });
      }
    });

    await Promise.all(batchPromises);
    process.stdout.write(`   Progresso: ${Math.min((c + 1) * concurrency, totalRequests)}/${totalRequests} requisições...\r`);
  }

  const totalTimeSeconds = (Date.now() - startTime) / 1000;
  console.log(`\n\n3. Coleta e Análise Estatística dos Resultados:`);

  // Cálculos Estatísticos
  const latencies = metrics.map((m) => m.latencyMs).sort((a, b) => a - b);
  const successfulReqs = metrics.filter((m) => m.success).length;
  const failedReqs = metrics.length - successfulReqs;
  const throughput = (metrics.length / totalTimeSeconds).toFixed(2);

  const p50 = latencies[Math.floor(latencies.length * 0.5)]?.toFixed(2) ?? "0";
  const p95 = latencies[Math.floor(latencies.length * 0.95)]?.toFixed(2) ?? "0";
  const p99 = latencies[Math.floor(latencies.length * 0.99)]?.toFixed(2) ?? "0";
  const avgLatency = (latencies.reduce((acc, curr) => acc + curr, 0) / latencies.length).toFixed(2);

  console.log("----------------------------------------------------------");
  console.log(`Throughput Geral:       ${throughput} req/s`);
  console.log(`Total de Requisições:   ${metrics.length}`);
  console.log(`Sucessos (200 OK):      ${successfulReqs}`);
  console.log(`Falhas / Rejeições:     ${failedReqs}`);
  console.log(`Taxa de Erro:           ${((failedReqs / metrics.length) * 100).toFixed(2)}%`);
  console.log("----------------------------------------------------------");
  console.log(`Latência Média:         ${avgLatency} ms`);
  console.log(`Latência p50:           ${p50} ms`);
  console.log(`Latência p95:           ${p95} ms`);
  console.log(`Latência p99:           ${p99} ms`);
  console.log("----------------------------------------------------------");

  // 4. Reconciliação Final de Integridade
  console.log("\n4. Reconciliando integridade contábil da Wallet...");
  const recRes = await fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, {
    method: "POST",
  });
  const recData = (await recRes.json()) as any;
  console.log(`   Saldo em Banco:      ${recData.storedBalance.amount} ${recData.storedBalance.currency}`);
  console.log(`   Saldo Calculado:     ${recData.calculatedBalance.amount} ${recData.calculatedBalance.currency}`);
  console.log(`   Diferença:           ${recData.difference.amount} ${recData.difference.currency}`);
  console.log(`   Lançamentos Ledger:  ${recData.checkedEntries}`);
  console.log(`   Status Consistente:  ${recData.consistent ? "✅ 100% CONSISTENTE" : "❌ DIVERGÊNCIA"}`);
  console.log("==========================================================\n");
}

runLoadTest().catch(console.error);
