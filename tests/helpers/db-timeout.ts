/**
 * Orçamento de tempo dos testes de `closing` contra Postgres real.
 *
 * O trabalho é real — banco, timers falsos e cascata de providers — e um runner
 * de 2 núcleos, rodando a suíte SEQUENCIAL sob cobertura, leva várias vezes o
 * tempo local. Um teto escrito olhando a máquina rápida reprova por lentidão,
 * não por travamento.
 *
 * O número existe UMA vez e é o default do projeto `db` no `vitest.config.ts`:
 * nenhum arquivo passa teto próprio, e cópias locais divergiriam do valor.
 *
 * 60s é ~4,7x o tempo local dos sete casos de `closing` somados, a folga que
 * separa "esta máquina é lenta" de "isto travou". Um caso que realmente
 * pendurar continua reprovando.
 */
export const DB_TEST_TIMEOUT = 60_000;
